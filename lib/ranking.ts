// lib/ranking.ts
// ATP-style rolling ranking points — see the "Ranking/points system" entry
// in the Notion to-do list for the settled design.
//
// Player.points is no longer a stored counter. It's computed at read time
// from each player's Entrant/Tournament placement history:
//   - Flat points-by-placement table, same for every tournament (no tiers).
//   - Only a player's best 10 results count at once (best-10 cap).
//   - A result ages out of the pool 52 weeks after it was earned (rolling
//     window, not a calendar-year reset).
//   - Only tournaments that have actually ENDED award points — an
//     in-progress or upcoming tournament's entrants don't count yet.
//
// Computing this at read time (rather than a periodically-recomputed cached
// field) was chosen because the 52-week aging has no natural "recompute"
// trigger — a cached value would silently go stale for any player who
// simply doesn't age out, and this app has no cron/scheduled-job
// infrastructure to run a recompute pass. Read-time computation is always
// exactly correct and this app's data volume (tens of players, a handful of
// tournaments) makes the extra queries a non-issue.
import { connectToDatabase } from "@/lib/db";
import { Entrant } from "@/models/Entrant";
import { Tournament } from "@/models/Tournament";

const BEST_RESULTS_COUNTED = 10;
const ROLLING_WINDOW_MS = 52 * 7 * 24 * 60 * 60 * 1000;
// A 16-entrant tournament is the size-scaling baseline (multiplier = 1).
const BASELINE_ENTRANT_COUNT = 16;

// Base placement -> points table. `placement` is undefined/null for an
// entrant whose final result was never recorded — same floor as an actual
// finish below 16th. This is the UNSCALED base value — see
// scaledPointsForPlacement for the real per-tournament point value.
export function pointsForPlacement(placement?: number | null): number {
  if (placement === 1) return 100;
  if (placement === 2) return 60;
  if (placement === 3 || placement === 4) return 35;
  if (placement != null && placement >= 5 && placement <= 8) return 20;
  if (placement != null && placement >= 9 && placement <= 16) return 10;
  return 1;
}

// Size-scaled points actually awarded for a placement — multiplies the base
// table by sqrt(entrantCount / 16), rounded to the nearest whole point. No
// floor/special-casing for small fields: the multiplier scales down smoothly
// below the 16-entrant baseline exactly the same way it scales up above it
// (e.g. 8 entrants -> 0.71x, 500 entrants -> ~5.59x). `entrantCount` should
// always be the tournament's own maintained Tournament.entrantCount field
// (kept in sync by join/leave — see generateBracket and friends) rather than
// a separately-recomputed count, so this can never disagree with what the
// rest of the app already considers "how many entrants this tournament had."
export function scaledPointsForPlacement(placement: number | null | undefined, entrantCount: number): number {
  const multiplier = Math.sqrt(entrantCount / BASELINE_ENTRANT_COUNT);
  return Math.round(pointsForPlacement(placement) * multiplier);
}

// Batched version — computes ranking points for many players in one pass
// (used by the players leaderboard query and bracket seed tiering) instead
// of one round-trip per player. `game`, when provided, filters down to only
// that Tournament.game before the best-10 cap is applied — the ONLY thing
// computeGameRankingsForPlayer (below) needs on top of this combined
// calculation, so it's threaded in as an optional param here rather than
// duplicating this whole function. Every existing caller omits it, so the
// combined ranking computation is completely unchanged.
export async function computeRankingPointsForPlayers(
  playerIds: string[],
  game?: string
): Promise<Map<string, number>> {
  const totals = new Map<string, number>(playerIds.map(id => [id, 0]));
  if (playerIds.length === 0) return totals;

  await connectToDatabase();

  const entrants = await Entrant.find({ playerId: { $in: playerIds } }).lean();
  if (entrants.length === 0) return totals;

  const tournamentIds = [...new Set(entrants.map((e: any) => e.tournamentId.toString()))];
  // Tournament.endDate is never actually stamped when a tournament ends
  // (nothing in the codebase writes to it) so startDate — always set at
  // creation — is the only reliable "when was this earned" date.
  // isRestricted (TO permission overhaul) tournaments never award points at
  // all — `$ne: true` (not `$eq: false`) so every pre-existing tournament,
  // which predates the field entirely, still counts exactly as before.
  const tournamentFilter: Record<string, unknown> = { _id: { $in: tournamentIds }, status: "ENDED", isRestricted: { $ne: true } };
  if (game !== undefined) tournamentFilter.game = game;
  const tournaments = await Tournament.find(tournamentFilter).lean();
  const tournamentById = new Map(tournaments.map((t: any) => [t._id.toString(), t]));

  const now = Date.now();
  const resultsByPlayer = new Map<string, number[]>();

  for (const entrant of entrants as any[]) {
    const tournament = tournamentById.get(entrant.tournamentId.toString());
    if (!tournament) continue; // not ended (or since deleted) — doesn't count yet

    const earnedAt = new Date(tournament.startDate).getTime();
    if (now - earnedAt > ROLLING_WINDOW_MS) continue; // aged out of the 52-week window

    const playerId = entrant.playerId.toString();
    const list = resultsByPlayer.get(playerId) ?? [];
    list.push(scaledPointsForPlacement(entrant.placement, tournament.entrantCount ?? 0));
    resultsByPlayer.set(playerId, list);
  }

  for (const [playerId, results] of resultsByPlayer) {
    const best = results.sort((a, b) => b - a).slice(0, BEST_RESULTS_COUNTED);
    totals.set(playerId, best.reduce((sum, p) => sum + p, 0));
  }

  return totals;
}

export async function computeRankingPoints(playerId: string): Promise<number> {
  const totals = await computeRankingPointsForPlayers([playerId]);
  return totals.get(playerId) ?? 0;
}

// ─── Per-game ranking ─────────────────────────────────────────────────────
//
// Additive alongside the combined calculation above — same 52-week window,
// same best-10 cap, same scaledPointsForPlacement formula (all reused via
// computeRankingPointsForPlayers's `game` param, not reimplemented here).
// The only genuinely new piece is `rank`: there's no existing "rank"
// (leaderboard position) concept anywhere in this codebase to reuse — the
// combined leaderboard has only ever shown raw points, sorted client-side —
// so this establishes one: 1-indexed position among every OTHER player who
// has at least one in-window, ended, unrestricted entrant in a tournament
// of that same game (not among ALL players site-wide, since a rank among
// people who never played that game would be meaningless). Ties keep
// Array.sort's stable order, same as the existing players-list resolver's
// own (also unbroken-tie) sort.
export interface GameRanking {
  game: string;
  points: number;
  rank: number;
}

// Every game a player has entered — no minimum-tournament threshold, so a
// game with just 1 counted result still gets a real entry.
export async function computeGameRankingsForPlayer(playerId: string): Promise<GameRanking[]> {
  await connectToDatabase();

  const myEntrants = await Entrant.find({ playerId }).lean();
  if (myEntrants.length === 0) return [];

  const myTournamentIds = [...new Set(myEntrants.map((e: any) => e.tournamentId.toString()))];
  const myTournaments = await Tournament.find({ _id: { $in: myTournamentIds }, status: "ENDED", isRestricted: { $ne: true } }).lean();

  const now = Date.now();
  const gamesEntered = new Set<string>();
  for (const t of myTournaments as any[]) {
    if (!t.game) continue;
    if (now - new Date(t.startDate).getTime() > ROLLING_WINDOW_MS) continue; // aged out — same window as the combined calc
    gamesEntered.add(t.game);
  }
  if (gamesEntered.size === 0) return [];

  const results: GameRanking[] = [];
  for (const game of gamesEntered) {
    // Every other player with an in-window, ended, unrestricted entrant in
    // a tournament of this same game — the pool this player's rank is
    // computed against.
    const gameTournaments = await Tournament.find({ game, status: "ENDED", isRestricted: { $ne: true } })
      .select("_id startDate")
      .lean();
    const inWindowTournamentIds = (gameTournaments as any[])
      .filter(t => now - new Date(t.startDate).getTime() <= ROLLING_WINDOW_MS)
      .map(t => t._id);
    const gameEntrants = await Entrant.find({ tournamentId: { $in: inWindowTournamentIds } }).select("playerId").lean();
    const relevantPlayerIds = [...new Set((gameEntrants as any[]).map(e => e.playerId.toString()))];

    const pointsByPlayer = await computeRankingPointsForPlayers(relevantPlayerIds, game);
    const sorted = [...relevantPlayerIds].sort((a, b) => (pointsByPlayer.get(b) ?? 0) - (pointsByPlayer.get(a) ?? 0));
    const rank = sorted.indexOf(playerId) + 1;
    const points = pointsByPlayer.get(playerId) ?? 0;
    results.push({ game, points, rank });
  }

  return results.sort((a, b) => b.points - a.points);
}
