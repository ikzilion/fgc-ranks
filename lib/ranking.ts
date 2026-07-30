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
import { Player } from "@/models/Player";

const BEST_RESULTS_COUNTED = 10;
const ROLLING_WINDOW_MS = 52 * 7 * 24 * 60 * 60 * 1000;
// A 16-entrant tournament is the size-scaling baseline used by the
// large-field branch below (multiplier = 1 at exactly 16 entrants, under
// that formula alone). No longer descriptive of small fields since the
// small/mid-tournament exception below took over that range — see
// SMALL_TOURNAMENT_CUTOFF.
const BASELINE_ENTRANT_COUNT = 16;
// Small/mid-tournament ranking exception (settled July 26, 2026, Notion
// "FGC Ranks — Claude Context"): below this entrant count, the plain
// sqrt(entrantCount/16) curve awarded too many points for tiny/repeated
// low-stakes tournaments relative to their real competitive weight -- e.g.
// under the old formula alone, an 8-entrant win was already worth 71% of a
// full 16-entrant win, cheap enough to farm by running lots of small
// brackets. Below this cutoff, a steep cubic curve suppresses small fields
// far more aggressively while the two pieces still meet exactly at the
// cutoff (both equal a 2x multiplier there), so there's no discontinuity --
// just a much steeper ramp-up below it than the unchanged sqrt curve above.
const SMALL_TOURNAMENT_CUTOFF = 64;

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
// table by a size-scaling multiplier, rounded to the nearest whole point.
// Two pieces, joined continuously at SMALL_TOURNAMENT_CUTOFF (64 entrants),
// where both formulas evaluate to exactly 2x:
//   - entrantCount < 64:  2 * (entrantCount / 64)^3 -- a steep cubic ramp
//     that aggressively suppresses small/mid fields (the anti-farming
//     exception; see SMALL_TOURNAMENT_CUTOFF's comment above).
//   - entrantCount >= 64: sqrt(entrantCount / 16) -- completely unchanged
//     from the original formula, still scaling up smoothly for large fields
//     (e.g. 500 entrants -> ~5.59x).
// `entrantCount` should always be the tournament's own maintained
// Tournament.entrantCount field (kept in sync by join/leave — see
// generateBracket and friends) rather than a separately-recomputed count,
// so this can never disagree with what the rest of the app already
// considers "how many entrants this tournament had."
export function scaledPointsForPlacement(placement: number | null | undefined, entrantCount: number): number {
  const multiplier =
    entrantCount < SMALL_TOURNAMENT_CUTOFF
      ? 2 * Math.pow(entrantCount / SMALL_TOURNAMENT_CUTOFF, 3)
      : Math.sqrt(entrantCount / BASELINE_ENTRANT_COUNT);
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

// Recomputes and persists Player.rankingPoints for the given players —
// called after any write that can change a player's combined points (match
// report/edit/undo, placement set/clear, tournament status change/cancel/
// delete). Bounded by however many players are actually affected by that
// one write (typically one tournament's entrants, never the whole player
// base), so this stays cheap regardless of total site-wide player count.
// See models/Player.ts's rankingPoints field comment for the one disclosed
// staleness gap (pure calendar-time aging with no intervening write).
export async function recomputeAndCachePlayerPoints(playerIds: string[]): Promise<void> {
  const uniqueIds = [...new Set(playerIds.map(id => id.toString()))];
  if (uniqueIds.length === 0) return;

  await connectToDatabase();
  const pointsById = await computeRankingPointsForPlayers(uniqueIds);
  await Player.bulkWrite(
    uniqueIds.map(id => ({
      updateOne: { filter: { _id: id }, update: { $set: { rankingPoints: pointsById.get(id) ?? 0 } } },
    }))
  );
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

// Every player with an in-window, ended, unrestricted entrant in a
// tournament of the given game, ranked by their game-specific points —
// the FULL leaderboard for that game (every real player, not just top N;
// the caller decides if/how to trim it). This is the one place that
// discovers "who's actually relevant to this game" and scores them
// (via computeRankingPointsForPlayers's `game` filter) — both the new
// /games/[game] leaderboard page and computeGameRankingsForPlayer (below,
// the per-player profile section) call this directly rather than each
// re-deriving the relevant-player set and re-scoring it their own way.
export async function computeGameLeaderboard(game: string): Promise<{ playerId: string; points: number }[]> {
  await connectToDatabase();
  const now = Date.now();

  const gameTournaments = await Tournament.find({ game, status: "ENDED", isRestricted: { $ne: true } })
    .select("_id startDate")
    .lean();
  const inWindowTournamentIds = (gameTournaments as any[])
    .filter(t => now - new Date(t.startDate).getTime() <= ROLLING_WINDOW_MS)
    .map(t => t._id);
  if (inWindowTournamentIds.length === 0) return [];

  const gameEntrants = await Entrant.find({ tournamentId: { $in: inWindowTournamentIds } }).select("playerId").lean();
  const relevantPlayerIds = [...new Set((gameEntrants as any[]).map(e => e.playerId.toString()))];
  if (relevantPlayerIds.length === 0) return [];

  const pointsByPlayer = await computeRankingPointsForPlayers(relevantPlayerIds, game);
  return relevantPlayerIds
    .map(playerId => ({ playerId, points: pointsByPlayer.get(playerId) ?? 0 }))
    .sort((a, b) => b.points - a.points);
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
    const leaderboard = await computeGameLeaderboard(game);
    const rank = leaderboard.findIndex(e => e.playerId === playerId) + 1;
    const points = leaderboard.find(e => e.playerId === playerId)?.points ?? 0;
    results.push({ game, points, rank });
  }

  return results.sort((a, b) => b.points - a.points);
}
