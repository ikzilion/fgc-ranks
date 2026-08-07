// scripts/setupModelBTop24Verification.mjs
//
// Disposable verification tournament for the new Model B Top 24/Top 8
// roster tabs (PoolsSection.tsx's computeModelBRoundLiveEntrants). Our
// existing 85-pool Model B tournament is already ENDED (mainBracketId set),
// so its Top24/Top8 tabs are correctly gated OFF (!hasMainBracket) — there's
// no way to see them there. This creates a small (~150-entrant, safely over
// Model B's 128 minimum) tournament and plays it INCREMENTALLY, stopping the
// moment the live count first crosses the given target, so the tab's
// appearance/disappearance at each real threshold can be checked live rather
// than just jumping straight to a fully-decided end state.
//
// Idempotent by name -- run once with TARGET=24 (stops once live count first
// drops to <=24, while still >8, to check Top 24 appears / Top 8 doesn't
// yet), do the live browser check, then run again with TARGET=8 (same
// tournament, continues playing from where it left off) to check Top 8 also
// appears. Direct-to-Mongo, same connectToDatabase()-capped-pool + real
// generateModelBPools resolver approach as the earlier stress-test scripts.
//
// Run: TARGET=24 npx tsx scripts/setupModelBTop24Verification.mjs
//      TARGET=8  npx tsx scripts/setupModelBTop24Verification.mjs

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

const TARGET = parseInt(process.env.TARGET ?? "24", 10);

const { connectToDatabase } = await import("../lib/db.ts");
const { Player } = await import("../models/Player.ts");
const { Tournament, TournamentStatus } = await import("../models/Tournament.ts");
const { Entrant } = await import("../models/Entrant.ts");
const { Match } = await import("../models/Match.ts");
const { Pool } = await import("../models/Pool.ts");
const { Bracket } = await import("../models/Bracket.ts");
const { advanceBracketMatch } = await import("../lib/bracket.ts");
const { resolvers } = await import("../graphql/resolvers/index.ts");
const { createLoaders } = await import("../graphql/loaders");
const mongoose = (await import("mongoose")).default;

const TOURNAMENT_NAME = "TEMP - Top24 Model B Verification (safe to delete)";
const NUM_ENTRANTS = 150;

// Mirrors PoolsSection.tsx's computeModelBRoundLiveEntrants exactly
// (post requiredLossesToEliminate fix), against real DB state instead of
// GraphQL response shape.
async function currentRoundLiveCount(tournamentId, latestRound) {
  const roundPools = await Pool.find({ tournamentId, roundNumber: latestRound });
  let live = 0;
  for (const pool of roundPools) {
    const bracket = await Bracket.findOne({ poolId: pool._id });
    const losses = new Map();
    const enteredViaWinners = new Set();
    if (bracket) {
      const allMatches = await Match.find({ bracketId: bracket._id });
      for (const m of allMatches) {
        if (m.bracketSide !== "WINNERS") continue;
        if (m.player1Id) enteredViaWinners.add(m.player1Id.toString());
        if (m.player2Id) enteredViaWinners.add(m.player2Id.toString());
      }
      for (const m of allMatches) {
        if (m.status !== "COMPLETED" || !m.winnerId) continue;
        const loserId = (m.winnerId.toString() === m.player1Id?.toString() ? m.player2Id : m.player1Id)?.toString();
        if (!loserId) continue;
        losses.set(loserId, (losses.get(loserId) ?? 0) + 1);
      }
    }
    const entrants = await Entrant.find({ _id: { $in: pool.entrantIds } });
    for (const entrant of entrants) {
      const playerId = entrant.playerId.toString();
      const requiredLossesToEliminate = enteredViaWinners.has(playerId) ? 2 : 1;
      if ((losses.get(playerId) ?? 0) < requiredLossesToEliminate) live++;
    }
  }
  return live;
}

async function main() {
  await connectToDatabase();

  const organizerPlayer = await Player.findOne({ tag: "ikzilion" });
  if (!organizerPlayer) throw new Error('Could not find "ikzilion" — aborting.');

  let tournament = await Tournament.findOne({ name: TOURNAMENT_NAME });
  if (!tournament) {
    console.log("Creating new verification tournament...");
    const stressPlayers = await Player.find({ tag: /^StressPlayer\d{4}$/ }).limit(NUM_ENTRANTS);
    if (stressPlayers.length < NUM_ENTRANTS) throw new Error(`Only found ${stressPlayers.length} StressPlayer accounts, need ${NUM_ENTRANTS}.`);
    const allPlayers = [organizerPlayer, ...stressPlayers];

    tournament = await Tournament.create({
      name: TOURNAMENT_NAME,
      game: "Street Fighter 6",
      format: "Pools + Bracket",
      poolModel: "B",
      status: TournamentStatus.LIVE,
      organizers: [organizerPlayer._id],
      startDate: new Date(),
      entrantCount: allPlayers.length,
    });
    await Entrant.insertMany(allPlayers.map(p => ({ playerId: p._id, tournamentId: tournament._id })));

    const organizerCtx = { playerId: organizerPlayer._id.toString(), role: "SUPER_ADMIN" };
    const pools = await resolvers.Mutation.generateModelBPools(null, { tournamentId: tournament._id.toString() }, organizerCtx);
    console.log(`generateModelBPools: ${pools.length} pools.`);
  } else {
    console.log(`Reusing existing verification tournament ${tournament._id}.`);
  }

  let latestRoundAgg = await Pool.find({ tournamentId: tournament._id }).sort({ roundNumber: -1 }).limit(1);
  let latestRound = latestRoundAgg[0]?.roundNumber ?? 1;
  let live = await currentRoundLiveCount(tournament._id, latestRound);
  console.log(`Current round ${latestRound} live count: ${live}. Target: <=${TARGET}.`);

  const organizerCtx = { playerId: organizerPlayer._id.toString(), role: "SUPER_ADMIN" };

  while (live > TARGET) {
    const roundPools = await Pool.find({ tournamentId: tournament._id, roundNumber: latestRound });
    const bracketIds = (await Bracket.find({ poolId: { $in: roundPools.map(p => p._id) } }).select("_id")).map(b => b._id);
    const ready = await Match.find({ bracketId: { $in: bracketIds }, status: "PENDING", player1Id: { $ne: null }, player2Id: { $ne: null } }).limit(20);

    if (ready.length === 0) {
      // This round has hit its own floor (each fully-decided normal pool
      // always converges to exactly 1 survivor -- see PoolsSection.tsx's
      // computeModelBRoundLiveEntrants; a round's live-count floor is its
      // own pool count). Genuinely can't narrow further within this round
      // -- advance to the next (fewer, larger) round instead.
      console.log(`Round ${latestRound} has hit its own floor (${live} = pool count, every pool fully decided) — advancing to the next round.`);
      const newPools = await resolvers.Mutation.advanceModelBRound(null, { tournamentId: tournament._id.toString() }, { ...organizerCtx, loaders: createLoaders() });
      if (newPools.length === 0) {
        const fresh = await Tournament.findById(tournament._id).select("mainBracketId");
        console.log(fresh.mainBracketId ? "Advanced straight to the real Finals bracket -- no further pool round to narrow within." : "advanceModelBRound returned no new pools unexpectedly.");
        break;
      }
      latestRound = newPools[0].roundNumber;
      live = await currentRoundLiveCount(tournament._id, latestRound);
      console.log(`Round ${latestRound}: ${newPools.length} pools, live count ${live}.`);
      continue;
    }

    for (const match of ready) {
      const player1Wins = Math.random() < 0.5;
      const winnerId = player1Wins ? match.player1Id : match.player2Id;
      const loserId = player1Wins ? match.player2Id : match.player1Id;
      const updated = await Match.findByIdAndUpdate(
        match._id,
        { player1Score: player1Wins ? 2 : 0, player2Score: player1Wins ? 0 : 2, winnerId, status: "COMPLETED" },
        { new: true }
      );
      await advanceBracketMatch(updated, winnerId, loserId);
    }
    live = await currentRoundLiveCount(tournament._id, latestRound);
    console.log(`  Played ${ready.length} match(es). Live count now: ${live}.`);
  }

  console.log(`\nFinal live count: ${live} (target <=${TARGET}).`);
  console.log(`Tournament: ${tournament._id}`);
  console.log(`Detail page: http://localhost:3000/tournaments/${tournament._id}`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async err => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
