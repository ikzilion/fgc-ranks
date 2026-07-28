// Functional verification for per-banner sponsor click-through links: real
// HTTP login, real uploads through /api/upload, a real GraphQL mutation
// setting sponsorBannerUrls as [{url, linkUrl}] objects, and a real fetch of
// the rendered stream page HTML -- not a mock. Confirms:
//   1. The mutation persists each slide's own url + linkUrl correctly
//      (verified via a real GraphQL query, independent of rendering).
//   2. When the linked banner is the active (first/SSR) slide, the stream
//      page wraps its <img> in a real <a href="...linkUrl..."
//      target="_blank" rel="noopener noreferrer">.
//   3. When the UNLINKED banner is the active slide instead (verified by
//      reordering via a second mutation), the stream page renders it with
//      no <a> wrapper at all -- exactly as before this feature existed.
//
// Requires `npm run dev` already running on localhost:3000.
// Run: npx tsx scripts/testSponsorBannerLinks.mjs

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvLocal();
if (!process.env.MONGODB_URI) throw new Error("Missing MONGODB_URI (checked .env.local)");
if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("Missing BLOB_READ_WRITE_TOKEN (checked .env.local)");

const { connectToDatabase } = await import("../lib/db");
const { User } = await import("../models/User");
const { Player } = await import("../models/Player");
const { Tournament } = await import("../models/Tournament");
const { StreamAsset } = await import("../models/StreamAsset");
const bcrypt = (await import("bcryptjs")).default;
const sharp = (await import("sharp")).default;
const { del } = await import("@vercel/blob");

async function main() {
  let failures = 0;
  function assert(cond, label) {
    if (cond) {
      console.log(`  OK   ${label}`);
    } else {
      console.log(`  FAIL ${label}`);
      failures++;
    }
  }

  await connectToDatabase();

  const email = "sponsorbannerlinktest@example.com";
  const password = "TestPass123!";
  await User.deleteOne({ email });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ email, passwordHash });
  const player = await Player.create({ userId: user._id, tag: "BannerLinkTester" });
  await User.findByIdAndUpdate(user._id, { playerId: player._id });

  let tournament;
  const uploadedBlobUrls = [];

  try {
    // --- Real HTTP login ---
    console.log("\n=== Real HTTP login ===");
    const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`);
    const csrfCookies = csrfRes.headers.getSetCookie?.() ?? [];
    const { csrfToken } = await csrfRes.json();
    assert(!!csrfToken, "Got a CSRF token from /api/auth/csrf");

    const cookieHeaderFromSetCookies = setCookies => setCookies.map(c => c.split(";")[0]).join("; ");
    let cookieJar = cookieHeaderFromSetCookies(csrfCookies);

    const loginRes = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieJar },
      body: new URLSearchParams({ email, password, csrfToken, json: "true" }),
    });
    const loginCookies = loginRes.headers.getSetCookie?.() ?? [];
    assert(loginCookies.some(c => /session-token/i.test(c)), `Got a session-token cookie back from credentials login (status ${loginRes.status})`);
    cookieJar = [cookieJar, ...loginCookies.map(c => c.split(";")[0])].filter(Boolean).join("; ");

    // --- Upload 2 real tiny sponsor banners ---
    console.log("\n=== Real uploads through /api/upload (sponsor-banner) ===");
    async function uploadBanner(label, r, g, b) {
      const buf = await sharp({ create: { width: 40, height: 20, channels: 3, background: { r, g, b } } }).png().toBuffer();
      const form = new FormData();
      form.append("file", new Blob([buf], { type: "image/png" }), `${label}.png`);
      form.append("type", "sponsor-banner");
      const res = await fetch(`${BASE_URL}/api/upload`, { method: "POST", headers: { Cookie: cookieJar }, body: form });
      const json = await res.json();
      assert(res.status === 200 && !!json.url, `Upload of ${label} accepted (status ${res.status})`);
      if (json.url) uploadedBlobUrls.push(json.url);
      return json.url;
    }
    const linkedBannerUrl = await uploadBanner("linked-banner", 200, 50, 50);
    const unlinkedBannerUrl = await uploadBanner("unlinked-banner", 50, 50, 200);

    // --- Create a tournament and save the slideshow: one linked, one not ---
    console.log("\n=== Save slideshow via real GraphQL mutation: 1 linked + 1 unlinked banner ===");
    tournament = await Tournament.create({
      name: "Sponsor Banner Link Test",
      game: "Test Game",
      format: "Standard Bracket",
      organizers: [player._id],
      startDate: new Date(),
      entrantCount: 0,
    });

    const sponsorLinkUrl = "https://sponsor-example.test/deal";

    async function saveSlideshow(slides) {
      const res = await fetch(`${BASE_URL}/api/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieJar },
        body: JSON.stringify({
          query: `
            mutation SetSlideshow($id: ID!, $slides: [SponsorBannerSlideInput!], $interval: Int) {
              updateTournamentStreamAssets(id: $id, sponsorBannerUrls: $slides, sponsorBannerIntervalSeconds: $interval) {
                id
                sponsorBannerUrls { url linkUrl }
              }
            }
          `,
          variables: { id: tournament._id.toString(), slides, interval: 30 },
        }),
      });
      return res.json();
    }

    const firstSave = await saveSlideshow([
      { url: linkedBannerUrl, linkUrl: sponsorLinkUrl },
      { url: unlinkedBannerUrl, linkUrl: null },
    ]);
    assert(!firstSave.errors, `Slideshow mutation succeeded (${JSON.stringify(firstSave.errors ?? firstSave.data)})`);
    const savedSlides = firstSave.data?.updateTournamentStreamAssets?.sponsorBannerUrls;
    assert(Array.isArray(savedSlides) && savedSlides.length === 2, `Saved 2 slides (got ${JSON.stringify(savedSlides)})`);
    const savedLinked = savedSlides?.find(s => s.url === linkedBannerUrl);
    const savedUnlinked = savedSlides?.find(s => s.url === unlinkedBannerUrl);
    assert(savedLinked?.linkUrl === sponsorLinkUrl, `Linked banner's linkUrl round-trips correctly (got ${savedLinked?.linkUrl})`);
    assert(!savedUnlinked?.linkUrl, `Unlinked banner's linkUrl is empty/null, not an error (got ${JSON.stringify(savedUnlinked?.linkUrl)})`);

    // --- Stream view: linked banner is the active (first/SSR) slide ---
    console.log("\n=== Stream view wraps the ACTIVE linked banner in a real <a href> ===");
    const streamRes1 = await fetch(`${BASE_URL}/tournaments/${tournament._id.toString()}/stream`, { cache: "no-store" });
    const streamHtml1 = await streamRes1.text();
    assert(streamRes1.status === 200, `Stream page rendered (status ${streamRes1.status})`);
    const anchorOpenTag = `<a href="${sponsorLinkUrl}" target="_blank" rel="noopener noreferrer"`;
    const anchorIdx = streamHtml1.indexOf(anchorOpenTag);
    assert(anchorIdx !== -1, `Stream HTML contains the real <a href="${sponsorLinkUrl}" target="_blank" rel="noopener noreferrer"> wrapper`);
    const imgIdxAfterAnchor = streamHtml1.indexOf(`src="${linkedBannerUrl}"`, anchorIdx);
    assert(
      anchorIdx !== -1 && imgIdxAfterAnchor !== -1 && imgIdxAfterAnchor - anchorIdx < 300,
      "That <a> wrapper actually contains the linked banner's <img> (not just present elsewhere on the page)"
    );

    // --- Reorder so the UNLINKED banner is the active (first/SSR) slide ---
    console.log("\n=== Reorder so the UNLINKED banner is active -- confirm it renders with NO <a> wrapper ===");
    const secondSave = await saveSlideshow([
      { url: unlinkedBannerUrl, linkUrl: null },
      { url: linkedBannerUrl, linkUrl: sponsorLinkUrl },
    ]);
    assert(!secondSave.errors, `Reorder mutation succeeded (${JSON.stringify(secondSave.errors ?? secondSave.data)})`);

    const streamRes2 = await fetch(`${BASE_URL}/tournaments/${tournament._id.toString()}/stream`, { cache: "no-store" });
    const streamHtml2 = await streamRes2.text();
    assert(streamHtml2.includes(`src="${unlinkedBannerUrl}"`), "Stream HTML shows the unlinked banner's <img> as the active slide");
    assert(!streamHtml2.includes(anchorOpenTag), "No <a href> wrapper anywhere in this render -- the active (unlinked) banner isn't wrapped, and the linked banner (now inactive) isn't rendered at all this pass");

    console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURE(S)`}`);
  } finally {
    console.log("\nCleaning up test data...");
    for (const url of uploadedBlobUrls) {
      try {
        await del(url);
      } catch {
        /* fine */
      }
    }
    if (tournament) await Tournament.findByIdAndDelete(tournament._id);
    await StreamAsset.deleteMany({ organizerId: player._id });
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
