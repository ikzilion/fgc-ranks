// scripts/seedStressTest700ModelC.mjs
//
// Visual-inspection test tournament for Pool format Model C (double-elim
// pools, the format default), at the same 700-entrant real scale as the
// existing "700-Entrant Stress Test" (standard bracket) and "...Model B"
// tournaments -- created to let every bracket format the app supports be
// visually inspected at real scale (Aug 1, 2026). REUSES the 700 real
// StressPlayer Player docs already in the DB from the earlier stress tests
// (no new players created) plus the real ikzilion account as
// organizer+entrant, same convention as those two tournaments (701 real
// entrants total).
//
// Direct-to-Mongo via connectToDatabase() (capped maxPoolSize: 5, same as
// every other stress/load-test script), calling the REAL
// generatePools/reportResult/generateMainBracket resolvers (graphql/
// resolvers/index.ts) against the real production database -- bypasses
// register/createTournament entirely (their rate limiters are a
// non-starter at this scale). Pool-bracket play-to-completion pattern
// (playRoundAcrossPools-style) reused from scripts/loadTestModelBScale.mjs,
// but unlike that script (which always deletes its test tournaments after
// measuring), this one PERSISTS the tournament -- goal is a real,
// permanently-ENDED tournament a human can actually open and look at, not
// a timing measurement.
//
// Run: npx tsx scripts/seedStressTest700ModelC.mjs

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
const { Bracket } = await import("../models/Bracket");
const { Pool } = await import("../models/Pool");
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

// Deterministic "lower playerId wins" convention (arbitrary but
// reproducible) -- same rule used across every stress/load-test script in
// this repo (testModelBAdvanceRound.mjs uses a fixed player1-always-wins
// rule; this uses a player-ID comparison since round-robin/pool-bracket
// matches here aren't seeded in a fixed player1/player2 order the way a
// freshly-generated bracket's Round 1 is).
async function playRound(organizerCtx, bracketId, bracketSide, bracketRound) {
  const ready = await Match.find({
    bracketId,
    bracketSide,
    bracketRound,
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
  }
  return ready.length;
}

async function playBracketToCompletion(organizerCtx, bracketId) {
  let total = 0;
  for (let round = 1; round <= 14; round++) {
    const wbPlayed = await playRound(organizerCtx, bracketId, "WINNERS", round);
    const lbPlayed = await playRound(organizerCtx, bracketId, "LOSERS", round);
    total += wbPlayed + lbPlayed;
    if (wbPlayed === 0 && lbPlayed === 0) break;
  }
  const gf = await Match.findOne({ bracketId, bracketSide: "GRAND_FINAL" });
  if (gf && gf.status === "PENDING" && gf.player1Id && gf.player2Id) {
    const player1Wins = gf.player1Id.toString() < gf.player2Id.toString();
    await resolvers.Mutation.reportResult(
      null,
      { matchId: gf._id.toString(), player1Score: player1Wins ? 2 : 0, player2Score: player1Wins ? 0 : 2 },
      organizerCtx
    );
    total++;
  }
  return total;
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
    name: "700-Entrant Stress Test (Pools + Bracket, Model C)",
    game: "Street Fighter 6",
    format: "Pools + Bracket",
    poolModel: "C",
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

  // ── Generate pools (Model C: each pool gets its own double-elim Bracket) ──
  const pools = await resolvers.Mutation.generatePools(null, { tournamentId: tournament._id.toString() }, organizerCtx);
  console.log(`generatePools: ${pools.length} double-elim pools created.`);

  const poolBrackets = await Bracket.find({ tournamentId: tournament._id, poolId: { $in: pools.map(p => p._id) } }).select("_id").lean();
  console.log(`Playing ${poolBrackets.length} pool brackets to completion...`);
  let poolsPlayed = 0;
  await mapConcurrent(
    poolBrackets,
    async b => {
      await playBracketToCompletion(organizerCtx, b._id);
      poolsPlayed++;
      if (poolsPlayed % 20 === 0 || poolsPlayed === poolBrackets.length) {
        console.log(`  ${poolsPlayed}/${poolBrackets.length} pool brackets decided...`);
      }
    },
    8
  );
  console.log(`All ${poolBrackets.length} pool brackets decided.`);

  // ── Generate + play the main (top-cut) bracket ──
  const mainBracket = await resolvers.Mutation.generateMainBracket(
    null,
    { tournamentId: tournament._id.toString(), seedingMethod: "RANDOM" },
    organizerCtx
  );
  console.log(`generateMainBracket: size ${mainBracket.size}, ${pools.length * 2} finalists seeded.`);

  const mainMatches = await playBracketToCompletion(organizerCtx, mainBracket.id);
  console.log(`Main bracket decided: ${mainMatches} matches played.`);

  await Tournament.findByIdAndUpdate(tournament._id, { status: "ENDED" });

  const finalPoolCount = await Pool.countDocuments({ tournamentId: tournament._id });
  const finalBracketCount = await Bracket.countDocuments({ tournamentId: tournament._id });
  const finalMatchCount = await Match.countDocuments({ tournamentId: tournament._id });
  const finalEntrantCount = await Entrant.countDocuments({ tournamentId: tournament._id });
  console.log(`\nDONE in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log(`Tournament ID: ${tournament._id}`);
  console.log(`Final counts: ${finalPoolCount} pools, ${finalBracketCount} brackets, ${finalMatchCount} matches, ${finalEntrantCount} entrants, status ENDED.`);
  console.log(`URL: https://www.fgc-ranks.com/tournaments/${tournament._id}`);

  process.exit(0);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
