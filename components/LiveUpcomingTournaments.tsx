// components/LiveUpcomingTournaments.tsx
// Extracted from app/page.tsx's original inline right-column markup
// (Homepage Phase 2's 3-column layout) so /games/[game] can show the exact
// same "Live now" / "Upcoming" styling for a game-filtered tournament list
// instead of duplicating the JSX. Behavior is unchanged from the homepage's
// original inline version — this is a pure extraction, not a redesign.
import Link from "next/link";

interface TournamentSummary {
  id: string;
  name: string;
  game: string;
  status: string;
  entrantCount: number;
  startDate: string;
}

function compactBadge(status: string) {
  if (status === "LIVE")
    return (
      <span className="badge-live text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded flex items-center gap-1 flex-shrink-0">
        <span className="live-dot" /> Live
      </span>
    );
  return <span className="badge-upcoming text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded flex-shrink-0">Upcoming</span>;
}

function TournamentRow({ tournament }: { tournament: TournamentSummary }) {
  return (
    <Link
      href={`/tournaments/${tournament.id}`}
      className="flex items-center justify-between gap-2 px-3 py-2.5 rounded hover:bg-[var(--navy-3)] transition-colors"
    >
      <div className="min-w-0">
        <p className="font-rajdhani text-[14px] font-bold text-[var(--text-primary)] truncate leading-tight">{tournament.name}</p>
        <p className="text-[11px] text-[var(--text-secondary)] truncate">{tournament.game} · {tournament.entrantCount} entrants</p>
      </div>
      {compactBadge(tournament.status)}
    </Link>
  );
}

export function LiveUpcomingTournaments({
  tournaments,
  viewAllHref,
  viewAllLabel = "View all tournaments",
}: {
  tournaments: TournamentSummary[];
  viewAllHref?: string;
  viewAllLabel?: string;
}) {
  const liveTournaments = tournaments.filter(t => t.status === "LIVE").slice(0, 5);
  // The underlying tournaments query sorts startDate descending (most
  // recently-created-or-dated first) — right for a general listing, but
  // wrong for "what's coming up": that order surfaces the farthest-out
  // upcoming tournament first instead of the soonest one. Re-sort
  // ascending here before capping to 5, so this section reads
  // chronologically (soonest first) regardless of the base query's order.
  const upcomingTournaments = tournaments
    .filter(t => t.status === "UPCOMING")
    .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime())
    .slice(0, 5);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Live now</h2>
        <div className="fgc-card">
          {liveTournaments.length === 0 && (
            <p className="p-4 text-[12px] text-[var(--text-secondary)]">No live tournaments.</p>
          )}
          {liveTournaments.map(t => (
            <TournamentRow key={t.id} tournament={t} />
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Upcoming</h2>
        <div className="fgc-card">
          {upcomingTournaments.length === 0 && (
            <p className="p-4 text-[12px] text-[var(--text-secondary)]">No upcoming tournaments.</p>
          )}
          {upcomingTournaments.map(t => (
            <TournamentRow key={t.id} tournament={t} />
          ))}
        </div>
      </div>

      {viewAllHref && (
        <Link
          href={viewAllHref}
          className="block text-center text-[12px] font-semibold py-2 rounded"
          style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)" }}
        >
          {viewAllLabel}
        </Link>
      )}
    </div>
  );
}
