// Functional verification for social media link fields on Players and
// Events (settled July 28, 2026). Real HTTP login, real updatePlayer/
// createEvent/updateEvent mutations, and a real fetch of the actual
// rendered player/Event page HTML -- not a mock. Confirms:
//   1. Setting all 5 fixed platform links + the generic "other" slot on a
//      Player round-trips through updatePlayer and renders 6 real <a>
//      elements with the correct hrefs/titles on the real profile page.
//   2. Clearing one specific platform link (leaving the rest set) makes
//      only that one disappear from the rendered row -- not an empty icon
//      placeholder, and not affecting the others.
//   3. A Player with NO social links at all renders no icon row whatsoever.
//   4. The same three checks, repeated for an Event (via createEvent +
//      updateEvent instead of updatePlayer).
//
// Requires `npm run dev` already running on localhost:3000.
// Run: npx tsx scripts/testSocialLinks.mjs

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

const SAMPLE_LINKS = {
  twitterUrl: "https://twitter.com/testhandle",
  instagramUrl: "https://instagram.com/testhandle",
  youtubeUrl: "https://youtube.com/@testhandle",
  discordUrl: "https://discord.gg/testinvite",
  tiktokUrl: "https://tiktok.com/@testhandle",
  otherLinkUrl: "https://example.com/mystuff",
  otherLinkLabel: "My Linktree",
};

function assertAllLinksRendered(html, context) {
  assert(html.includes(`href="${SAMPLE_LINKS.twitterUrl}"`) && html.includes('title="X / Twitter"'), `${context}: X/Twitter icon link renders with correct href + title`);
  assert(html.includes(`href="${SAMPLE_LINKS.instagramUrl}"`) && html.includes('title="Instagram"'), `${context}: Instagram icon link renders`);
  assert(html.includes(`href="${SAMPLE_LINKS.youtubeUrl}"`) && html.includes('title="YouTube"'), `${context}: YouTube icon link renders`);
  assert(html.includes(`href="${SAMPLE_LINKS.discordUrl}"`) && html.includes('title="Discord"'), `${context}: Discord icon link renders`);
  assert(html.includes(`href="${SAMPLE_LINKS.tiktokUrl}"`) && html.includes('title="TikTok"'), `${context}: TikTok icon link renders`);
  assert(html.includes(`href="${SAMPLE_LINKS.otherLinkUrl}"`) && html.includes(SAMPLE_LINKS.otherLinkLabel), `${context}: generic "other" link renders with its custom label as link text`);
  assert(
    (html.match(/target="_blank"[^>]*rel="noopener noreferrer"/g) || []).length >= 6 ||
      (html.match(/rel="noopener noreferrer"/g) || []).length >= 6,
    `${context}: social links open in a new tab with rel="noopener noreferrer"`
  );
}

async function main() {
  await connectToDatabase();

  // ============ PLAYER ============
  console.log("\n=== PLAYER: set all 6 links, round-trip through updatePlayer, render correctly ===");
  const email = "sociallinkstest@example.com";
  const password = "TestPass123!";
  await User.deleteOne({ email });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ email, passwordHash });
  const player = await Player.create({ userId: user._id, tag: "SocialLinksTester" });
  await User.findByIdAndUpdate(user._id, { playerId: player._id });

  let createdEventIds = [];

  try {
    const jar = await httpLogin(email, password, "10.95.0.1");

    const updateRes = await gql(
      `mutation($id: ID!, $twitterUrl: String, $instagramUrl: String, $youtubeUrl: String, $discordUrl: String, $tiktokUrl: String, $otherLinkUrl: String, $otherLinkLabel: String) {
        updatePlayer(id: $id, twitterUrl: $twitterUrl, instagramUrl: $instagramUrl, youtubeUrl: $youtubeUrl, discordUrl: $discordUrl, tiktokUrl: $tiktokUrl, otherLinkUrl: $otherLinkUrl, otherLinkLabel: $otherLinkLabel) {
          id twitterUrl instagramUrl youtubeUrl discordUrl tiktokUrl otherLinkUrl otherLinkLabel
        }
      }`,
      { id: player._id.toString(), ...SAMPLE_LINKS },
      jar
    );
    assert(!updateRes.errors, `updatePlayer with all 6 social links succeeded (${JSON.stringify(updateRes.errors)})`);
    const returned = updateRes.data?.updatePlayer;
    assert(
      returned?.twitterUrl === SAMPLE_LINKS.twitterUrl && returned?.otherLinkLabel === SAMPLE_LINKS.otherLinkLabel,
      "Mutation response reflects the saved values immediately"
    );

    const dbPlayer = await Player.findById(player._id);
    assert(dbPlayer.discordUrl === SAMPLE_LINKS.discordUrl && dbPlayer.otherLinkUrl === SAMPLE_LINKS.otherLinkUrl, "Values stored verbatim in the DB");

    const pageRes1 = await fetch(`${BASE_URL}/players/${player._id.toString()}`, { cache: "no-store" });
    const html1 = await pageRes1.text();
    assert(pageRes1.status === 200, `Player page rendered (status ${pageRes1.status})`);
    assertAllLinksRendered(html1, "Player");

    // === Clear ONE platform link only -- confirm only that one disappears ===
    console.log("\n=== PLAYER: clearing just Discord leaves the others intact ===");
    const clearRes = await gql(`mutation($id: ID!, $discordUrl: String) { updatePlayer(id: $id, discordUrl: $discordUrl) { id } }`, { id: player._id.toString(), discordUrl: "" }, jar);
    assert(!clearRes.errors, `updatePlayer clearing discordUrl succeeded (${JSON.stringify(clearRes.errors)})`);

    const pageRes2 = await fetch(`${BASE_URL}/players/${player._id.toString()}`, { cache: "no-store" });
    const html2 = await pageRes2.text();
    assert(!html2.includes('title="Discord"'), "Discord icon link is GONE after clearing it");
    assert(html2.includes(`href="${SAMPLE_LINKS.twitterUrl}"`), "X/Twitter icon link still renders (unaffected by clearing Discord)");
    assert(html2.includes(SAMPLE_LINKS.otherLinkLabel), "Generic 'other' link still renders (unaffected by clearing Discord)");

    // === No social links at all -- no icon row whatsoever ===
    console.log("\n=== PLAYER: no social links set at all -- nothing renders ===");
    const email2 = "sociallinksempty@example.com";
    await User.deleteOne({ email: email2 });
    const user2 = await User.create({ email: email2, passwordHash });
    const player2 = await Player.create({ userId: user2._id, tag: "SocialLinksEmpty" });
    await User.findByIdAndUpdate(user2._id, { playerId: player2._id });

    const pageRes3 = await fetch(`${BASE_URL}/players/${player2._id.toString()}`, { cache: "no-store" });
    const html3 = await pageRes3.text();
    assert(pageRes3.status === 200, `Player page (no social links) rendered (status ${pageRes3.status})`);
    assert(
      !html3.includes('title="X / Twitter"') && !html3.includes('title="Instagram"') && !html3.includes('title="YouTube"') && !html3.includes('title="Discord"') && !html3.includes('title="TikTok"'),
      "No platform icon links render at all when nothing is set"
    );

    await Player.findByIdAndDelete(player2._id);
    await User.findByIdAndDelete(user2._id);

    // ============ EVENT ============
    console.log("\n=== EVENT: set all 6 links via createEvent, round-trip, render correctly ===");
    const createRes = await gql(
      `mutation($name: String!, $twitterUrl: String, $instagramUrl: String, $youtubeUrl: String, $discordUrl: String, $tiktokUrl: String, $otherLinkUrl: String, $otherLinkLabel: String) {
        createEvent(name: $name, twitterUrl: $twitterUrl, instagramUrl: $instagramUrl, youtubeUrl: $youtubeUrl, discordUrl: $discordUrl, tiktokUrl: $tiktokUrl, otherLinkUrl: $otherLinkUrl, otherLinkLabel: $otherLinkLabel) {
          id
        }
      }`,
      { name: "Social Links Test Event", ...SAMPLE_LINKS },
      jar
    );
    assert(!createRes.errors, `createEvent with all 6 social links succeeded (${JSON.stringify(createRes.errors)})`);
    const eventId = createRes.data.createEvent.id;
    createdEventIds.push(eventId);

    const dbEvent = await Event.findById(eventId);
    assert(dbEvent.youtubeUrl === SAMPLE_LINKS.youtubeUrl && dbEvent.otherLinkLabel === SAMPLE_LINKS.otherLinkLabel, "Values stored verbatim in the DB");

    // Creator can view their own PENDING event directly.
    const eventPageRes1 = await fetch(`${BASE_URL}/events/${eventId}`, { headers: { Cookie: jar.header() }, cache: "no-store" });
    const eventHtml1 = await eventPageRes1.text();
    assert(eventPageRes1.status === 200, `Event page rendered (status ${eventPageRes1.status})`);
    assertAllLinksRendered(eventHtml1, "Event");

    // === Edit via updateEvent -- clear TikTok only ===
    console.log("\n=== EVENT: clearing just TikTok via updateEvent leaves the others intact ===");
    const eventClearRes = await gql(`mutation($id: ID!, $tiktokUrl: String) { updateEvent(id: $id, tiktokUrl: $tiktokUrl) { id } }`, { id: eventId, tiktokUrl: "" }, jar);
    assert(!eventClearRes.errors, `updateEvent clearing tiktokUrl succeeded (${JSON.stringify(eventClearRes.errors)})`);

    const eventPageRes2 = await fetch(`${BASE_URL}/events/${eventId}`, { headers: { Cookie: jar.header() }, cache: "no-store" });
    const eventHtml2 = await eventPageRes2.text();
    assert(!eventHtml2.includes('title="TikTok"'), "TikTok icon link is GONE after clearing it");
    assert(eventHtml2.includes(`href="${SAMPLE_LINKS.instagramUrl}"`), "Instagram icon link still renders (unaffected by clearing TikTok)");

    // === No social links on an Event -- no icon row ===
    console.log("\n=== EVENT: no social links set at all -- nothing renders ===");
    const createNoLinksRes = await gql(`mutation($name: String!) { createEvent(name: $name) { id } }`, { name: "No Social Links Test Event" }, jar);
    assert(!createNoLinksRes.errors, `createEvent with no social links succeeded (${JSON.stringify(createNoLinksRes.errors)})`);
    const noLinksEventId = createNoLinksRes.data.createEvent.id;
    createdEventIds.push(noLinksEventId);

    const eventPageRes3 = await fetch(`${BASE_URL}/events/${noLinksEventId}`, { headers: { Cookie: jar.header() }, cache: "no-store" });
    const eventHtml3 = await eventPageRes3.text();
    assert(
      !eventHtml3.includes('title="X / Twitter"') && !eventHtml3.includes('title="Instagram"') && !eventHtml3.includes('title="YouTube"') && !eventHtml3.includes('title="Discord"') && !eventHtml3.includes('title="TikTok"'),
      "No platform icon links render at all when nothing is set on an Event"
    );

    console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURE(S)`}`);
  } finally {
    console.log("\nCleaning up test data...");
    for (const id of createdEventIds) {
      await Event.findByIdAndDelete(id);
    }
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
