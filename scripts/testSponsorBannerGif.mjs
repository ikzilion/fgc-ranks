// Functional verification for sponsor-banner GIF support: real HTTP login,
// real multipart upload through /api/upload, real GraphQL mutation, and a
// real fetch of the rendered stream page + the served blob bytes -- not a
// mock. Confirms:
//   1. A real animated (2-frame) GIF is accepted by /api/upload as a
//      sponsor-banner upload (MIME validation).
//   2. The stream page renders it via a plain <img src="..."> pointing
//      straight at the blob URL -- NOT routed through Next's /_next/image
//      optimizer, which would flatten it to a static frame.
//   3. The bytes served back from that exact URL are still a genuine
//      multi-frame GIF (unmodified) -- i.e. what a real browser fetches
//      still has >1 frame to animate through.
//
// Requires `npm run dev` already running on localhost:3000 -- this test
// drives the real HTTP routes (/api/auth/*, /api/upload, /api/graphql),
// not just the underlying library functions.
//
// Run: npx tsx scripts/testSponsorBannerGif.mjs

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

  const email = "sponsorbannergiftest@example.com";
  const password = "TestPass123!";
  await User.deleteOne({ email });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ email, passwordHash });
  const player = await Player.create({ userId: user._id, tag: "GifBannerTester" });
  await User.findByIdAndUpdate(user._id, { playerId: player._id });

  let tournament;
  const uploadedBlobUrls = [];

  try {
    // --- Real HTTP login (NextAuth v5 credentials flow: csrf -> callback) ---
    console.log("\n=== Real HTTP login ===");
    const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`);
    const csrfCookies = csrfRes.headers.getSetCookie?.() ?? [];
    const csrfJson = await csrfRes.json();
    const csrfToken = csrfJson.csrfToken;
    assert(!!csrfToken, "Got a CSRF token from /api/auth/csrf");

    const cookieHeaderFromSetCookies = (setCookies) => setCookies.map(c => c.split(";")[0]).join("; ");
    let cookieJar = cookieHeaderFromSetCookies(csrfCookies);

    const loginRes = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieJar,
      },
      body: new URLSearchParams({ email, password, csrfToken, json: "true" }),
    });
    const loginCookies = loginRes.headers.getSetCookie?.() ?? [];
    const sessionCookiePart = loginCookies.find(c => /session-token/i.test(c));
    assert(!!sessionCookiePart, `Got a session-token cookie back from credentials login (status ${loginRes.status})`);
    cookieJar = [cookieJar, ...loginCookies.map(c => c.split(";")[0])].filter(Boolean).join("; ");

    // Confirm the session actually resolves server-side before trusting it
    // for the upload request below.
    const sessionRes = await fetch(`${BASE_URL}/api/auth/session`, { headers: { Cookie: cookieJar } });
    const sessionJson = await sessionRes.json();
    assert(sessionJson?.user?.email === email, `/api/auth/session recognizes the logged-in user (got ${JSON.stringify(sessionJson?.user)})`);

    // --- Build a REAL animated (2-frame) GIF, not a static image saved with a .gif extension ---
    // GIF89a header, logical screen descriptor, global color table (2 colors:
    // black/white), Netscape loop extension, then 2 image frames each with
    // their own Graphic Control Extension (distinct delay) -- a genuine
    // multi-frame animation, not a 1-frame file.
    function buildAnimatedGif() {
      const header = Buffer.from("GIF89a", "ascii");
      const width = 2, height = 1;
      const lsd = Buffer.from([width & 0xff, width >> 8, height & 0xff, height >> 8, 0xf1, 0, 0]); // global color table, 2 colors
      const gct = Buffer.from([0, 0, 0, 255, 255, 255]); // black, white
      const netscape = Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0", "ascii"), 0x03, 0x01, 0x00, 0x00, 0x00]);
      function frame(colorIndex, delayCentiseconds) {
        const gce = Buffer.from([0x21, 0xf9, 0x04, 0x00, delayCentiseconds & 0xff, delayCentiseconds >> 8, 0x00, 0x00]);
        const imageDescriptor = Buffer.from([0x2c, 0, 0, 0, 0, width & 0xff, width >> 8, height & 0xff, height >> 8, 0x00]);
        // Minimal LZW-compressed image data for a solid-color 2x1 image (1-bit code size).
        const imageData = Buffer.from([0x02, 0x02, colorIndex === 0 ? 0x44 : 0x8c, 0x01, 0x00]);
        return Buffer.concat([gce, imageDescriptor, imageData]);
      }
      const trailer = Buffer.from([0x3b]);
      return Buffer.concat([header, lsd, gct, netscape, frame(0, 50), frame(1, 50), trailer]);
    }
    const gifBuffer = buildAnimatedGif();
    // Image descriptors each start with their own 0x2C block marker.
    let realFrameCount = 0;
    for (let i = 0; i < gifBuffer.length; i++) if (gifBuffer[i] === 0x2c) realFrameCount++;
    assert(realFrameCount === 2, `Built test fixture is a genuine multi-frame GIF (found ${realFrameCount} image descriptor blocks, expected 2)`);

    // --- Real multipart upload through the actual /api/upload route ---
    console.log("\n=== Real upload through /api/upload (type=sponsor-banner) ===");
    const form = new FormData();
    form.append("file", new Blob([gifBuffer], { type: "image/gif" }), "test-sponsor-banner.gif");
    form.append("type", "sponsor-banner");
    const uploadRes = await fetch(`${BASE_URL}/api/upload`, {
      method: "POST",
      headers: { Cookie: cookieJar },
      body: form,
    });
    const uploadJson = await uploadRes.json();
    assert(uploadRes.status === 200 && !!uploadJson.url, `Upload accepted (status ${uploadRes.status}): ${JSON.stringify(uploadJson)}`);
    const bannerUrl = uploadJson.url;
    if (bannerUrl) uploadedBlobUrls.push(bannerUrl);

    // --- Confirm the served blob is still the real, untouched multi-frame GIF ---
    console.log("\n=== Confirm served blob is untouched (still multi-frame) ===");
    const blobRes = await fetch(bannerUrl);
    const blobContentType = blobRes.headers.get("content-type");
    assert(blobContentType?.includes("gif"), `Blob served with an image/gif content-type (got ${blobContentType})`);
    const blobBytes = Buffer.from(await blobRes.arrayBuffer());
    let servedFrameCount = 0;
    for (let i = 0; i < blobBytes.length; i++) if (blobBytes[i] === 0x2c) servedFrameCount++;
    assert(servedFrameCount === 2, `Served blob still has 2 image descriptor blocks -- upload path did not re-encode/flatten it (found ${servedFrameCount})`);
    assert(blobBytes.equals(gifBuffer), "Served blob bytes are byte-for-byte identical to what was uploaded");

    // --- Set it as this tournament's sponsor banner via the real GraphQL mutation ---
    console.log("\n=== Set as tournament sponsor banner via real GraphQL mutation ===");
    tournament = await Tournament.create({
      name: "Sponsor Banner GIF Test",
      game: "Test Game",
      format: "Standard Bracket",
      organizers: [player._id],
      startDate: new Date(),
      entrantCount: 0,
    });

    const mutationRes = await fetch(`${BASE_URL}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieJar },
      body: JSON.stringify({
        query: `
          mutation SetBanner($id: ID!, $sponsorBannerUrl: String) {
            updateTournamentStreamAssets(id: $id, sponsorBannerUrl: $sponsorBannerUrl) { id sponsorBannerUrl }
          }
        `,
        variables: { id: tournament._id.toString(), sponsorBannerUrl: bannerUrl },
      }),
    });
    const mutationJson = await mutationRes.json();
    assert(!mutationJson.errors, `updateTournamentStreamAssets succeeded (${JSON.stringify(mutationJson.errors ?? mutationJson.data)})`);
    assert(mutationJson.data?.updateTournamentStreamAssets?.sponsorBannerUrl === bannerUrl, "sponsorBannerUrl saved correctly on the tournament");

    // --- Fetch the REAL rendered stream page HTML and confirm rendering behavior ---
    console.log("\n=== Fetch real rendered /tournaments/[id]/stream HTML ===");
    const streamRes = await fetch(`${BASE_URL}/tournaments/${tournament._id.toString()}/stream`, { cache: "no-store" });
    const streamHtml = await streamRes.text();
    assert(streamRes.status === 200, `Stream page rendered (status ${streamRes.status})`);
    const rawImgTagPresent = streamHtml.includes(`src="${bannerUrl}"`) || streamHtml.includes(`src=\\"${bannerUrl}\\"`);
    assert(rawImgTagPresent, "Stream page's HTML contains a raw <img src=\"...blob-url...\"> pointing straight at the uploaded GIF");
    const routedThroughImageOptimizer = streamHtml.includes("/_next/image") && streamHtml.includes(encodeURIComponent(bannerUrl));
    assert(!routedThroughImageOptimizer, "The banner is NOT routed through Next's /_next/image optimizer (which would flatten animation)");

    // --- Slideshow: multiple banners + interval via the same mutation ---
    console.log("\n=== Slideshow fields (sponsorBannerUrls + interval) accepted by the same mutation ===");
    const gifBuffer2 = buildAnimatedGif();
    const form2 = new FormData();
    form2.append("file", new Blob([gifBuffer2], { type: "image/gif" }), "test-sponsor-banner-2.gif");
    form2.append("type", "sponsor-banner");
    const uploadRes2 = await fetch(`${BASE_URL}/api/upload`, { method: "POST", headers: { Cookie: cookieJar }, body: form2 });
    const uploadJson2 = await uploadRes2.json();
    if (uploadJson2.url) uploadedBlobUrls.push(uploadJson2.url);
    assert(uploadRes2.status === 200 && !!uploadJson2.url, "Second GIF banner upload accepted");

    const slideshowRes = await fetch(`${BASE_URL}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieJar },
      body: JSON.stringify({
        query: `
          mutation SetSlideshow($id: ID!, $urls: [String!], $interval: Int) {
            updateTournamentStreamAssets(id: $id, sponsorBannerUrls: $urls, sponsorBannerIntervalSeconds: $interval) { id sponsorBannerUrls sponsorBannerIntervalSeconds }
          }
        `,
        variables: { id: tournament._id.toString(), urls: [bannerUrl, uploadJson2.url], interval: 15 },
      }),
    });
    const slideshowJson = await slideshowRes.json();
    assert(!slideshowJson.errors, `Slideshow mutation succeeded (${JSON.stringify(slideshowJson.errors ?? slideshowJson.data)})`);
    const savedTournament = slideshowJson.data?.updateTournamentStreamAssets;
    assert(
      Array.isArray(savedTournament?.sponsorBannerUrls) && savedTournament.sponsorBannerUrls.length === 2,
      `sponsorBannerUrls saved with 2 entries (got ${JSON.stringify(savedTournament?.sponsorBannerUrls)})`
    );
    assert(savedTournament?.sponsorBannerIntervalSeconds === 15, `sponsorBannerIntervalSeconds saved as 15 (got ${savedTournament?.sponsorBannerIntervalSeconds})`);

    // Rejection case: 2 banners with no interval should be rejected server-side.
    const rejectRes = await fetch(`${BASE_URL}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieJar },
      body: JSON.stringify({
        query: `mutation ClearInterval($id: ID!) { updateTournamentStreamAssets(id: $id, sponsorBannerIntervalSeconds: null) { id } }`,
        variables: { id: tournament._id.toString() },
      }),
    });
    const rejectJson = await rejectRes.json();
    assert(!!rejectJson.errors, `Clearing the interval while 2 banners are still selected is server-side rejected (${JSON.stringify(rejectJson.errors ?? rejectJson.data)})`);

    console.log("\n=== Re-fetch stream page HTML now that a slideshow is configured ===");
    const streamRes2 = await fetch(`${BASE_URL}/tournaments/${tournament._id.toString()}/stream`, { cache: "no-store" });
    const streamHtml2 = await streamRes2.text();
    const eitherBannerPresent =
      streamHtml2.includes(`src="${bannerUrl}"`) || streamHtml2.includes(`src="${uploadJson2.url}"`) ||
      streamHtml2.includes(`src=\\"${bannerUrl}\\"`) || streamHtml2.includes(`src=\\"${uploadJson2.url}\\"`);
    assert(eitherBannerPresent, "Stream page HTML shows one of the 2 slideshow banners as a raw <img src>");

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
