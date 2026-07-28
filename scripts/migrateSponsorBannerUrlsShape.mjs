// scripts/migrateSponsorBannerUrlsShape.mjs
//
// One-time data migration: Tournament.sponsorBannerUrls changed shape from a
// plain string array (["https://...", ...], slideshow feature, commit
// a9e13c6) to an array of { url, linkUrl } objects (per-banner click-through
// links). Mongoose's new schema casts each array element to a subdocument --
// a raw string element left over from before this migration would fail that
// cast (CastError) the moment ANY resolver loads that tournament, breaking
// every query that touches it. Uses the raw MongoDB driver (bypassing the
// Mongoose model, which is bound to the NEW schema) to read/rewrite the
// field before the new code ever touches these documents via Mongoose.
//
// Safe to run multiple times -- only touches documents whose
// sponsorBannerUrls array still contains raw strings.
//
// Run: npx tsx scripts/migrateSponsorBannerUrlsShape.mjs

import fs from "fs";
import path from "path";

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

const { connectToDatabase } = await import("../lib/db");
const mongoose = (await import("mongoose")).default;

async function main() {
  await connectToDatabase();
  // Raw collection access -- NOT the Mongoose Tournament model, which by the
  // time this runs may already be bound to the new object-shaped schema and
  // would refuse to cast/load the very legacy documents this script needs to fix.
  const collection = mongoose.connection.collection("tournaments");

  // For an array field, MongoDB's $type matches any document where AT LEAST
  // ONE element of that array has the given type.
  const candidates = await collection.find({ sponsorBannerUrls: { $type: "string" } }).toArray();

  console.log(`Found ${candidates.length} tournament(s) with legacy string-shaped sponsorBannerUrls entries.`);

  let migrated = 0;
  for (const doc of candidates) {
    const before = doc.sponsorBannerUrls ?? [];
    const after = before.map(entry => (typeof entry === "string" ? { url: entry, linkUrl: "" } : entry));
    await collection.updateOne({ _id: doc._id }, { $set: { sponsorBannerUrls: after } });
    console.log(`  Migrated tournament ${doc._id} (${before.length} entr${before.length === 1 ? "y" : "ies"})`);
    migrated++;
  }

  console.log(`\nDone. Migrated ${migrated} document(s).`);
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
