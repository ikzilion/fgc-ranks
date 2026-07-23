// scripts/seedManualPoolsTest.mjs
//
// One-off seed script: builds a persistent "Pools + Bracket" format
// tournament with ~62 simulated entrants, joined and nothing else — no
// pools generated, no matches played, no bracket created. Intentionally
// left at "entrants joined" so a human can manually walk through pool
// generation / bracket creation via the UI themselves. Mirrors
// scripts/seedPoolsSimulation.mjs's setup pattern (direct Mongoose writes
// for organizer/entrants, since register/login are rate-limited and
// createTournament has a 24h-account-age gate), but stops right after
// entrant creation instead of driving any further resolver calls.
//
// Run: npx tsx scripts/seedManualPoolsTest.mjs

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

const SIM_PASSWORD = "TestPass123!";
const NUM_SIM_PLAYERS = 62; // uneven — not a clean power of 2, on purpose
const TOURNAMENT_NAME = "Manual Pools Test";
const GAME = "Street Fighter 6";

async function main() {
  const mongooseInstance = await connectToDatabase();

  // ── 1. Organizer — reuse the same dedicated sim-organizer account the
  //      other Pools test tournament uses (idempotent, safe to reuse). ────
  const passwordHash = await bcrypt.hash(SIM_PASSWORD, 10);
  let organizerPlayer = await Player.findOne({ tag: "PoolsSimTO" });
  if (!organizerPlayer) {
    const organizerUser0 = await User.create({ email: "poolssimto@example.com", passwordHash });
    organizerPlayer = await Player.create({ userId: organizerUser0._id, tag: "PoolsSimTO" });
    await User.findByIdAndUpdate(organizerUser0._id, { playerId: organizerPlayer._id });
  }
  console.log(`Organizer: ${organizerPlayer.tag} (${organizerPlayer._id})`);

  // ── 2. Sim players (idempotent — safe to re-run) ──────────────────────
  const simPlayers = [];
  for (let i = 1; i <= NUM_SIM_PLAYERS; i++) {
    const tag = `ManualTestP${String(i).padStart(2, "0")}`;
    let player = await Player.findOne({ tag });
    if (!player) {
      const email = `${tag.toLowerCase()}@example.com`;
      const user = await User.create({ email, passwordHash });
      player = await Player.create({ userId: user._id, tag });
      await User.findByIdAndUpdate(user._id, { playerId: player._id });
    }
    simPlayers.push(player);
  }
  console.log(`${simPlayers.length} sim players ready (ManualTestP01..${String(NUM_SIM_PLAYERS).padStart(2, "0")}).`);

  // ── 3. Tournament — Pools + Bracket format, LIVE, nothing else done ───
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

  // ── 4. Entrants — joined, nothing further ─────────────────────────────
  await Entrant.insertMany(simPlayers.map(p => ({ playerId: p._id, tournamentId: tournament._id })));
  console.log(`${simPlayers.length} entrants joined. No pools generated, no matches played, no bracket created — left for manual testing.`);

  console.log("\n=== Done ===");
  console.log(`Tournament: ${tournament._id}`);
  console.log(`Detail page: https://www.fgc-ranks.com/tournaments/${tournament._id}`);

  await mongooseInstance.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
