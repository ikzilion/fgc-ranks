// scripts/seedBracketSimulation.js
//
// One-off seed script: builds a 30-entrant, in-progress LIVE tournament for
// visually testing the bracket / connector-line rendering (TO, public, and
// stream views) across a bracket large enough to have real depth.
//
// Writes directly to MongoDB via the app's own Mongoose models + the real
// lib/bracket.ts generation/progression logic (imported, not re-implemented)
// — this deliberately does NOT go through the GraphQL register mutation,
// since register/login are IP rate-limited (3 accounts/hour) and creating 29
// accounts that way would trip it. Direct DB writes are the correct way to
// seed legitimate test data outside that path.
//
// Run: npx tsx scripts/seedBracketSimulation.js
// (plain Node can't `import` these TS source files — tsx handles both the
// TypeScript syntax and the "@/*" path alias used inside lib/bracket.ts.)

import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import mongoose, { Types } from "mongoose";
import { User } from "../models/User";
import { Player } from "../models/Player";
import { Tournament, TournamentStatus } from "../models/Tournament";
import { Entrant } from "../models/Entrant";
import { Match } from "../models/Match";
import { Bracket } from "../models/Bracket";
import { buildDoubleEliminationBracket, resolveSeedOrder, advanceBracketMatch, nextPowerOfTwo } from "../lib/bracket";

// This script runs standalone via tsx, outside Next.js's own env loading, so
// .env.local needs to be parsed manually. Assumes it's run from the project
// root (as shown in the usage comment above).
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

const SIM_PASSWORD = "TestPass123!";
const NUM_SIM_PLAYERS = 29;
const TOURNAMENT_NAME = "Community Showdown";
const GAME = "Street Fighter 6";

// Winner always takes it 2-something — a plausible best-of-3 result.
function loserScore() {
  return Math.random() < 0.5 ? 0 : 1;
}

// Reports every currently-ready (both slots filled, still PENDING) match on
// one bracket side/round, mirroring reportResult's core effect (score,
// winner, player wins/losses/points) and then calling the same
// advanceBracketMatch() the real resolver uses so progression stays correct.
async function playRound(bracketId, bracketSide, bracketRound) {
  const ready = await Match.find({
    bracketId,
    bracketSide,
    bracketRound,
    status: "PENDING",
    player1Id: { $ne: null },
    player2Id: { $ne: null },
  });

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
  }

  console.log(`  Played ${ready.length} ${bracketSide} round ${bracketRound} match(es).`);
}

async function main() {
  loadEnvLocal();
  if (!process.env.MONGODB_URI) throw new Error("Missing MONGODB_URI (checked .env.local)");
  await mongoose.connect(process.env.MONGODB_URI);

  // ── 1. Organizer ────────────────────────────────────────────────────
  // The task referred to this account as "Jmorales3", but the only matching
  // account in the DB (confirmed via a production GraphQL lookup before
  // running this script) is tagged "Jmorales" — reusing that rather than
  // creating a near-duplicate. Flagged back to the user in the report.
  const organizerPlayer = await Player.findOne({ tag: "Jmorales" });
  if (!organizerPlayer) {
    throw new Error('Could not find a Player tagged "Jmorales" — aborting. Check the tag and re-run.');
  }
  const organizerUser = await User.findById(organizerPlayer.userId);
  console.log(`Organizer: ${organizerPlayer.tag} (${organizerPlayer._id}), account: ${organizerUser?.email}`);

  // ── 2. 29 sim players (idempotent — safe to re-run) ─────────────────
  const passwordHash = await bcrypt.hash(SIM_PASSWORD, 10);
  const simPlayers = [];
  for (let i = 1; i <= NUM_SIM_PLAYERS; i++) {
    const tag = `SimPlayer${String(i).padStart(2, "0")}`;
    let player = await Player.findOne({ tag });
    if (!player) {
      const email = `${tag.toLowerCase()}@example.com`;
      const user = await User.create({ email, passwordHash });
      const points = Math.floor(Math.random() * 500); // spread for RANDOM_WITHIN_TIERS to tier by
      player = await Player.create({ userId: user._id, tag, points });
      await User.findByIdAndUpdate(user._id, { playerId: player._id });
    }
    simPlayers.push(player);
  }
  console.log(`${simPlayers.length} sim players ready (SimPlayer01..${String(NUM_SIM_PLAYERS).padStart(2, "0")}).`);

  const allPlayers = [organizerPlayer, ...simPlayers];

  // ── 3. Tournament — Jmorales as creator + first organizer, LIVE ────
  const tournament = await Tournament.create({
    name: TOURNAMENT_NAME,
    game: GAME,
    status: TournamentStatus.LIVE,
    organizers: [organizerPlayer._id],
    startDate: new Date(),
    entrantCount: allPlayers.length,
  });
  console.log(`Tournament created: ${tournament._id}`);

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
  console.log(`Bracket generated: ${matches.length} matches, size ${nextPowerOfTwo(orderedPlayerIds.length)}.`);

  // ── 6. Simulate partial progress: WB Round 1, WB Round 2, and whatever
  //      LB Round 1 that WB Round 1 feeds. Everything past that (WB Round 3+,
  //      LB Round 2+, Grand Final) is left TBD/unplayed on purpose — some of
  //      it will already be "ready to play" once Round 2 resolves, giving a
  //      realistic mid-tournament mix of completed / ready / TBD matches. ──
  console.log("Simulating partial progress...");
  await playRound(bracketId, "WINNERS", 1);
  await playRound(bracketId, "WINNERS", 2);
  await playRound(bracketId, "LOSERS", 1);

  const completedCount = await Match.countDocuments({ bracketId, status: "COMPLETED" });
  const totalCount = await Match.countDocuments({ bracketId });
  console.log(`\n${completedCount}/${totalCount} matches completed, rest TBD/ready-to-play.`);

  console.log("\n=== Done ===");
  console.log(`Tournament: ${tournament._id}`);
  console.log(`Detail page: https://fgc-ranks.vercel.app/tournaments/${tournament._id}`);
  console.log(`Stream view: https://fgc-ranks.vercel.app/tournaments/${tournament._id}/stream`);

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
