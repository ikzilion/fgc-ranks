// scripts/seedStressTest700Standard.mjs
//
// Real-scale (701-entrant) visual-inspection / scale-reference tournament
// for the "Standard Bracket" format -- the original version of this
// tournament (referenced in Notion as tournament ID
// 6a6d069e387ee77102b68fb3) was found to no longer exist in the database
// when this task went to relabel it (Aug 6, 2026), so this script recreates
// it from scratch, matching the same convention as
// scripts/seedStressTest700ModelA.mjs/seedStressTest700ModelC.mjs: direct-
// to-Mongo via connectToDatabase(), calling the REAL
// generateBracket/reportResult resolvers, reusing all 700 existing
// StressPlayer Player docs (no new players created) plus ikzilion as
// organizer+entrant (701 real entrants). Marked isExample: true (this
// field didn't exist when the original tournament was first created).
//
// Run: npx tsx scripts/seedStressTest700Standard.mjs

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
const { Tournament } = await import("../models/Tournament");
const { Entrant } = await import("../models/Entrant");
const { Match } = await import("../models/Match");
const { resolvers } = await import("../graphql/resolvers/index");

async function mapConcurrent(items, worker, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  async function runner() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, runner));
  return results;
}

// Deterministic "lower playerId wins" convention -- same rule
// seedStressTest700ModelA/C.mjs use. Verified safe against ever needing a
// Grand Final Reset (see scripts/seedShowcaseModelB.mjs's detailed
// reasoning): the global minimum-ID entrant never loses any match, so they
// always represent the Winners side at the Grand Final and win it directly.
async function reportDeterministic(organizerCtx, matchId, player1Id, player2Id) {
  const player1Wins = player1Id.toString() < player2Id.toString();
  await resolvers.Mutation.reportResult(
    null,
    { matchId: matchId.toString(), player1Score: player1Wins ? 2 : 0, player2Score: player1Wins ? 0 : 2 },
    organizerCtx
  );
}

async function playRoundConcurrent(organizerCtx, bracketId, bracketSide, bracketRound, concurrency) {
  const ready = await Match.find({
    bracketId,
    bracketSide,
    bracketRound,
    status: "PENDING",
    player1Id: { $ne: null },
    player2Id: { $ne: null },
  }).select("_id player1Id player2Id").lean();
  if (ready.length === 0) return 0;
  await mapConcurrent(ready, m => reportDeterministic(organizerCtx, m._id, m.player1Id, m.player2Id), concurrency);
  return ready.length;
}

async function main() {
  await connectToDatabase();
  const t0 = Date.now();

  const organizer = await Player.findOne({ tag: "ikzilion" });
  if (!organizer) throw new Error("Organizer 'ikzilion' not found -- expected to already exist");
  const stressPlayers = await Player.find({ tag: /^StressPlayer/i }).sort({ tag: 1 });
  if (stressPlayers.length !== 700) throw new Error(`Expected 700 StressPlayer docs, found ${stressPlayers.length}`);
  console.log(`Found organizer (${organizer.tag}) and ${stressPlayers.length} StressPlayer accounts.`);

  const tournament = await Tournament.create({
    name: "700-Entrant Stress Test (Standard Bracket)",
    game: "Street Fighter 6",
    format: "Standard Bracket",
    organizers: [organizer._id],
    startDate: new Date(),
    entrantCount: 701,
    isExample: true,
  });
  console.log(`Created tournament ${tournament._id}`);

  const allPlayerIds = [organizer._id, ...stressPlayers.map(p => p._id)];
  await Entrant.insertMany(
    allPlayerIds.map(playerId => ({ playerId, tournamentId: tournament._id })),
    { ordered: false }
  );
  console.log(`Inserted ${allPlayerIds.length} entrants.`);

  await Tournament.findByIdAndUpdate(tournament._id, { status: "LIVE" });
  const organizerCtx = { playerId: organizer._id.toString(), role: "USER" };

  const bracket = await resolvers.Mutation.generateBracket(
    null,
    { tournamentId: tournament._id.toString(), seedingMethod: "RANDOM" },
    organizerCtx
  );
  console.log(`generateBracket: size ${bracket.size}.`);

  let totalPlayed = 0;
  for (let round = 1; round <= 40; round++) {
    const wbPlayed = await playRoundConcurrent(organizerCtx, bracket.id, "WINNERS", round, 8);
    const lbPlayed = await playRoundConcurrent(organizerCtx, bracket.id, "LOSERS", round, 8);
    totalPlayed += wbPlayed + lbPlayed;
    console.log(`  Round ${round}: ${wbPlayed} WB + ${lbPlayed} LB matches played.`);
    if (wbPlayed === 0 && lbPlayed === 0) break;
  }

  const gf = await Match.findOne({ bracketId: bracket.id, bracketSide: "GRAND_FINAL" });
  if (gf && gf.status === "PENDING" && gf.player1Id && gf.player2Id) {
    await reportDeterministic(organizerCtx, gf._id, gf.player1Id, gf.player2Id);
    totalPlayed++;
    console.log("Grand Final reported.");
  }
  // Defensive check, not expected to fire (see reasoning above) -- this
  // project has a documented history of a finishing script wrongly
  // assuming a bracket was decided, so verify rather than assume.
  const gfReset = await Match.findOne({ bracketId: bracket.id, bracketSide: "GRAND_FINAL_RESET" });
  if (gfReset && gfReset.status === "PENDING" && gfReset.player1Id && gfReset.player2Id) {
    await reportDeterministic(organizerCtx, gfReset._id, gfReset.player1Id, gfReset.player2Id);
    totalPlayed++;
    console.log("Grand Final Reset reported.");
  }

  await Tournament.findByIdAndUpdate(tournament._id, { status: "ENDED" });

  const finalMatchCount = await Match.countDocuments({ tournamentId: tournament._id });
  const finalEntrantCount = await Entrant.countDocuments({ tournamentId: tournament._id });
  console.log(`\nDONE in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log(`Tournament ID: ${tournament._id}`);
  console.log(`Final counts: ${finalMatchCount} matches (${totalPlayed} reported), ${finalEntrantCount} entrants, status ENDED.`);
  console.log(`URL: https://www.fgc-ranks.com/tournaments/${tournament._id}`);

  process.exit(0);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
