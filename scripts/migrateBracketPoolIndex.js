// scripts/migrateBracketPoolIndex.js
//
// One-off: the Pool play + top-cut bracket feature changed Bracket.tournamentId
// from a plain unique index to a partial one (unique only among poolId: null
// brackets), so a "Pools + Bracket" tournament can have multiple Bracket
// documents (one per pool + one main bracket) sharing a tournamentId.
// Mongoose's autoIndex never drops an old index that's no longer in the
// schema, so the original plain unique index on tournamentId is still live
// in production and would reject every pool bracket after the first. This
// drops that old index; the app then builds the new partial + poolId
// indexes itself on next connect (models/Bracket.ts's schema.index calls).
//
// Also drops any existing `poolId_1` index outright, regardless of shape —
// an earlier version of this migration/schema created it as `sparse: true`,
// which does NOT exclude explicit `poolId: null` (only a genuinely MISSING
// field), so it collided on every non-pool bracket (confirmed via the
// feature's functional test). The corrected schema uses a partial index
// instead (`$type: "objectId"`), which has the same default index name —
// dropping the old one first avoids an IndexOptionsConflict on next connect.
//
// Safe to re-run.
//
// Run: npx tsx scripts/migrateBracketPoolIndex.js

import fs from "fs";
import path from "path";
import mongoose from "mongoose";

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

async function main() {
  loadEnvLocal();
  if (!process.env.MONGODB_URI) throw new Error("Missing MONGODB_URI (checked .env.local)");
  await mongoose.connect(process.env.MONGODB_URI);

  const collection = mongoose.connection.collection("brackets");
  const indexes = await collection.indexes();
  console.log("Existing indexes:", indexes.map(i => i.name));

  const old = indexes.find(i => i.name === "tournamentId_1" && !i.partialFilterExpression);
  if (old) {
    await collection.dropIndex("tournamentId_1");
    console.log("Dropped old plain-unique tournamentId_1 index.");
  } else {
    console.log("No old plain-unique tournamentId_1 index found — nothing to drop.");
  }

  const badPoolIdIndex = indexes.find(i => i.name === "poolId_1");
  if (badPoolIdIndex) {
    await collection.dropIndex("poolId_1");
    console.log("Dropped existing poolId_1 index (will be rebuilt correctly as a partial index on next app connect).");
  } else {
    console.log("No existing poolId_1 index found — nothing to drop.");
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
