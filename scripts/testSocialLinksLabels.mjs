// Functional verification for the platform-name-label follow-up to the
// social links feature (settled July 28, 2026, follow-up to commit
// 320e559). Real HTTP login, real updatePlayer/createEvent mutations, and a
// real fetch of the actual rendered player/Event page HTML -- not a mock.
// Confirms the visible label text (not just the title attribute) now
// renders alongside each platform's icon, on both entity types, plus that
// the generic "other" link's label behavior is unchanged.
//
// Requires `npm run dev` already running on localhost:3000.
// Run: npx tsx scripts/testSocialLinksLabels.mjs

import fs from "fs";
import path from "path";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnvLocal();
if (!process.env.MONGODB_URI) throw new Error("Missing MONGODB_URI (checked .env.local)");

const { connectToDatabase } = await import("../lib/db");
const { User } = await import("../models/User");
const { Player } = await import("../models/Player");
const { Event } = await import("../models/Event");
const bcrypt = (await import("bcryptjs")).default;

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  OK   ${label}`);
  } else {
    console.log(`  FAIL ${label}`);
    failures++;
  }
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }
  applySetCookies(headers) {
    for (const raw of headers ?? []) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function httpLogin(email, password, syntheticIp) {
  const jar = new CookieJar();
  const ipHeaders = { "x-forwarded-for": syntheticIp };
  const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`, { headers: ipHeaders });
  jar.applySetCookies(csrfRes.headers.getSetCookie?.());
  const { csrfToken } = await csrfRes.json();
  const loginRes = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.header(), ...ipHeaders },
    body: new URLSearchParams({ email, password, csrfToken, json: "true" }),
  });
  jar.applySetCookies(loginRes.headers.getSetCookie?.());
  return jar;
}

async function gql(query, variables, cookieJar) {
  const res = await fetch(`${BASE_URL}/api/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookieJar ? { Cookie: cookieJar.header() } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

// Finds the visible text of an <a> element by its href, ignoring the
// title/aria-label attributes -- i.e. does the rendered inner content
// (icon + label) actually contain the platform name, not just the tooltip.
function anchorInnerTextForHref(html, href) {
  const idx = html.indexOf(`href="${href}"`);
  if (idx === -1) return null;
  const tagEnd = html.indexOf(">", idx);
  const closeStart = html.indexOf("</a>", tagEnd);
  if (tagEnd === -1 || closeStart === -1) return null;
  return html.slice(tagEnd + 1, closeStart);
}

async function main() {
  await connectToDatabase();

  const email = "sociallinkslabelstest@example.com";
  const password = "TestPass123!";
  await User.deleteOne({ email });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ email, passwordHash });
  const player = await Player.create({ userId: user._id, tag: "SocialLabelsTester" });
  await User.findByIdAndUpdate(user._id, { playerId: player._id });

  const eventIds = [];

  try {
    const jar = await httpLogin(email, password, "10.94.0.1");

    const discordUrl = "https://discord.gg/labeltest";
    const tiktokUrl = "https://tiktok.com/@labeltest";
    const otherLinkUrl = "https://example.com/labeltest";
    const otherLinkLabel = "My Cool Site";

    // === PLAYER ===
    console.log("\n=== PLAYER: platform name renders as visible text next to the icon ===");
    const updateRes = await gql(
      `mutation($id: ID!, $discordUrl: String, $tiktokUrl: String, $otherLinkUrl: String, $otherLinkLabel: String) {
        updatePlayer(id: $id, discordUrl: $discordUrl, tiktokUrl: $tiktokUrl, otherLinkUrl: $otherLinkUrl, otherLinkLabel: $otherLinkLabel) { id }
      }`,
      { id: player._id.toString(), discordUrl, tiktokUrl, otherLinkUrl, otherLinkLabel },
      jar
    );
    assert(!updateRes.errors, `updatePlayer succeeded (${JSON.stringify(updateRes.errors)})`);

    const playerRes = await fetch(`${BASE_URL}/players/${player._id.toString()}`, { cache: "no-store" });
    const playerHtml = await playerRes.text();
    assert(playerRes.status === 200, `Player page rendered (status ${playerRes.status})`);

    const discordInner = anchorInnerTextForHref(playerHtml, discordUrl);
    assert(!!discordInner, "Found the Discord <a> element by its href");
    assert(discordInner?.includes("💬") && discordInner?.includes("Discord"), `Discord link's VISIBLE content includes both the icon and the "Discord" label (got: ${discordInner})`);

    const tiktokInner = anchorInnerTextForHref(playerHtml, tiktokUrl);
    assert(tiktokInner?.includes("🎵") && tiktokInner?.includes("TikTok"), `TikTok link's VISIBLE content includes both the icon and the "TikTok" label (got: ${tiktokInner})`);

    const otherInner = anchorInnerTextForHref(playerHtml, otherLinkUrl);
    assert(otherInner?.includes("🔗") && otherInner?.includes(otherLinkLabel), `Generic "other" link's VISIBLE content still includes the user-typed label (got: ${otherInner})`);

    // === EVENT ===
    console.log("\n=== EVENT: platform name renders as visible text next to the icon ===");
    const createRes = await gql(
      `mutation($name: String!, $discordUrl: String, $tiktokUrl: String, $otherLinkUrl: String, $otherLinkLabel: String) {
        createEvent(name: $name, discordUrl: $discordUrl, tiktokUrl: $tiktokUrl, otherLinkUrl: $otherLinkUrl, otherLinkLabel: $otherLinkLabel) { id }
      }`,
      { name: "Social Label Test Event", discordUrl, tiktokUrl, otherLinkUrl, otherLinkLabel },
      jar
    );
    assert(!createRes.errors, `createEvent succeeded (${JSON.stringify(createRes.errors)})`);
    const eventId = createRes.data.createEvent.id;
    eventIds.push(eventId);

    // Creator can view their own PENDING event directly.
    const eventRes = await fetch(`${BASE_URL}/events/${eventId}`, { headers: { Cookie: jar.header() }, cache: "no-store" });
    const eventHtml = await eventRes.text();
    assert(eventRes.status === 200, `Event page rendered (status ${eventRes.status})`);

    const eventDiscordInner = anchorInnerTextForHref(eventHtml, discordUrl);
    assert(eventDiscordInner?.includes("💬") && eventDiscordInner?.includes("Discord"), `Event's Discord link's VISIBLE content includes both the icon and the "Discord" label (got: ${eventDiscordInner})`);

    const eventTiktokInner = anchorInnerTextForHref(eventHtml, tiktokUrl);
    assert(eventTiktokInner?.includes("🎵") && eventTiktokInner?.includes("TikTok"), `Event's TikTok link's VISIBLE content includes both the icon and the "TikTok" label (got: ${eventTiktokInner})`);

    console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURE(S)`}`);
  } finally {
    console.log("\nCleaning up test data...");
    for (const id of eventIds) await Event.findByIdAndDelete(id);
    await Player.findByIdAndDelete(player._id);
    await User.findByIdAndDelete(user._id);
    console.log("Cleanup done.");
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
