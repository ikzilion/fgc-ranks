// scripts/seedStressTest700.mjs
//
// Backlog item: "Create a real 700+ entrant test tournament, every match
// played to a winner, to see how pools and brackets actually look/scale at
// that size" — run only after the production test-data cleanup ahead of it
// (scripts/cleanupTestData.mjs, already run 2026-07-31).
//
// Same approach as scripts/seedBracketSimulation.js (direct-to-Mongo via the
// app's own Mongoose models + real lib/bracket.ts generation/progression
// logic, bypassing register/createTournament entirely — registerRateLimit is
// 3 accounts/hour/IP and createTournamentRateLimit is 5/day/playerId, both a
// non-starter at 700-entrant scale), but:
//   - uses connectToDatabase() from lib/db.ts (capped maxPoolSize: 5) instead
//     of seedBracketSimulation.js's bare mongoose.connect() (which left the
//     100-socket default live — the exact gap fa3dc7b's fix didn't close for
//     seed scripts).
//   - bulk-inserts the 700 players instead of one-at-a-time.
//   - plays EVERY round through to a decided Grand Final (Reset included if
//     it triggers), not just a partial simulation — advanceBracketMatch
//     (lib/bracket.ts) auto-computes final placements once that happens, so
//     no separate placement step is needed.
//
// Run: npx tsx scripts/seedStressTest700.mjs

import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
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
const { User } = await import("../models/User.ts");
const { Player } = await import("../models/Player.ts");
const { Tournament, TournamentStatus } = await import("../models/Tournament.ts");
const { Entrant } = await import("../models/Entrant.ts");
const { Match } = await import("../models/Match.ts");
const { Bracket } = await import("../models/Bracket.ts");
const { buildDoubleEliminationBracket, resolveSeedOrder, advanceBracketMatch, nextPowerOfTwo } = await import("../lib/bracket.ts");
const mongoose = (await import("mongoose")).default;

const STRESS_PASSWORD = "TestPass123!";
const NUM_ENTRANTS = 700;
const TOURNAMENT_NAME = "700-Entrant Stress Test";
const GAME = "Street Fighter 6";

function loserScore() {
  return Math.random() < 0.5 ? 0 : 1;
}

// Reports every currently-ready match across the WHOLE bracket (any
// bracketSide/round) in one pass, then loops until nothing is left ready —
// unlike seedBracketSimulation.js's playRound (one round at a time, partial
// on purpose), this drives the bracket all the way to a decided Grand Final
// (and Reset, if triggered), since the backlog explicitly wants every match
// played to a winner.
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

    console.log(`  Pass ${pass}: played ${ready.length} match(es) (${totalPlayed} total so far).`);

    // Safety valve — a real double-elim bracket for 700 entrants resolves in
    // well under 50 passes; this only fires if something is stuck.
    if (pass > 100) throw new Error("playEntireBracket: 100 passes without resolving — aborting, something is stuck.");
  }
  return totalPlayed;
}

async function main() {
  const t0 = Date.now();
  await connectToDatabase();

  // ── 1. Organizer — reuse the existing SUPER_ADMIN account (ikzilion),
  //      same "find, don't fabricate a near-duplicate" precedent as
  //      seedBracketSimulation.js used for Jmorales. ──────────────────────
  const organizerPlayer = await Player.findOne({ tag: "ikzilion" });
  if (!organizerPlayer) {
    throw new Error('Could not find a Player tagged "ikzilion" (SUPER_ADMIN) — aborting.');
  }
  console.log(`Organizer: ${organizerPlayer.tag} (${organizerPlayer._id})`);

  // ── 2. 700 stress-test players, bulk-inserted ───────────────────────────
  console.log(`Creating ${NUM_ENTRANTS} stress-test players...`);
  const passwordHash = await bcrypt.hash(STRESS_PASSWORD, 10);
  const tags = Array.from({ length: NUM_ENTRANTS }, (_, i) => `StressPlayer${String(i + 1).padStart(4, "0")}`);

  const userDocs = tags.map(tag => ({ email: `${tag.toLowerCase()}@example.com`, passwordHash }));
  const insertedUsers = await User.insertMany(userDocs, { ordered: false });

  const playerDocs = insertedUsers.map((user, i) => ({
    userId: user._id,
    tag: tags[i],
    points: Math.floor(Math.random() * 500), // spread for RANDOM_WITHIN_TIERS to tier by
  }));
  const insertedPlayers = await Player.insertMany(playerDocs, { ordered: false });

  await User.bulkWrite(
    insertedPlayers.map(player => ({
      updateOne: { filter: { _id: player.userId }, update: { playerId: player._id } },
    }))
  );
  console.log(`${insertedPlayers.length} stress-test players ready.`);

  const allPlayers = [organizerPlayer, ...insertedPlayers];

  // ── 3. Tournament — organizer as creator, LIVE (flipped to ENDED once the
  //      bracket is fully decided, matching the app's own lifecycle) ──────
  const tournament = await Tournament.create({
    name: TOURNAMENT_NAME,
    game: GAME,
    status: TournamentStatus.LIVE,
    organizers: [organizerPlayer._id],
    startDate: new Date(),
    entrantCount: allPlayers.length,
  });
  console.log(`Tournament created: ${tournament._id} (${allPlayers.length} entrants)`);

  // ── 4. Entrants ──────────────────────────────────────────────────────
  const entrants = await Entrant.insertMany(
    allPlayers.map(p => ({ playerId: p._id, tournamentId: tournament._id }))
  );

  // ── 5. Generate bracket — mirrors the generateBracket resolver exactly,
  //      same imported functions, RANDOM_WITHIN_TIERS seeding ──────────
  const orderedPlayerIds = await resolveSeedOrder("RANDOM_WITHIN_TIERS", entrants);
  await Promise.all(
    orderedPlayerIds.map((pid, i) => Entrant.updateOne({ tournamentId: tournament._id, playerId: pid }, { seed: i + 1 }))
  );

  const bracketId = new Types.ObjectId();
  const { matches } = buildDoubleEliminationBracket({ tournamentId: tournament._id, bracketId, orderedPlayerIds });

  await Bracket.create({
    _id: bracketId,
    tournamentId: tournament._id,
    seedingMethod: "RANDOM_WITHIN_TIERS",
    seedOrder: orderedPlayerIds,
    size: nextPowerOfTwo(orderedPlayerIds.length),
  });
  await Match.insertMany(matches);
  console.log(`Bracket generated: ${matches.length} initial matches, size ${nextPowerOfTwo(orderedPlayerIds.length)}.`);

  // ── 6. Play EVERY match through to a decided Grand Final ──────────────
  console.log("Playing every match to a winner...");
  const totalPlayed = await playEntireBracket(bracketId);

  const totalMatchCount = await Match.countDocuments({ bracketId });
  const completedCount = await Match.countDocuments({ bracketId, status: "COMPLETED" });

  // ── 7. Mark the tournament ENDED now that the bracket is fully decided ──
  await Tournament.findByIdAndUpdate(tournament._id, { status: TournamentStatus.ENDED });

  const placedCount = await Entrant.countDocuments({ tournamentId: tournament._id, placement: { $ne: null } });

  const elapsedMs = Date.now() - t0;
  console.log(`\n${completedCount}/${totalMatchCount} matches completed (${totalPlayed} reported across the run).`);
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
