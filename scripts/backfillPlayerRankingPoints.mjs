// scripts/backfillPlayerRankingPoints.mjs
//
// One-off backfill: computes and persists Player.rankingPoints for every
// existing player, via the exact same computeRankingPointsForPlayers logic
// (lib/ranking.ts) every mutation now calls incrementally on write (see
// recomputeAndCachePlayerPoints). Needed once because rankingPoints is a
// brand-new field defaulting to 0 -- existing players' historical results
// were never captured in it until this runs.
//
// Idempotent -- safe to re-run any time; it always recomputes from the live
// Entrant/Tournament data, it never trusts the field's current value.
//
// .mjs (not .js) + dynamic imports AFTER loadEnvLocal(), same pattern as
// this repo's other tsx-run scripts: lib/db.ts's connectToDatabase() reads
// process.env.MONGODB_URI into a module-level const at import time, so it
// has to still be unset when lib/ranking.ts (which calls connectToDatabase
// internally) is imported -- a static top-level import runs before this
// file's own code regardless of source order, which is exactly what a
// plain .js/CJS file can't work around without top-level await.
//
// Run: npx tsx scripts/backfillPlayerRankingPoints.mjs

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
const { Player } = await import("../models/Player");
const { recomputeAndCachePlayerPoints } = await import("../lib/ranking");

async function main() {
  await connectToDatabase();

  const players = await Player.find({}).select("_id tag").lean();
  console.log(`Found ${players.length} player(s). Recomputing rankingPoints for all of them...`);

  const ids = players.map(p => p._id.toString());
  await recomputeAndCachePlayerPoints(ids);

  const updated = await Player.find({ _id: { $in: ids } }).select("tag rankingPoints").sort({ rankingPoints: -1 }).lean();
  for (const p of updated.slice(0, 20)) {
    console.log(`  ${p.tag}: ${p.rankingPoints} pts`);
  }
  if (updated.length > 20) console.log(`  ... and ${updated.length - 20} more`);

  console.log(`\nDone. ${updated.length} player(s) backfilled.`);
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
