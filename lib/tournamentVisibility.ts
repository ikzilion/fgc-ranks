import { TournamentStatus } from "@/models/Tournament";

// Stale, never-populated UPCOMING tournaments are hidden from the public
// listing (Query.tournaments) but are NOT deleted -- so any other query that
// counts raw Tournament documents (Game.tournamentCount, Event.tournamentCount
// /gameCount) must apply this same filter, or its count disagrees with what's
// actually browsable (Games tab showing a nonzero count for a game with zero
// visible tournaments, Aug 2026).
export function nonStaleTournamentMatch(now: Date = new Date()) {
  const staleZeroEntrantCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return {
    $nor: [{ status: TournamentStatus.UPCOMING, entrantCount: 0, createdAt: { $lt: staleZeroEntrantCutoff } }],
  };
}
