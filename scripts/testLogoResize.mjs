// Functional verification for tournament-logo/event-logo/game-icon
// resize/compression (lib/logoImage.ts + app/api/upload/route.ts) added
// during the July 29, 2026 performance audit -- these previously got NO
// processing at all (unlike avatars), just a raw 5MB byte cap. Confirms,
// via real HTTP login + real uploads through the actual /api/upload route
// (not a mock):
//   1. An oversized static PNG uploaded as type=tournament-logo comes back
//      resized to <= 512x512 and re-encoded to WebP, <= the 750KB target.
//   2. A genuine multi-frame animated GIF uploaded as type=game-icon is
//      stored UNTOUCHED (still a real multi-frame GIF, not flattened).
//   3. type=event-logo gets the same static-image treatment as #1.
//
// Requires `npm run dev` already running on localhost:3000.
// Run: npx tsx scripts/testLogoResize.mjs

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
const { LOGO_MAX_DIMENSION, LOGO_TARGET_BYTES } = await import("../lib/logoImage");
const bcrypt = (await import("bcryptjs")).default;
const sharp = (await import("sharp")).default;
const { del } = await import("@vercel/blob");

function buildAnimatedGif() {
  const header = Buffer.from("GIF89a", "ascii");
  const width = 2, height = 1;
  const lsd = Buffer.from([width & 0xff, width >> 8, height & 0xff, height >> 8, 0xf1, 0, 0]);
  const gct = Buffer.from([0, 0, 0, 255, 255, 255]);
  const netscape = Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0", "ascii"), 0x03, 0x01, 0x00, 0x00, 0x00]);
  function frame(colorIndex, delayCentiseconds) {
    const gce = Buffer.from([0x21, 0xf9, 0x04, 0x00, delayCentiseconds & 0xff, delayCentiseconds >> 8, 0x00, 0x00]);
    const imageDescriptor = Buffer.from([0x2c, 0, 0, 0, 0, width & 0xff, width >> 8, height & 0xff, height >> 8, 0x00]);
    const imageData = Buffer.from([0x02, 0x02, colorIndex === 0 ? 0x44 : 0x8c, 0x01, 0x00]);
    return Buffer.concat([gce, imageDescriptor, imageData]);
  }
  const trailer = Buffer.from([0x3b]);
  return Buffer.concat([header, lsd, gct, netscape, frame(0, 50), frame(1, 50), trailer]);
}

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

  const email = "logoresizetest@example.com";
  const password = "TestPass123!";
  await User.deleteOne({ email });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ email, passwordHash });
  const player = await Player.create({ userId: user._id, tag: "LogoResizeTester" });
  await User.findByIdAndUpdate(user._id, { playerId: player._id });

  const uploadedBlobUrls = [];

  try {
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
    assert(loginCookies.some(c => /session-token/i.test(c)), `Got a session-token cookie back (status ${loginRes.status})`);
    cookieJar = [cookieJar, ...loginCookies.map(c => c.split(";")[0])].filter(Boolean).join("; ");

    const sessionRes = await fetch(`${BASE_URL}/api/auth/session`, { headers: { Cookie: cookieJar } });
    const sessionJson = await sessionRes.json();
    assert(sessionJson?.user?.email === email, `Session recognizes the logged-in user (got ${JSON.stringify(sessionJson?.user)})`);

    // --- Oversized static logo (tournament-logo) ---
    console.log("\n=== Oversized static JPEG, type=tournament-logo ===");
    const width = 1800, height = 1800, channels = 3;
    const raw = Buffer.alloc(width * height * channels);
    for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(Math.random() * 256);
    const oversizedLogo = await sharp(raw, { raw: { width, height, channels } }).jpeg({ quality: 85 }).toBuffer();
    console.log(`  Built a ${width}x${height} test JPEG, ${(oversizedLogo.byteLength / 1024 / 1024).toFixed(2)}MB`);
    assert(oversizedLogo.byteLength > LOGO_TARGET_BYTES * 2, "Test fixture is genuinely oversized relative to the 750KB target (>2x)");
    assert(oversizedLogo.byteLength < 5 * 1024 * 1024, "Test fixture is still under the 5MB raw upload ceiling (so it reaches the resize code, not the size-cap rejection)");

    const form = new FormData();
    form.append("file", new Blob([oversizedLogo], { type: "image/jpeg" }), "big-test-logo.jpg");
    form.append("type", "tournament-logo");
    const uploadRes = await fetch(`${BASE_URL}/api/upload`, { method: "POST", headers: { Cookie: cookieJar }, body: form });
    const uploadJson = await uploadRes.json();
    assert(uploadRes.status === 200 && !!uploadJson.url, `Oversized logo upload accepted (status ${uploadRes.status}): ${JSON.stringify(uploadJson)}`);
    if (uploadJson.url) uploadedBlobUrls.push(uploadJson.url);

    const blobRes = await fetch(uploadJson.url);
    const blobBytes = Buffer.from(await blobRes.arrayBuffer());
    assert(blobBytes.byteLength <= LOGO_TARGET_BYTES, `Stored blob <= 750KB target (got ${(blobBytes.byteLength / 1024).toFixed(1)}KB)`);
    const meta = await sharp(blobBytes).metadata();
    assert(meta.format === "webp", `Stored blob is WebP (got ${meta.format})`);
    assert(meta.width === LOGO_MAX_DIMENSION && meta.height === LOGO_MAX_DIMENSION, `Stored blob is exactly ${LOGO_MAX_DIMENSION}x${LOGO_MAX_DIMENSION} (got ${meta.width}x${meta.height})`);
    assert(blobBytes.byteLength < oversizedLogo.byteLength * 0.3, `Stored blob dramatically smaller than original (${(blobBytes.byteLength / 1024).toFixed(0)}KB vs ${(oversizedLogo.byteLength / 1024).toFixed(0)}KB)`);

    // --- Event logo gets the same treatment ---
    console.log("\n=== Small static PNG, type=event-logo ===");
    const smallLogo = await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 10, g: 200, b: 90 } } }).png().toBuffer();
    const eventForm = new FormData();
    eventForm.append("file", new Blob([smallLogo], { type: "image/png" }), "small-event-logo.png");
    eventForm.append("type", "event-logo");
    const eventUploadRes = await fetch(`${BASE_URL}/api/upload`, { method: "POST", headers: { Cookie: cookieJar }, body: eventForm });
    const eventUploadJson = await eventUploadRes.json();
    assert(eventUploadRes.status === 200 && !!eventUploadJson.url, `Event logo upload accepted (status ${eventUploadRes.status})`);
    if (eventUploadJson.url) uploadedBlobUrls.push(eventUploadJson.url);
    const eventBlobRes = await fetch(eventUploadJson.url);
    const eventBlobBytes = Buffer.from(await eventBlobRes.arrayBuffer());
    const eventMeta = await sharp(eventBlobBytes).metadata();
    assert(eventMeta.format === "webp" && eventMeta.width === LOGO_MAX_DIMENSION, `Event logo also normalized to ${LOGO_MAX_DIMENSION}px WebP (got ${eventMeta.width}x${eventMeta.height} ${eventMeta.format})`);

    // --- Animated GIF game icon passes through untouched ---
    console.log("\n=== Animated (2-frame) GIF, type=game-icon ===");
    const gifBuffer = buildAnimatedGif();
    let realFrameCount = 0;
    for (let i = 0; i < gifBuffer.length; i++) if (gifBuffer[i] === 0x2c) realFrameCount++;
    assert(realFrameCount === 2, `Built test fixture is a genuine multi-frame GIF (found ${realFrameCount} image descriptor blocks)`);

    const gifForm = new FormData();
    gifForm.append("file", new Blob([gifBuffer], { type: "image/gif" }), "test-game-icon.gif");
    gifForm.append("type", "game-icon");
    const gifUploadRes = await fetch(`${BASE_URL}/api/upload`, { method: "POST", headers: { Cookie: cookieJar }, body: gifForm });
    const gifUploadJson = await gifUploadRes.json();
    assert(gifUploadRes.status === 200 && !!gifUploadJson.url, `Animated GIF icon upload accepted (status ${gifUploadRes.status}): ${JSON.stringify(gifUploadJson)}`);
    if (gifUploadJson.url) uploadedBlobUrls.push(gifUploadJson.url);

    const gifBlobRes = await fetch(gifUploadJson.url);
    const gifContentType = gifBlobRes.headers.get("content-type");
    const gifBlobBytes = Buffer.from(await gifBlobRes.arrayBuffer());
    assert(gifContentType?.includes("gif"), `Served with image/gif content-type (got ${gifContentType})`);
    assert(gifBlobBytes.equals(gifBuffer), "Served blob bytes are byte-for-byte identical to the uploaded animated GIF (not flattened/re-encoded)");

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
