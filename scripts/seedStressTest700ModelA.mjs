// scripts/seedStressTest700ModelA.mjs
//
// Visual-inspection test tournament for Pool format Model A (round-robin
// pools), at the same 700-entrant real scale as the existing
// "700-Entrant Stress Test" (standard bracket) and "...Model B" tournaments
// -- created to let every bracket format the app supports be visually
// inspected at real scale (Aug 1, 2026). REUSES the 700 real StressPlayer
// Player docs already in the DB from the earlier stress tests (no new
// players created) plus the real ikzilion account as organizer+entrant,
// same convention as those two tournaments (701 real entrants total).
//
// Direct-to-Mongo via connectToDatabase() (capped maxPoolSize: 5, same as
// every other stress/load-test script), calling the REAL
// generatePools/reportResult/generateMainBracket resolvers (graphql/
// resolvers/index.ts) against the real production database -- bypasses
// register/createTournament entirely (their rate limiters are a
// non-starter at this scale, same reasoning as the original stress test).
//
// Unlike scripts/loadTestModelBScale.mjs (which always deletes its test
// tournaments at the end -- it's a load/timing test, not a fixture), this
// script PERSISTS the tournament: goal is a real, permanently-ENDED
// tournament a human can actually open and look at.
//
// Run: npx tsx scripts/seedStressTest700ModelA.mjs

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
const { Pool } = await import("../models/Pool");
const { resolvers } = await import("../graphql/resolvers/index");
const { createLoaders } = await import("../graphql/loaders");

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

async function main() {
  await connectToDatabase();
  const t0 = Date.now();

  const organizer = await Player.findOne({ tag: "ikzilion" });
  if (!organizer) throw new Error("Organizer 'ikzilion' not found -- expected to already exist");
  const stressPlayers = await Player.find({ tag: /^StressPlayer/i }).sort({ tag: 1 });
  if (stressPlayers.length !== 700) throw new Error(`Expected 700 StressPlayer docs, found ${stressPlayers.length}`);
  console.log(`Found organizer (${organizer.tag}) and ${stressPlayers.length} StressPlayer accounts.`);

  const tournament = await Tournament.create({
    name: "700-Entrant Stress Test (Pools + Bracket, Model A)",
    game: "Street Fighter 6",
    format: "Pools + Bracket",
    poolModel: "A",
    organizers: [organizer._id],
    startDate: new Date(),
    entrantCount: 701,
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

  // ── Generate pools (Model A: round-robin, no per-pool Bracket) ──
  const pools = await resolvers.Mutation.generatePools(null, { tournamentId: tournament._id.toString() }, organizerCtx);
  console.log(`generatePools: ${pools.length} round-robin pools created.`);

  // ── Play every pool's round-robin matches to completion ──
  // Model A matches have no bracketId/round structure to walk -- every
  // match in a pool is independent and already exists up front (see
  // buildRoundRobinMatches, lib/roundRobin.ts), so just report every
  // PENDING match directly. Deterministic "lower playerId wins" convention
  // (arbitrary but consistent) so standings have a real, reproducible
  // winner/tiebreak shape rather than one seeded by Math.random.
  const allMatches = await Match.find({ poolId: { $in: pools.map(p => p._id) }, status: "PENDING" }).select("_id player1Id player2Id").lean();
  console.log(`Playing ${allMatches.length} round-robin matches...`);
  let played = 0;
  await mapConcurrent(
    allMatches,
    async m => {
      const player1Wins = m.player1Id.toString() < m.player2Id.toString();
      await resolvers.Mutation.reportResult(
        null,
        { matchId: m._id.toString(), player1Score: player1Wins ? 2 : 0, player2Score: player1Wins ? 0 : 2 },
        organizerCtx
      );
      played++;
      if (played % 500 === 0) console.log(`  ${played}/${allMatches.length} matches reported...`);
    },
    8
  );
  console.log(`All ${played} round-robin matches reported.`);

  // ── Generate + play the main (top-cut) bracket ──
  const mainBracket = await resolvers.Mutation.generateMainBracket(
    null,
    { tournamentId: tournament._id.toString(), seedingMethod: "RANDOM" },
    { ...organizerCtx, loaders: createLoaders() }
  );
  console.log(`generateMainBracket: size ${mainBracket.size}, ${pools.length * 2} finalists seeded.`);

  for (let round = 1; round <= 14; round++) {
    let playedThisRound = 0;
    for (const side of ["WINNERS", "LOSERS"]) {
      const ready = await Match.find({
        bracketId: mainBracket.id,
        bracketSide: side,
        bracketRound: round,
        status: "PENDING",
        player1Id: { $ne: null },
        player2Id: { $ne: null },
      }).select("_id player1Id player2Id").lean();
      for (const m of ready) {
        const player1Wins = m.player1Id.toString() < m.player2Id.toString();
        await resolvers.Mutation.reportResult(
          null,
          { matchId: m._id.toString(), player1Score: player1Wins ? 2 : 0, player2Score: player1Wins ? 0 : 2 },
          organizerCtx
        );
        playedThisRound++;
      }
    }
    console.log(`  Main bracket round ${round}: ${playedThisRound} matches played.`);
    if (playedThisRound === 0) break;
  }

  const gf = await Match.findOne({ bracketId: mainBracket.id, bracketSide: "GRAND_FINAL" });
  if (gf && gf.status === "PENDING" && gf.player1Id && gf.player2Id) {
    const player1Wins = gf.player1Id.toString() < gf.player2Id.toString();
    await resolvers.Mutation.reportResult(
      null,
      { matchId: gf._id.toString(), player1Score: player1Wins ? 2 : 0, player2Score: player1Wins ? 0 : 2 },
      organizerCtx
    );
    console.log("Grand Final reported -- main bracket decided.");
  }

  await Tournament.findByIdAndUpdate(tournament._id, { status: "ENDED" });

  const finalPoolCount = await Pool.countDocuments({ tournamentId: tournament._id });
  const finalMatchCount = await Match.countDocuments({ tournamentId: tournament._id });
  const finalEntrantCount = await Entrant.countDocuments({ tournamentId: tournament._id });
  console.log(`\nDONE in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log(`Tournament ID: ${tournament._id}`);
  console.log(`Final counts: ${finalPoolCount} pools, ${finalMatchCount} matches, ${finalEntrantCount} entrants, status ENDED.`);
  console.log(`URL: https://www.fgc-ranks.com/tournaments/${tournament._id}`);

  process.exit(0);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
