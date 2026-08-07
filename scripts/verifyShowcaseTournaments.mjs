// scripts/verifyShowcaseTournaments.mjs
//
// Per-tournament verification for all 8 showcase tournaments (4 new small
// ones + 4 existing 701-entrant scale-reference ones) -- checks EACH one
// individually, not just a spot-check of the first, per this project's
// documented history: a disposable finishing script once force-ended a
// tournament without confirming the bracket was actually decided, resulting
// in zero placements and no real winner. Confirms for each:
//   1. Tournament.status === "ENDED"
//   2. Tournament.isExample === true
//   3. The top-level bracket (poolId: null -- the standard bracket, or the
//      Pools + Bracket format's main/2nd-stage bracket) has a Grand Final
//      match with status COMPLETED and a real winnerId. If a Grand Final
//      Reset match exists, it must ALSO be COMPLETED with a real winnerId
//      (and is then the true terminal match).
//   4. At least one Entrant has placement === 1 (the winner) and one has
//      placement === 2 (the runner-up) -- computeAndApplyBracketPlacements
//      (lib/bracket.ts) only ever writes these once the bracket is
//      genuinely decided, so their presence is real evidence of a decided
//      bracket, not just a status flag.
//
// Run: npx tsx scripts/verifyShowcaseTournaments.mjs

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
const { Tournament } = await import("../models/Tournament");
const { Entrant } = await import("../models/Entrant");
const { Match } = await import("../models/Match");
const { Bracket } = await import("../models/Bracket");

const TOURNAMENT_IDS = [
  // 4 new small showcase tournaments (this session)
  { label: "NEW Standard Bracket", id: "6a75538ec78ca6be725fc369" },
  { label: "NEW Pool Model A", id: "6a7553e662616cb1f0c98818" },
  { label: "NEW Pool Model C", id: "6a7554174dd2866844588995" },
  { label: "NEW Pool Model B", id: "6a755442e33b8991ae1cb9ba" },
  // 4 recreated 701-entrant scale-reference tournaments -- the original
  // IDs referenced in Notion (6a6d069e387ee77102b68fb3, 6a6d10f64991d6d367a265c9,
  // 6a6daf3c7a5930136d5bd8d0, 6a6dbd18432db663bb0bc86e) were found to no
  // longer exist in the database at all (Aug 6-7, 2026) and were recreated.
  { label: "SCALE Standard Bracket", id: "6a75563ff3a4789d531d82b7" },
  { label: "SCALE Pool Model A", id: "6a755c382534b30e75c883c7" },
  { label: "SCALE Pool Model C", id: "6a75694ed9a6da73c2f22f56" },
  { label: "SCALE Pool Model B", id: "6a7573333a5c730595ffbfec" },
];

async function verifyOne({ label, id }) {
  const result = { label, id, pass: true, checks: [] };
  const record = (ok, msg) => {
    result.checks.push(`${ok ? "OK" : "FAIL"}: ${msg}`);
    if (!ok) result.pass = false;
  };

  const tournament = await Tournament.findById(id);
  if (!tournament) {
    record(false, "tournament not found");
    return result;
  }

  record(tournament.status === "ENDED", `status === ENDED (actual: ${tournament.status})`);
  record(tournament.isExample === true, `isExample === true (actual: ${tournament.isExample})`);
  record(tournament.entrantCount > 0, `entrantCount > 0 (actual: ${tournament.entrantCount})`);

  const topBracket = await Bracket.findOne({ tournamentId: id, poolId: null });
  if (!topBracket) {
    record(false, "no top-level (poolId: null) bracket found");
    return result;
  }

  const gf = await Match.findOne({ bracketId: topBracket._id, bracketSide: "GRAND_FINAL" });
  const gfReset = await Match.findOne({ bracketId: topBracket._id, bracketSide: "GRAND_FINAL_RESET" });

  if (!gf) {
    record(false, "no Grand Final match exists");
  } else {
    record(gf.status === "COMPLETED", `Grand Final status === COMPLETED (actual: ${gf.status})`);
    record(!!gf.winnerId, `Grand Final has a real winnerId (actual: ${gf.winnerId})`);
  }

  if (gfReset) {
    record(gfReset.status === "COMPLETED", `Grand Final Reset EXISTS and status === COMPLETED (actual: ${gfReset.status})`);
    record(!!gfReset.winnerId, `Grand Final Reset has a real winnerId (actual: ${gfReset.winnerId})`);
  } else {
    result.checks.push("INFO: no Grand Final Reset match exists (not needed under this bracket's actual results)");
  }

  const entrants = await Entrant.find({ tournamentId: id }).select("placement").lean();
  const first = entrants.filter(e => e.placement === 1).length;
  const second = entrants.filter(e => e.placement === 2).length;
  const withPlacement = entrants.filter(e => e.placement != null).length;
  record(first === 1, `exactly one Entrant.placement === 1 (actual: ${first})`);
  record(second === 1, `exactly one Entrant.placement === 2 (actual: ${second})`);
  result.checks.push(`INFO: ${withPlacement}/${entrants.length} entrants have a non-null placement`);

  return result;
}

async function main() {
  await connectToDatabase();
  let allPass = true;
  for (const t of TOURNAMENT_IDS) {
    const r = await verifyOne(t);
    console.log(`\n=== ${r.label} (${r.id}) — ${r.pass ? "PASS" : "FAIL"} ===`);
    for (const c of r.checks) console.log(`  ${c}`);
    if (!r.pass) allPass = false;
  }
  console.log(`\n\n${allPass ? "ALL TOURNAMENTS VERIFIED" : "SOME TOURNAMENTS FAILED VERIFICATION"}`);
  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
