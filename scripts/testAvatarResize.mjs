// Functional verification for avatar-specific resize/compression
// (lib/avatarImage.ts + app/api/upload/route.ts): real HTTP login, a real
// oversized (2400x1800, ~4.2MB, high-entropy so it resists compression --
// a harder case than a typical real phone photo) test image uploaded
// through the actual /api/upload route, and a real fetch + sharp decode of
// the resulting stored blob -- not a mock. Confirms:
//   1. The oversized upload is ACCEPTED (not rejected) -- the whole point
//      is no "photo too big" error for a normal-or-larger phone photo.
//   2. The stored blob is resized to <= 512x512 and re-encoded to WebP.
//   3. The stored blob is <= the 750KB target.
//   4. A normal small avatar upload still works unaffected (and still gets
//      normalized to the standard 512x512/WebP output).
//   5. The resulting avatarUrl saves via the real updatePlayer mutation and
//      is fetchable/renders as valid, decodable image bytes.
//
// Requires `npm run dev` already running on localhost:3000.
// Run: npx tsx scripts/testAvatarResize.mjs

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
const { AVATAR_MAX_DIMENSION, AVATAR_TARGET_BYTES } = await import("../lib/avatarImage");
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

  const email = "avatarresizetest@example.com";
  const password = "TestPass123!";
  await User.deleteOne({ email });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ email, passwordHash });
  const player = await Player.create({ userId: user._id, tag: "AvatarResizeTester" });
  await User.findByIdAndUpdate(user._id, { playerId: player._id });

  const uploadedBlobUrls = [];

  try {
    // --- Real HTTP login (NextAuth v5 credentials flow: csrf -> callback) ---
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

    const sessionRes = await fetch(`${BASE_URL}/api/auth/session`, { headers: { Cookie: cookieJar } });
    const sessionJson = await sessionRes.json();
    assert(sessionJson?.user?.email === email, `/api/auth/session recognizes the logged-in user (got ${JSON.stringify(sessionJson?.user)})`);

    // --- Build a REAL oversized, high-entropy (hard to compress) test photo ---
    console.log("\n=== Build oversized test photo (2400x1800, random noise -> JPEG q95) ===");
    const width = 2400,
      height = 1800,
      channels = 3;
    const raw = Buffer.alloc(width * height * channels);
    for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(Math.random() * 256);
    const oversizedPhoto = await sharp(raw, { raw: { width, height, channels } }).jpeg({ quality: 95 }).toBuffer();
    console.log(`  Built a ${width}x${height} test JPEG, ${(oversizedPhoto.byteLength / 1024 / 1024).toFixed(2)}MB`);
    assert(oversizedPhoto.byteLength > AVATAR_TARGET_BYTES * 2, "Test fixture is genuinely oversized relative to the 750KB target (>2x)");
    assert(width > AVATAR_MAX_DIMENSION && height > AVATAR_MAX_DIMENSION, "Test fixture's dimensions genuinely exceed the 512px target");

    // --- Real upload through the actual /api/upload route (default/avatar type) ---
    console.log("\n=== Real upload through /api/upload (oversized photo, avatar path) ===");
    const form = new FormData();
    form.append("file", new Blob([oversizedPhoto], { type: "image/jpeg" }), "big-test-photo.jpg");
    // No "type" field appended -- exactly matches EditProfileButton.tsx's real
    // upload call, which relies on the route's own "avatar" default.
    const uploadRes = await fetch(`${BASE_URL}/api/upload`, { method: "POST", headers: { Cookie: cookieJar }, body: form });
    const uploadJson = await uploadRes.json();
    assert(uploadRes.status === 200 && !!uploadJson.url, `Oversized upload ACCEPTED, not rejected (status ${uploadRes.status}): ${JSON.stringify(uploadJson)}`);
    const avatarUrl = uploadJson.url;
    if (avatarUrl) uploadedBlobUrls.push(avatarUrl);

    // --- Confirm the served blob is actually resized/compressed ---
    console.log("\n=== Confirm stored blob is resized + compressed ===");
    const blobRes = await fetch(avatarUrl);
    const blobBytes = Buffer.from(await blobRes.arrayBuffer());
    assert(blobBytes.byteLength <= AVATAR_TARGET_BYTES, `Stored blob is <= 750KB target (got ${(blobBytes.byteLength / 1024).toFixed(1)}KB)`);
    const meta = await sharp(blobBytes).metadata();
    assert(meta.format === "webp", `Stored blob is WebP (got ${meta.format})`);
    assert(meta.width === AVATAR_MAX_DIMENSION && meta.height === AVATAR_MAX_DIMENSION, `Stored blob is exactly ${AVATAR_MAX_DIMENSION}x${AVATAR_MAX_DIMENSION} (got ${meta.width}x${meta.height})`);
    assert(
      blobBytes.byteLength < oversizedPhoto.byteLength * 0.3,
      `Stored blob is dramatically smaller than the original upload (${(blobBytes.byteLength / 1024).toFixed(0)}KB vs ${(oversizedPhoto.byteLength / 1024).toFixed(0)}KB)`
    );

    // --- Save it as this player's real avatar via the real updatePlayer mutation ---
    console.log("\n=== Save via real updatePlayer mutation, confirm it round-trips ===");
    const mutationRes = await fetch(`${BASE_URL}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieJar },
      body: JSON.stringify({
        query: `mutation SetAvatar($id: ID!, $avatarUrl: String) { updatePlayer(id: $id, avatarUrl: $avatarUrl) { id avatarUrl } }`,
        variables: { id: player._id.toString(), avatarUrl },
      }),
    });
    const mutationJson = await mutationRes.json();
    assert(!mutationJson.errors, `updatePlayer succeeded (${JSON.stringify(mutationJson.errors ?? mutationJson.data)})`);
    assert(mutationJson.data?.updatePlayer?.avatarUrl === avatarUrl, "avatarUrl saved correctly on the player");

    const playerRes = await fetch(`${BASE_URL}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query GetPlayer($id: ID!) { player(id: $id) { avatarUrl } }`,
        variables: { id: player._id.toString() },
      }),
    });
    const playerJson = await playerRes.json();
    assert(playerJson.data?.player?.avatarUrl === avatarUrl, "Re-fetching the player (real GraphQL query, no auth) returns the same avatarUrl");

    // --- Normal small avatar upload still works unaffected ---
    console.log("\n=== Normal small avatar upload still works ===");
    const smallWidth = 300,
      smallHeight = 300;
    const smallPhoto = await sharp({
      create: { width: smallWidth, height: smallHeight, channels: 3, background: { r: 80, g: 120, b: 200 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
    assert(smallPhoto.byteLength < AVATAR_TARGET_BYTES, "Small test fixture is already well under the target (sanity check on the fixture itself)");

    const smallForm = new FormData();
    smallForm.append("file", new Blob([smallPhoto], { type: "image/jpeg" }), "small-test-photo.jpg");
    const smallUploadRes = await fetch(`${BASE_URL}/api/upload`, { method: "POST", headers: { Cookie: cookieJar }, body: smallForm });
    const smallUploadJson = await smallUploadRes.json();
    assert(smallUploadRes.status === 200 && !!smallUploadJson.url, `Small avatar upload accepted (status ${smallUploadRes.status}): ${JSON.stringify(smallUploadJson)}`);
    if (smallUploadJson.url) uploadedBlobUrls.push(smallUploadJson.url);

    const smallBlobRes = await fetch(smallUploadJson.url);
    const smallBlobBytes = Buffer.from(await smallBlobRes.arrayBuffer());
    const smallMeta = await sharp(smallBlobBytes).metadata();
    assert(smallMeta.format === "webp", `Small avatar also normalized to WebP (got ${smallMeta.format})`);
    assert(
      smallMeta.width === AVATAR_MAX_DIMENSION && smallMeta.height === AVATAR_MAX_DIMENSION,
      `Small avatar also normalized to ${AVATAR_MAX_DIMENSION}x${AVATAR_MAX_DIMENSION} (got ${smallMeta.width}x${smallMeta.height})`
    );

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
