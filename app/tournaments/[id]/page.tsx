// app/tournaments/[id]/page.tsx
// Tournament detail page — shows bracket matches and entrant list.

import { notFound } from "next/navigation";
import Link from "next/link";

const GET_TOURNAMENT = `
  query GetTournament($id: ID!) {
    tournament(id: $id) {
      id
      name
      game
      status
      entrantCount
      startDate
      endDate
      entrants {
        id
        seed
        placement
        player {
          id
          tag
          characters
        }
      }
      matches {
        id
        round
        status
        player1Score
        player2Score
        player1 { id tag }
        player2 { id tag }
        winner { id tag }
      }
    }
  }
`;

async function getTournament(id: string) {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const res = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: GET_TOURNAMENT, variables: { id } }),
      cache: "no-store",
    });
    const json = await res.json();
    if (json.errors) {
      console.error("[tournament/id] GraphQL errors:", json.errors);
      return null;
    }
    return json.data?.tournament ?? null;
  } catch (err) {
    console.error("[tournament/id] Fetch error:", err);
    return null;
  }
}

function statusBadge(status: string) {
  if (status === "LIVE")
    return (
      <span className="badge-live text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded flex items-center gap-1">
        <span className="live-dot" /> Live
      </span>
    );
  if (status === "UPCOMING")
    return <span className="badge-upcoming text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded">Upcoming</span>;
  return <span className="badge-ended text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded">Ended</span>;
}

export default async function TournamentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tournament = await getTournament(id);
  if (!tournament) notFound();

  // Group matches by round
  const rounds: Record<string, any[]> = {};
  for (const match of tournament.matches) {
    if (!rounds[match.round]) rounds[match.round] = [];
    rounds[match.round].push(match);
  }

  return (
    <main className="max-w-5xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="fgc-card p-6 mb-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="font-rajdhani text-3xl font-bold text-[var(--text-primary)] leading-tight">
              {tournament.name}
            </h1>
            <p className="text-[13px] text-[var(--text-secondary)] mt-1">
              {tournament.game} · {tournament.entrantCount} entrants · {new Date(tournament.startDate).toLocaleDateString()}
            </p>
          </div>
          {statusBadge(tournament.status)}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {/* Bracket / Matches */}
        <div className="col-span-2">
          <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">Bracket</p>
          {tournament.matches.length === 0 ? (
            <div className="fgc-card p-6 text-[var(--text-secondary)]">No matches yet.</div>
          ) : (
            Object.entries(rounds).map(([round, matches]) => (
              <div key={round} className="mb-4">
                <p className="text-[11px] uppercase tracking-wider text-[var(--text-muted)] mb-2 px-1">{round}</p>
                <div className="fgc-card">
                  {matches.map((match: any) => (
                    <div key={match.id} className="px-4 py-3 border-b border-[var(--border)] last:border-0">
                      {/* Player 1 */}
                      <div className={`flex items-center justify-between py-1 ${match.winner?.id === match.player1.id ? "opacity-100" : "opacity-50"}`}>
                        <div className="flex items-center gap-2">
                          {match.winner?.id === match.player1.id && (
                            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: "var(--green)" }} />
                          )}
                          <Link href={`/players/${match.player1.id}`} className="font-rajdhani text-[14px] font-semibold text-[var(--text-primary)] hover:text-[var(--blue)]">
                            {match.player1.tag}
                          </Link>
                        </div>
                        <span className="font-rajdhani text-[14px] font-bold" style={{ color: match.winner?.id === match.player1.id ? "var(--green)" : "var(--text-muted)" }}>
                          {match.status === "COMPLETED" ? match.player1Score : "—"}
                        </span>
                      </div>
                      {/* Player 2 */}
                      <div className={`flex items-center justify-between py-1 ${match.winner?.id === match.player2.id ? "opacity-100" : "opacity-50"}`}>
                        <div className="flex items-center gap-2">
                          {match.winner?.id === match.player2.id && (
                            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: "var(--green)" }} />
                          )}
                          <Link href={`/players/${match.player2.id}`} className="font-rajdhani text-[14px] font-semibold text-[var(--text-primary)] hover:text-[var(--blue)]">
                            {match.player2.tag}
                          </Link>
                        </div>
                        <span className="font-rajdhani text-[14px] font-bold" style={{ color: match.winner?.id === match.player2.id ? "var(--green)" : "var(--text-muted)" }}>
                          {match.status === "COMPLETED" ? match.player2Score : "—"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Entrants sidebar */}
        <div>
          <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">Entrants</p>
          <div className="fgc-card">
            {tournament.entrants.length === 0 ? (
              <p className="p-4 text-[var(--text-secondary)] text-[13px]">No entrants yet.</p>
            ) : (
              [...tournament.entrants]
                .sort((a: any, b: any) => (a.seed ?? 999) - (b.seed ?? 999))
                .map((entrant: any) => (
                  <Link
                    key={entrant.id}
                    href={`/players/${entrant.player.id}`}
                    className="flex items-center gap-3 px-4 py-2.5 border-b border-[var(--border)] last:border-0 hover:bg-[var(--navy-3)] transition-colors"
                  >
                    <span className="text-[11px] text-[var(--text-muted)] w-5 flex-shrink-0">{entrant.seed ?? "—"}</span>
                    <div
                      className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 font-rajdhani text-[10px] font-bold"
                      style={{ background: "var(--blue-dim)", color: "var(--blue)", border: "1px solid rgba(79,142,247,0.3)" }}
                    >
                      {entrant.player.tag.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-rajdhani text-[13px] font-semibold text-[var(--text-primary)] truncate">{entrant.player.tag}</p>
                      {entrant.placement && (
                        <p className="text-[11px]" style={{ color: entrant.placement === 1 ? "var(--gold)" : "var(--text-muted)" }}>
                          {entrant.placement === 1 ? "🏆 Champion" : `${entrant.placement}th place`}
                        </p>
                      )}
                    </div>
                  </Link>
                ))
            )}
          </div>
        </div>
      </div>

      {/* Back link */}
      <div className="mt-6">
        <Link href="/tournaments" className="text-[13px] text-[var(--text-secondary)] hover:text-[var(--blue)]">
          ← Back to tournaments
        </Link>
      </div>
    </main>
  );
}
