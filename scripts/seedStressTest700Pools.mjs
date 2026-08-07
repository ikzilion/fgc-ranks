// scripts/seedStressTest700Pools.mjs
//
// Follow-up to scripts/seedStressTest700.mjs (the bracket-only 700-entrant
// stress test) -- same 700 real StressPlayer players and the ikzilion
// organizer, reused as-is, but this time on the "Pools + Bracket" format
// with Pool format Model B (EVO-style continuous carry-over): purpose-built
// for this entrant range (min. 128), and per the archived scale-timing data
// (7,683 entrants hit 87.6% of the Vercel Hobby 300s ceiling on the Round
// 1->2 advance call; ~1,180 pools is the real crossover into failure), 700
// entrants (~47 initial pools) is nowhere near that margin.
//
// Same approach as before: direct-to-Mongo via connectToDatabase() (capped
// maxPoolSize: 5), bypassing register/createTournament for the same
// rate-limit reasons. Pool/bracket GENERATION is done via the REAL
// generateModelBPools/advanceModelBRound resolvers (graphql/resolvers/
// index.ts), exactly as scripts/loadTestModelBScale.mjs already validated --
// not reimplemented. Individual MATCH progression within each pool/the
// Finals bracket reuses advanceBracketMatch (lib/bracket.ts) directly with a
// lightweight Player $inc, same lighter-weight choice
// scripts/seedStressTest700.mjs made over the full reportResult resolver
// (which would also re-run a whole-tournament points recompute on every
// single match -- at Model B's match volume across multiple pool rounds,
// that recompute-per-match cost would make the run dramatically slower for
// no benefit here; extractPoolSurvivors/advanceModelBRound only ever read
// Match.status/winnerId, never Player stats).
//
// Run: npx tsx scripts/seedStressTest700Pools.mjs

import fs from "fs";
import path from "path";
import { Types } from "mongoose";

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

const { connectToDatabase } = await import("../lib/db.ts");
const { Player } = await import("../models/Player.ts");
const { Tournament, TournamentStatus } = await import("../models/Tournament.ts");
const { Entrant } = await import("../models/Entrant.ts");
const { Match } = await import("../models/Match.ts");
const { Bracket } = await import("../models/Bracket.ts");
const { Pool } = await import("../models/Pool.ts");
const { advanceBracketMatch } = await import("../lib/bracket.ts");
const { resolvers } = await import("../graphql/resolvers/index.ts");
const { createLoaders } = await import("../graphql/loaders");
const mongoose = (await import("mongoose")).default;

const TOURNAMENT_NAME = "700-Entrant Stress Test (Pools + Bracket, Model B)";
const GAME = "Street Fighter 6";

function loserScore() {
  return Math.random() < 0.5 ? 0 : 1;
}

// Same generic function as seedStressTest700.mjs -- plays every currently
// ready match in a bracket to completion, regardless of bracketSide, so it
// works unchanged for a pool bracket, a Finals-cutoff bracket (no Grand
// Final by design), or the real top-level Finals bracket.
async function playEntireBracket(bracketId) {
  let totalPlayed = 0;
  let pass = 0;
  while (true) {
    const ready = await Match.find({
      bracketId,
      status: "PENDING",
      player1Id: { $ne: null },
      player2Id: { $ne: null },
    });
    if (ready.length === 0) break;
    pass++;

    for (const match of ready) {
      const player1Wins = Math.random() < 0.5;
      const winnerId = player1Wins ? match.player1Id : match.player2Id;
      const loserId = player1Wins ? match.player2Id : match.player1Id;
      const lScore = loserScore();

      const updated = await Match.findByIdAndUpdate(
        match._id,
        {
          player1Score: player1Wins ? 2 : lScore,
          player2Score: player1Wins ? lScore : 2,
          winnerId,
          status: "COMPLETED",
        },
        { new: true }
      );

      await Player.findByIdAndUpdate(winnerId, { $inc: { wins: 1, points: 100 } });
      await Player.findByIdAndUpdate(loserId, { $inc: { losses: 1 } });

      await advanceBracketMatch(updated, winnerId, loserId);
      totalPlayed++;
    }

    if (pass > 100) throw new Error(`playEntireBracket(${bracketId}): 100 passes without resolving -- aborting.`);
  }
  return totalPlayed;
}

// Plays every pool bracket for the given Pool documents (sequentially --
// maxPoolSize: 5 means real concurrency headroom is thin, and this is a
// one-off creation script, not a latency-sensitive path).
async function playAllPoolBrackets(pools) {
  const bracketDocs = await Bracket.find({ poolId: { $in: pools.map(p => p._id) } }).select("_id").lean();
  let totalMatches = 0;
  for (const b of bracketDocs) {
    totalMatches += await playEntireBracket(b._id);
  }
  return { poolsPlayed: bracketDocs.length, totalMatches };
}

async function main() {
  const t0 = Date.now();
  await connectToDatabase();

  // ── 1. Organizer — same ikzilion account as the bracket-only run ──────
  const organizerPlayer = await Player.findOne({ tag: "ikzilion" });
  if (!organizerPlayer) throw new Error('Could not find a Player tagged "ikzilion" (SUPER_ADMIN) — aborting.');
  const organizerCtx = { playerId: organizerPlayer._id.toString(), role: "SUPER_ADMIN" };
  console.log(`Organizer: ${organizerPlayer.tag} (${organizerPlayer._id})`);

  // ── 2. Reuse the existing 700 StressPlayer players — no regeneration ──
  const stressPlayers = await Player.find({ tag: /^StressPlayer\d{4}$/ });
  if (stressPlayers.length !== 700) {
    throw new Error(`Expected 700 existing StressPlayer players, found ${stressPlayers.length} — aborting.`);
  }
  console.log(`Reusing ${stressPlayers.length} existing StressPlayer players.`);

  const allPlayers = [organizerPlayer, ...stressPlayers];

  // ── 3. Tournament — Pools + Bracket, Model B ───────────────────────────
  const tournament = await Tournament.create({
    name: TOURNAMENT_NAME,
    game: GAME,
    format: "Pools + Bracket",
    poolModel: "B",
    status: TournamentStatus.LIVE,
    organizers: [organizerPlayer._id],
    startDate: new Date(),
    entrantCount: allPlayers.length,
  });
  const tournamentId = tournament._id.toString();
  console.log(`Tournament created: ${tournament._id} (${allPlayers.length} entrants, format=Pools + Bracket, poolModel=B)`);

  // ── 4. Entrants (new set scoped to this tournament — a Player can be an
  //      entrant in multiple tournaments, no conflict with the first run) ──
  await Entrant.insertMany(allPlayers.map(p => ({ playerId: p._id, tournamentId: tournament._id })));

  // ── 5. Round 1 — real generateModelBPools resolver ─────────────────────
  let t1 = Date.now();
  let currentPools = await resolvers.Mutation.generateModelBPools(null, { tournamentId }, organizerCtx);
  console.log(`generateModelBPools: ${currentPools.length} pools in ${Date.now() - t1}ms.`);

  const roundLog = [];
  let roundNumber = 1;
  let finalsBracketId = null;

  // ── 6. Play every pool round, advance, repeat until the real Finals
  //      bracket is generated (Tournament.mainBracketId set) ─────────────
  while (true) {
    const playStart = Date.now();
    const { poolsPlayed, totalMatches } = await playAllPoolBrackets(currentPools);
    const playMs = Date.now() - playStart;
    console.log(`Round ${roundNumber}: played ${totalMatches} match(es) across ${poolsPlayed} pool(s) in ${(playMs / 1000).toFixed(1)}s.`);

    const advStart = Date.now();
    const newPools = await resolvers.Mutation.advanceModelBRound(null, { tournamentId }, { ...organizerCtx, loaders: createLoaders() });
    const advMs = Date.now() - advStart;
    console.log(`  advanceModelBRound: ${newPools.length} new pool(s) in ${advMs}ms.`);

    roundLog.push({ round: roundNumber, poolsPlayed, totalMatches, playMs, advanceMs: advMs, newPoolCount: newPools.length });

    const freshTournament = await Tournament.findById(tournamentId).select("mainBracketId");
    if (freshTournament.mainBracketId) {
      finalsBracketId = freshTournament.mainBracketId;
      console.log(`Real Finals bracket generated: ${finalsBracketId}.`);
      break;
    }
    currentPools = newPools;
    roundNumber++;
  }

  // ── 7. Play the real Finals bracket to a decided Grand Final ───────────
  console.log("Playing the Finals bracket to a winner...");
  const finalsMatches = await playEntireBracket(finalsBracketId);
  console.log(`Finals bracket: ${finalsMatches} match(es) played.`);

  // ── 8. Mark ENDED ────────────────────────────────────────────────────
  await Tournament.findByIdAndUpdate(tournamentId, { status: TournamentStatus.ENDED });

  const totalPoolCount = await Pool.countDocuments({ tournamentId });
  const totalMatchCount = await Match.countDocuments({ tournamentId });
  const completedMatchCount = await Match.countDocuments({ tournamentId, status: "COMPLETED" });
  const placedCount = await Entrant.countDocuments({ tournamentId, placement: { $ne: null } });

  const elapsedMs = Date.now() - t0;
  console.log(`\nPer-round summary:`);
  console.table(roundLog);
  console.log(`Total pools across all rounds: ${totalPoolCount}`);
  console.log(`${completedMatchCount}/${totalMatchCount} matches completed.`);
  console.log(`${placedCount}/${allPlayers.length} entrants received an automatic placement.`);
  console.log(`Elapsed: ${elapsedMs}ms (${(elapsedMs / 1000).toFixed(1)}s)`);

  console.log("\n=== Done ===");
  console.log(`Tournament: ${tournament._id}`);
  console.log(`Detail page: https://fgc-ranks.com/tournaments/${tournament._id}`);
  console.log(`Stream view: https://fgc-ranks.com/tournaments/${tournament._id}/stream`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async err => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
