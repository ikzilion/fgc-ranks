// scripts/backfillPlayerGameRankingPoints.mjs
//
// One-off backfill: computes and persists Player.gameRankingPoints for every
// existing player -- a brand-new field defaulting to an empty array, so
// existing players' per-game history was never captured in it until this
// runs. Mirrors what the deleted computeGameRankingsForPlayer used to derive
// live (which games a player has at least one qualifying -- ended, in-
// window, unrestricted -- entrant in), then computes that game's points via
// the same computeRankingPointsForPlayers(playerIds, game) every mutation's
// recompute hook now uses.
//
// Idempotent -- safe to re-run any time; it always recomputes from the live
// Entrant/Tournament data, it never trusts the field's current value.
//
// Run: npx tsx scripts/backfillPlayerGameRankingPoints.mjs

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
const { Entrant } = await import("../models/Entrant");
const { Tournament } = await import("../models/Tournament");
const { computeRankingPointsForPlayers } = await import("../lib/ranking");

const ROLLING_WINDOW_MS = 52 * 7 * 24 * 60 * 60 * 1000;

async function main() {
  await connectToDatabase();

  const players = await Player.find({}).select("_id tag").lean();
  console.log(`Found ${players.length} player(s). Determining qualifying games for each...`);

  // Bulk pass instead of one-by-one: every entrant + every ended/unrestricted
  // tournament, joined and windowed once, same shape as the old
  // computeGameRankingsForPlayer's "gamesEntered" derivation but applied to
  // every player at once instead of one round-trip per player.
  const allEntrants = await Entrant.find({}).select("playerId tournamentId").lean();
  const tournamentIds = [...new Set(allEntrants.map(e => e.tournamentId.toString()))];
  const tournaments = await Tournament.find({ _id: { $in: tournamentIds }, status: "ENDED", isRestricted: { $ne: true } })
    .select("_id game startDate")
    .lean();

  const now = Date.now();
  const qualifyingTournamentById = new Map(
    tournaments
      .filter(t => t.game && now - new Date(t.startDate).getTime() <= ROLLING_WINDOW_MS)
      .map(t => [t._id.toString(), t.game])
  );

  const gamesByPlayer = new Map(); // playerId -> Set<game>
  for (const e of allEntrants) {
    const game = qualifyingTournamentById.get(e.tournamentId.toString());
    if (!game) continue;
    const playerId = e.playerId.toString();
    if (!gamesByPlayer.has(playerId)) gamesByPlayer.set(playerId, new Set());
    gamesByPlayer.get(playerId).add(game);
  }

  let updatedCount = 0;
  const ops = [];
  for (const player of players) {
    const playerId = player._id.toString();
    const games = gamesByPlayer.get(playerId);
    if (!games || games.size === 0) {
      ops.push({ updateOne: { filter: { _id: playerId }, update: { $set: { gameRankingPoints: [] } } } });
      continue;
    }
    const entries = [];
    for (const game of games) {
      const pointsById = await computeRankingPointsForPlayers([playerId], game);
      entries.push({ game, points: pointsById.get(playerId) ?? 0 });
    }
    ops.push({ updateOne: { filter: { _id: playerId }, update: { $set: { gameRankingPoints: entries } } } });
    console.log(`  ${player.tag}: ${entries.map(e => `${e.game}=${e.points}pts`).join(", ")}`);
    updatedCount++;
  }

  if (ops.length > 0) await Player.bulkWrite(ops);
  console.log(`\nDone. ${updatedCount} player(s) had at least one game entry; ${ops.length} total player(s) updated.`);
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
