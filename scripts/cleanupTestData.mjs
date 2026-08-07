// scripts/cleanupTestData.mjs
//
// One-off cleanup: removes the "CEO 2026" and "EVO Las Vegas" test
// tournaments (and their Match/Bracket/Entrant docs) ahead of the
// 700-entrant stress test, per backlog order. Scope confirmed with the user
// 2026-07-31 — Community Showdown + its 29 SimPlayer accounts, and the
// other ~130 @example.com test users, are explicitly OUT of scope for this
// pass and are left untouched.
//
// Mirrors deleteTournament (graphql/resolvers/index.ts) exactly: undoes the
// win/loss stat effects of completed matches, cascades the delete, then
// recomputes cached player points — but calls the DB/model/ranking code
// directly instead of the GraphQL mutation, since this is a maintenance
// script with no authenticated organizer session to satisfy deleteTournament's
// isOrganizer() check.
//
// Run: npx tsx scripts/cleanupTestData.mjs

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

const { connectToDatabase } = await import("../lib/db.ts");
const { Tournament } = await import("../models/Tournament.ts");
const { Player } = await import("../models/Player.ts");
const { Entrant } = await import("../models/Entrant.ts");
const { Match } = await import("../models/Match.ts");
const { Bracket } = await import("../models/Bracket.ts");
const { recomputeAndCachePlayerPoints } = await import("../lib/ranking.ts");
const mongoose = (await import("mongoose")).default;

const TARGET_NAMES = ["CEO 2026", "EVO Las Vegas"];

async function deleteTournamentByName(name) {
  const tournament = await Tournament.findOne({ name });
  if (!tournament) {
    console.log(`  "${name}": not found, skipping.`);
    return;
  }
  const id = tournament._id;

  const completedMatches = await Match.find({ tournamentId: id, status: "COMPLETED", winnerId: { $ne: null } });
  for (const match of completedMatches) {
    const loserId = match.winnerId.toString() === match.player1Id.toString() ? match.player2Id : match.player1Id;
    await Player.findByIdAndUpdate(match.winnerId, { $inc: { wins: -1 } });
    await Player.findByIdAndUpdate(loserId, { $inc: { losses: -1 } });
  }

  const affectedPlayerIds = await Entrant.find({ tournamentId: id }).distinct("playerId");

  const [{ deletedCount: matchCount }, { deletedCount: bracketCount }, { deletedCount: entrantCount }] = await Promise.all([
    Match.deleteMany({ tournamentId: id }),
    Bracket.deleteMany({ tournamentId: id }),
    Entrant.deleteMany({ tournamentId: id }),
  ]);
  await Tournament.findByIdAndDelete(id);

  await recomputeAndCachePlayerPoints(affectedPlayerIds.map(pid => pid.toString()), tournament.game);

  console.log(
    `  "${name}" (${id}): deleted tournament, ${matchCount} match(es), ${bracketCount} bracket(s), ${entrantCount} entrant(s); undid stats for ${completedMatches.length} completed match(es); recomputed points for ${affectedPlayerIds.length} player(s).`
  );
}

async function main() {
  await connectToDatabase();
  console.log("Deleting test tournaments...");
  for (const name of TARGET_NAMES) {
    await deleteTournamentByName(name);
  }
  console.log("\n=== Done ===");
  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async err => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
