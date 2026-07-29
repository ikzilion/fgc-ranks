// lib/twitch.ts
// Twitch Helix API client for live-status checks — shared by both the
// players list/profile and the Events list/detail page (same batched
// Get Streams call, same short cache, keyed by lowercased Twitch username
// regardless of whether it came from a Player.twitchUrl or an
// Event.twitchUrl; a stream is live or it isn't, independent of which
// entity linked it).
//
// Requires TWITCH_CLIENT_ID + TWITCH_CLIENT_SECRET (server-side only, never
// exposed to the client) — a Twitch Developer app's Client ID/Secret,
// registered at https://dev.twitch.tv/console/apps. Uses the
// client_credentials grant for a long-lived app access token (~60 days per
// Twitch's docs), cached in memory and only refetched when missing/expired
// or after a 401 from Get Streams.
//
// In-memory caching only (module-level Map/variable) — correct within one
// warm serverless instance (Vercel Fluid Compute reuses instances across
// concurrent requests, so this covers the common "repeated page loads hit
// the same warm instance" case), not a durable cross-instance cache. That's
// an acceptable tradeoff here: Get Streams' rate limit (~800 req/min) isn't
// a real constraint even if a cold instance occasionally re-fetches, and a
// shared cache (e.g. Upstash Redis, already used elsewhere for rate
// limiting) is unwarranted complexity for a 30-60s staleness window that's
// already just cosmetic — a live indicator, not anything correctness-critical.
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const STREAMS_URL = "https://api.twitch.tv/helix/streams";
const LIVE_STATUS_TTL_MS = 45_000;
const MAX_USERNAMES_PER_CALL = 100;

let cachedToken: { accessToken: string; expiresAt: number } | null = null;
// Dedupes concurrent callers that all miss the cache at once (e.g. a burst
// of requests right after a cold start, before the first fetch has resolved
// and populated cachedToken) into the SAME in-flight request, instead of
// each firing its own — confirmed via a real concurrency test that without
// this, N simultaneous misses produced N separate token fetches.
let pendingTokenFetch: Promise<string | null> | null = null;

const liveStatusCache = new Map<string, { isLive: boolean; fetchedAt: number }>();

async function getAppAccessToken(forceRefresh = false): Promise<string | null> {
  if (!forceRefresh && cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.accessToken;
  }

  if (!forceRefresh && pendingTokenFetch) {
    return pendingTokenFetch;
  }

  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  pendingTokenFetch = (async () => {
    try {
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "client_credentials",
        }),
      });
      if (!res.ok) return null;
      const json = await res.json();
      // expires_in is in seconds — refresh 5 minutes early to avoid an
      // edge-of-expiry request landing right as the token goes stale.
      cachedToken = { accessToken: json.access_token, expiresAt: Date.now() + (json.expires_in - 300) * 1000 };
      return cachedToken.accessToken;
    } catch {
      return null;
    } finally {
      pendingTokenFetch = null;
    }
  })();

  return pendingTokenFetch;
}

// Extracts a bare Twitch username from whatever a user typed — a full URL
// ("https://twitch.tv/name", with or without protocol/www), or just the
// username itself. Twitch usernames are alphanumeric + underscore, so a
// trailing slash/query string is stripped rather than strictly validated —
// Get Streams simply returns no match for anything invalid, same outcome as
// a genuinely offline channel, no special-case error needed.
export function extractTwitchUsername(input?: string | null): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const withoutProtocol = trimmed.replace(/^https?:\/\//i, "");
  const withoutDomain = withoutProtocol.replace(/^(www\.)?twitch\.tv\//i, "");
  const username = withoutDomain.split(/[/?#]/)[0].trim();
  return username || null;
}

// Batched live-status check — the only way this module hits Get Streams.
// Callers (Player.isLiveOnTwitch / Event.isLiveOnTwitch field resolvers, via
// graphql/loaders.ts's twitchLiveLoader) pass however many usernames
// DataLoader collected into one tick; this function further chunks into Get
// Streams' 100-per-call limit and serves anything still within
// LIVE_STATUS_TTL_MS from the in-memory cache instead of re-fetching it.
export async function getLiveStatuses(usernames: readonly string[]): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  const now = Date.now();
  const toFetch: string[] = [];

  for (const raw of usernames) {
    const username = raw.toLowerCase();
    const cached = liveStatusCache.get(username);
    if (cached && now - cached.fetchedAt < LIVE_STATUS_TTL_MS) {
      result.set(username, cached.isLive);
    } else if (!toFetch.includes(username)) {
      toFetch.push(username);
    }
  }

  if (toFetch.length === 0) return result;

  const token = await getAppAccessToken();
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!token || !clientId) {
    // No credentials configured (or token fetch failed) — fail open to
    // "offline" for everyone rather than throwing, so a missing/invalid
    // Twitch app registration degrades to "no live indicators" instead of
    // breaking the players/Events list entirely.
    for (const username of toFetch) result.set(username, false);
    return result;
  }

  const liveUsernames = new Set<string>();
  for (let i = 0; i < toFetch.length; i += MAX_USERNAMES_PER_CALL) {
    const chunk = toFetch.slice(i, i + MAX_USERNAMES_PER_CALL);
    const found = await fetchStreamsChunk(chunk, token, clientId);
    if (found === null) continue; // chunk fetch failed — leave as offline below, don't crash the caller
    for (const u of found) liveUsernames.add(u);
  }

  for (const username of toFetch) {
    const isLive = liveUsernames.has(username);
    liveStatusCache.set(username, { isLive, fetchedAt: now });
    result.set(username, isLive);
  }

  return result;
}

// Returns the set of usernames Twitch reports as currently live within this
// chunk, or null if the call itself failed (distinct from "none are live",
// which is a real empty Set — that must NOT be treated as a failure by the
// caller). Retries once with a forced token refresh on a 401 — the cached
// app token can go stale between Twitch's own revocation and this module's
// ~60-day expiry assumption.
async function fetchStreamsChunk(usernames: string[], token: string, clientId: string): Promise<string[] | null> {
  const params = new URLSearchParams();
  for (const u of usernames) params.append("user_login", u);
  params.set("first", String(usernames.length));

  const doFetch = (bearer: string) =>
    fetch(`${STREAMS_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${bearer}`, "Client-Id": clientId },
    });

  try {
    let res = await doFetch(token);
    if (res.status === 401) {
      const refreshed = await getAppAccessToken(true);
      if (!refreshed) return null;
      res = await doFetch(refreshed);
    }
    if (!res.ok) return null;

    const json = await res.json();
    return (json.data ?? []).map((s: { user_login: string }) => s.user_login.toLowerCase());
  } catch {
    return null;
  }
}
