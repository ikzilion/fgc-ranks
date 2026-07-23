// scripts/seedPoolsSimulation.js
//
// One-off seed script: builds a persistent, visually-inspectable "Pools +
// Bracket" format tournament in production — every pool played to a real
// Grand Final, main bracket generated and partway through, so the new Pools
// UI (components/PoolsSection.tsx etc.) can be checked in a browser for the
// first time. Mirrors scripts/seedBracketSimulation.js's established
// pattern (direct Mongoose writes for organizer/entrants, since register/
// login are rate-limited and createTournament has a 24h-account-age gate),
// but drives the actual pool-generation/match-report/main-bracket-generation
// flow through the REAL resolver functions (graphql/resolvers/index.ts),
// same as scripts/testPoolsFeature.mjs did for its (cleaned-up) test run —
// this data is meant to STAY, not be deleted after.
//
// Run: npx tsx scripts/seedPoolsSimulation.js
// (plain Node can't `import` these TS source files — tsx handles both the
// TypeScript syntax and the "@/*" path alias used inside lib/bracket.ts.)

// graphql/resolvers/index.ts transitively imports lib/email.ts, which
// constructs `new Resend(process.env.RESEND_API_KEY)` at MODULE LOAD time —
// so .env.local must be loaded before that import even happens. ESM static
// imports are hoisted above any code in this file, so everything that
// (transitively) needs env vars is imported dynamically, after loadEnvLocal()
// runs. fs/path/bcrypt don't read env vars at import time, so those stay as
// normal static imports.
import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";

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
const { User } = await import("../models/User");
const { Player } = await import("../models/Player");
const { Tournament, TournamentStatus } = await import("../models/Tournament");
const { Entrant } = await import("../models/Entrant");
const { Match } = await import("../models/Match");
const { Bracket } = await import("../models/Bracket");
const { resolvers } = await import("../graphql/resolvers/index");

const SIM_PASSWORD = "TestPass123!";
const NUM_SIM_PLAYERS = 34; // uneven, not a clean multiple of any obvious pool count
const TOURNAMENT_NAME = "Pools Championship Test";
const GAME = "Street Fighter 6";

function loserScore() {
  return Math.random() < 0.5 ? 0 : 1;
}

// Plays every currently-ready match on one bracket side/round via the REAL
// reportResult resolver — same code path a TO reporting results through the
// UI actually triggers, not a reimplementation.
async function playRound(organizerCtx, bracketId, bracketSide, bracketRound) {
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
    const lScore = loserScore();
    await resolvers.Mutation.reportResult(
      null,
      { matchId: match._id.toString(), player1Score: player1Wins ? 2 : lScore, player2Score: player1Wins ? lScore : 2 },
      organizerCtx
    );
  }
  return ready.length;
}

async function playBracketToCompletion(organizerCtx, bracketId) {
  for (let round = 1; round <= 10; round++) {
    const wbPlayed = await playRound(organizerCtx, bracketId, "WINNERS", round);
    const lbPlayed = await playRound(organizerCtx, bracketId, "LOSERS", round);
    if (wbPlayed === 0 && lbPlayed === 0) break;
  }
  const gf = await Match.findOne({ bracketId, bracketSide: "GRAND_FINAL" });
  if (gf && gf.status === "PENDING" && gf.player1Id && gf.player2Id) {
    const player1Wins = Math.random() < 0.5;
    await resolvers.Mutation.reportResult(
      null,
      { matchId: gf._id.toString(), player1Score: player1Wins ? 2 : 0, player2Score: player1Wins ? 0 : 2 },
      organizerCtx
    );
  }
  const reset = await Match.findOne({ bracketId, bracketSide: "GRAND_FINAL_RESET" });
  if (reset && reset.status === "PENDING") {
    await resolvers.Mutation.reportResult(null, { matchId: reset._id.toString(), player1Score: 2, player2Score: 0 }, organizerCtx);
  }
}

async function main() {
  await connectToDatabase();

  // ── 1. Organizer — "Jmorales" (used by prior sim tournaments) has since
  //      been soft-deleted (account-deletion feature), so create a fresh
  //      dedicated sim-organizer account instead, same pattern as the sim
  //      players below (idempotent — safe to re-run). ────────────────────
  const organizerPasswordHash = await bcrypt.hash(SIM_PASSWORD, 10);
  let organizerPlayer = await Player.findOne({ tag: "PoolsSimTO" });
  if (!organizerPlayer) {
    const organizerUser0 = await User.create({ email: "poolssimto@example.com", passwordHash: organizerPasswordHash });
    organizerPlayer = await Player.create({ userId: organizerUser0._id, tag: "PoolsSimTO" });
    await User.findByIdAndUpdate(organizerUser0._id, { playerId: organizerPlayer._id });
  }
  const organizerUser = await User.findById(organizerPlayer.userId);
  const organizerCtx = { playerId: organizerPlayer._id.toString(), role: organizerUser?.role ?? "USER" };
  console.log(`Organizer: ${organizerPlayer.tag} (${organizerPlayer._id})`);

  // ── 2. Sim players (idempotent — safe to re-run) ──────────────────────
  const passwordHash = await bcrypt.hash(SIM_PASSWORD, 10);
  const simPlayers = [];
  for (let i = 1; i <= NUM_SIM_PLAYERS; i++) {
    const tag = `PoolSim${String(i).padStart(2, "0")}`;
    let player = await Player.findOne({ tag });
    if (!player) {
      const email = `${tag.toLowerCase()}@example.com`;
      const user = await User.create({ email, passwordHash });
      player = await Player.create({ userId: user._id, tag });
      await User.findByIdAndUpdate(user._id, { playerId: player._id });
    }
    simPlayers.push(player);
  }
  console.log(`${simPlayers.length} sim players ready (PoolSim01..${String(NUM_SIM_PLAYERS).padStart(2, "0")}).`);

  // ── 3. Tournament — Pools + Bracket format, LIVE ──────────────────────
  const tournament = await Tournament.create({
    name: TOURNAMENT_NAME,
    game: GAME,
    format: "Pools + Bracket",
    status: TournamentStatus.LIVE,
    organizers: [organizerPlayer._id],
    startDate: new Date(),
    entrantCount: simPlayers.length,
  });
  console.log(`Tournament created: ${tournament._id}`);

  // ── 4. Entrants ────────────────────────────────────────────────────────
  await Entrant.insertMany(simPlayers.map(p => ({ playerId: p._id, tournamentId: tournament._id })));

  // ── 5. Generate pools — real generatePools resolver, auto-suggested
  //      pool count (no poolCount arg), same as a TO just clicking Generate ──
  const pools = await resolvers.Mutation.generatePools(null, { tournamentId: tournament._id.toString() }, organizerCtx);
  console.log(`Generated ${pools.length} pools.`);
  for (const pool of pools) {
    const entrants = await resolvers.Pool.entrants(pool);
    console.log(`  Pool ${pool.poolNumber}: ${entrants.length} entrants`);
  }

  // ── 6. Play every pool to completion, with one forfeit and one edited
  //      result mixed in somewhere along the way. Both have to happen
  //      BEFORE the rest of that bracket plays out past Winners Round 1 —
  //      editMatchResult refuses once a downstream match already has a
  //      result (assertBracketMatchEditable), so the edit must land right
  //      after the report, not after playBracketToCompletion has already
  //      advanced Winners Round 2+ off of it. ─────────────────────────────
  let forfeitDone = false;
  let editDone = false;
  for (const pool of pools) {
    const bracket = await Bracket.findOne({ poolId: pool._id });

    if (!forfeitDone) {
      const wbR1 = await Match.find({ bracketId: bracket._id, bracketSide: "WINNERS", bracketRound: 1, status: "PENDING", player1Id: { $ne: null }, player2Id: { $ne: null } });
      if (wbR1.length > 0) {
        const m = wbR1[0];
        await resolvers.Mutation.reportResult(null, { matchId: m._id.toString(), isForfeit: true, forfeitingPlayerId: m.player2Id.toString() }, organizerCtx);
        forfeitDone = true;
        console.log(`  Forfeit reported on Pool ${pool.poolNumber} Winners Round 1.`);
      }
    }

    if (!editDone) {
      const wbR1 = await Match.find({ bracketId: bracket._id, bracketSide: "WINNERS", bracketRound: 1, status: "PENDING", player1Id: { $ne: null }, player2Id: { $ne: null } });
      if (wbR1.length > 0) {
        const m = wbR1[0];
        await resolvers.Mutation.reportResult(null, { matchId: m._id.toString(), player1Score: 2, player2Score: 0 }, organizerCtx);
        // Immediately correct it — flips the winner to player2 — before
        // anything downstream plays off the original result.
        await resolvers.Mutation.editMatchResult(null, { matchId: m._id.toString(), player1Score: 1, player2Score: 2 }, organizerCtx);
        editDone = true;
        console.log(`  Reported then corrected/edited a result on Pool ${pool.poolNumber} Winners Round 1.`);
      }
    }

    await playBracketToCompletion(organizerCtx, bracket._id);
    console.log(`  Pool ${pool.poolNumber} complete.`);
  }

  const allComplete = await resolvers.Tournament.allPoolsComplete({ _id: tournament._id });
  console.log(`All pools complete: ${allComplete}`);

  // ── 7. Generate the main bracket — Avoid-same-pool seeding ────────────
  const mainBracket = await resolvers.Mutation.generateMainBracket(
    null,
    { tournamentId: tournament._id.toString(), seedingMethod: "AVOID_SAME_POOL" },
    organizerCtx
  );
  console.log(`Main bracket generated: ${mainBracket._id}, size ${mainBracket.size}, ${mainBracket.seedOrder.length} advancers.`);

  // ── 8. Play the main bracket PARTWAY (Winners Round 1 only) — leave the
  //      rest pending so it reads as a live, in-progress bracket next to
  //      the now-finished Pools view. ──────────────────────────────────
  const wbR1Played = await playRound(organizerCtx, mainBracket._id, "WINNERS", 1);
  console.log(`Main bracket: played ${wbR1Played} Winners Round 1 match(es), rest left pending.`);

  console.log("\n=== Done ===");
  console.log(`Tournament: ${tournament._id}`);
  console.log(`Detail page: https://www.fgc-ranks.com/tournaments/${tournament._id}`);

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
