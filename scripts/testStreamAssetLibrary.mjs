// scripts/testStreamAssetLibrary.mjs
//
// Functional verification for the TO reusable stream-asset library
// (models/StreamAsset.ts + lib/streamAssets.ts): every upload is recorded,
// the retention cap evicts the oldest beyond 10 per (organizer, type) and
// ACTUALLY deletes the evicted blob from real Vercel Blob storage (not just
// unreferencing it), and a blob still actively set as some tournament's
// current background/banner is never evicted even if it's old enough to
// otherwise qualify.
//
// Uploads REAL tiny blobs to the REAL Vercel Blob store (a 1x1 PNG, ~70
// bytes) and verifies deletion via the REAL list()/head() API -- not a
// mock. Same approach as the other scripts/test*.mjs files: real functions,
// real database, real external service, cleaned up in a try/finally.
//
// Run: npx tsx scripts/testStreamAssetLibrary.mjs

import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";

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
const { StreamAsset, StreamAssetType } = await import("../models/StreamAsset");
const { recordStreamAssetUpload, listStreamAssets } = await import("../lib/streamAssets");
const { put, head } = await import("@vercel/blob");

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  OK   ${label}`);
  } else {
    console.log(`  FAIL ${label}`);
    failures++;
  }
}

// A real, tiny (67-byte) 1x1 transparent PNG -- real bytes uploaded to the
// real Vercel Blob store, not a mock file.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

async function blobExists(url) {
  try {
    await head(url);
    return true;
  } catch {
    return false;
  }
}

async function uploadRealTestBlob(label) {
  const blob = await put(`stream-asset-library-test/${Date.now()}-${label}.png`, TINY_PNG, {
    access: "public",
    contentType: "image/png",
  });
  return blob.url;
}

async function main() {
  await connectToDatabase();

  const passwordHash = await bcrypt.hash("TestPass123!", 10);
  const email = "streamassetlibraryto@example.com";
  await User.deleteOne({ email });
  const user = await User.create({ email, passwordHash });
  const organizer = await Player.create({ userId: user._id, tag: "StreamAssetLibraryTO" });
  await User.findByIdAndUpdate(user._id, { playerId: organizer._id });

  const uploadedUrls = []; // every real blob this test creates, for final cleanup
  let tournament;

  try {
    console.log("\n=== TEST 1: uploads are recorded; retention cap evicts the oldest beyond 10, real blob deleted ===");

    const urls = [];
    for (let i = 1; i <= 11; i++) {
      const url = await uploadRealTestBlob(`bg${i}`);
      uploadedUrls.push(url);
      urls.push(url);
      await recordStreamAssetUpload(organizer._id.toString(), StreamAssetType.STREAM_BG, url);
    }

    const afterEleven = await listStreamAssets(organizer._id.toString(), StreamAssetType.STREAM_BG);
    assert(afterEleven.length === 10, `11 uploads, cap 10 -> exactly 10 StreamAsset docs remain (got ${afterEleven.length})`);

    const oldestUrl = urls[0]; // the 1st upload -- should have been evicted (11 uploads, cap 10, exactly 1 over)
    const stillListed = afterEleven.some(a => a.url === oldestUrl);
    assert(!stillListed, "The oldest (1st) upload is no longer in the DB-listed library");

    const oldestBlobGone = !(await blobExists(oldestUrl));
    assert(oldestBlobGone, "The oldest upload's REAL blob is actually gone from Vercel Blob storage (verified via head(), not just unreferenced)");

    const secondUrl = urls[1]; // the 2nd upload -- 11 uploads, cap 10, only 1 excess, so this one should survive
    assert(await blobExists(secondUrl), "The 2nd-oldest upload's real blob still exists -- only the single excess item (11-10=1) was evicted, not more");

    const newestUrl = urls[urls.length - 1];
    assert(await blobExists(newestUrl), "The most recent upload's real blob still exists (not evicted)");
    assert(afterEleven[0].url === newestUrl, "listStreamAssets returns most-recent-first");

    console.log("\n=== TEST 2: a blob still actively set as a tournament's current background is pinned -- excluded from the cap entirely, never evicted ===");

    tournament = await Tournament.create({
      name: "Stream Asset Library Test",
      game: "Test Game",
      format: "Standard Bracket",
      organizers: [organizer._id],
      startDate: new Date(),
      entrantCount: 0,
    });

    // The current 10 remaining uploads -- re-derive the real current oldest
    // from the DB directly rather than assuming array positions, since
    // eviction order is driven by real createdAt timestamps, not array index.
    const currentAssets = await listStreamAssets(organizer._id.toString(), StreamAssetType.STREAM_BG);
    const pinned = currentAssets[currentAssets.length - 1]; // last = oldest of the remaining 10

    // Mark the real current-oldest surviving asset as this tournament's
    // ACTIVE background -- pinning it, per the design: pinned assets are
    // excluded from the cap count entirely (not just skipped-in-place), so
    // the library can legitimately hold MORE than 10 total docs when one of
    // them is pinned -- the cap applies to the 10 most recent NON-pinned ones.
    await Tournament.findByIdAndUpdate(tournament._id, { streamBackgroundUrl: pinned.url });

    const guardedUrl = await uploadRealTestBlob("bg-pinned-guard-1");
    uploadedUrls.push(guardedUrl);
    await recordStreamAssetUpload(organizer._id.toString(), StreamAssetType.STREAM_BG, guardedUrl);

    const after1 = await listStreamAssets(organizer._id.toString(), StreamAssetType.STREAM_BG);
    // 10 pre-existing (1 pinned + 9 evictable) + 1 new = 11 total, but only
    // 10 are EVICTABLE (11 - 1 pinned = 10, exactly at cap) -- nothing
    // should be evicted yet.
    assert(after1.length === 11, `10 pre-existing + 1 new = 11 total docs, none evicted yet since only 10 are evictable (got ${after1.length})`);
    assert(after1.some(a => a.url === pinned.url), "The pinned asset is still in the library");
    assert(await blobExists(pinned.url), "The pinned asset's real blob still exists -- the in-use guard actually protected it");
    assert(await blobExists(guardedUrl), "The new upload's real blob also still exists (nothing evicted this round)");

    // One MORE upload: now 11 evictable (12 total - 1 pinned), 1 over cap --
    // the next-oldest EVICTABLE one (not the pinned one) should actually get
    // deleted for real this time, proving the cap is still genuinely
    // enforced, just excluding the pinned entry from its count.
    const oldestEvictableBefore = [...after1].reverse().find(a => a.url !== pinned.url);
    const guardedUrl2 = await uploadRealTestBlob("bg-pinned-guard-2");
    uploadedUrls.push(guardedUrl2);
    await recordStreamAssetUpload(organizer._id.toString(), StreamAssetType.STREAM_BG, guardedUrl2);

    const after2 = await listStreamAssets(organizer._id.toString(), StreamAssetType.STREAM_BG);
    assert(after2.length === 11, `Cap enforced again -- back to 11 total (10 evictable + 1 pinned) after the next upload (got ${after2.length})`);
    assert(after2.some(a => a.url === pinned.url), "The pinned asset is STILL retained (still never evicted)");
    assert(!after2.some(a => a.url === oldestEvictableBefore.url), "The next-oldest NON-pinned asset was actually evicted this time -- the cap is real, not just disabled by the pinned guard");
    assert(!(await blobExists(oldestEvictableBefore.url)), "That evicted asset's real blob is actually deleted from Vercel Blob storage");

    console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURE(S)`}`);
  } finally {
    console.log("\nCleaning up test data...");
    // Delete every real blob this test created that might still exist
    // (some were already deleted for real by eviction -- del() on an
    // already-gone blob is a safe no-op we just swallow).
    for (const url of uploadedUrls) {
      try {
        const { del } = await import("@vercel/blob");
        await del(url);
      } catch {
        /* already deleted by eviction, or never existed -- fine */
      }
    }
    if (tournament) await Tournament.findByIdAndDelete(tournament._id);
    await StreamAsset.deleteMany({ organizerId: organizer._id });
    await Player.findByIdAndDelete(organizer._id);
    await User.findByIdAndDelete(user._id);

    const leftoverAssets = await StreamAsset.countDocuments({ organizerId: organizer._id });
    const leftoverTournament = tournament ? await Tournament.countDocuments({ _id: tournament._id }) : 0;
    const leftoverUser = await User.countDocuments({ email });
    console.log(`Verification -- leftover StreamAsset docs: ${leftoverAssets}, leftover tournament: ${leftoverTournament}, leftover user: ${leftoverUser}`);

    let leftoverBlobs = 0;
    for (const url of uploadedUrls) {
      if (await blobExists(url)) leftoverBlobs++;
    }
    console.log(`Verification -- leftover real blobs still in Vercel Blob storage: ${leftoverBlobs} of ${uploadedUrls.length} created`);
    console.log("Cleanup done.");
  }

  process.exit(failures === 0 ? 0 : 1);
}

main();
