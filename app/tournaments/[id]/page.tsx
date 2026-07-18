// app/tournaments/[id]/page.tsx
// Tournament detail page — shows bracket matches and entrant list.

import { notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { JoinTournamentButton } from "@/components/JoinTournamentButton";
import { TournamentStatusButton } from "@/components/TournamentStatusButton";
import { CreateMatchButton } from "@/components/CreateMatchButton";
import { ReportMatchButton } from "@/components/ReportMatchButton";
import { ManageOrganizersButton } from "@/components/ManageOrganizersButton";
import { InvitePlayerButton } from "@/components/InvitePlayerButton";
import { RemoveEntrantButton } from "@/components/RemoveEntrantButton";
import { GenerateBracketButton } from "@/components/GenerateBracketButton";
import { BracketView } from "@/components/BracketView";

export const dynamic = "force-dynamic";

const GET_TOURNAMENT = `
  query GetTournament($id: ID!, $playerId: ID) {
    tournament(id: $id) {
      id
      name
      game
      status
      cancellationReason
      visibility
      entrantCount
      startDate
      endDate
      isEntered(playerId: $playerId)
      isOrganizer(playerId: $playerId)
      isInvited(playerId: $playerId)
      organizers {
        id
        tag
      }
      invitedPlayers {
        id
        tag
      }
      entrants {
        id
        seed
        placement
        player {
          id
          tag
          avatarUrl
          characters
        }
      }
      matches {
        id
        round
        status
        bracketSide
        player1Score
        player2Score
        player1 { id tag avatarUrl }
        player2 { id tag avatarUrl }
        winner { id tag }
      }
      bracket {
        id
        seedingMethod
        size
        matches {
          id
          round
          status
          bracketSide
          bracketRound
          bracketPosition
          player1Score
          player2Score
          player1 { id tag }
          player2 { id tag }
          winner { id tag }
        }
      }
    }
    players(limit: 200) {
      id
      tag
    }
  }
`;

async function getTournament(id: string, playerId?: string) {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const res = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: GET_TOURNAMENT, variables: { id, playerId } }),
      cache: "no-store",
    });
    const json = await res.json();
    if (json.errors) {
      console.error("[tournament/id] GraphQL errors:", json.errors);
      return { tournament: null, players: [] };
    }
    return { tournament: json.data?.tournament ?? null, players: json.data?.players ?? [] };
  } catch (err) {
    console.error("[tournament/id] Fetch error:", err);
    return { tournament: null, players: [] };
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
  if (status === "CANCELLED")
    return (
      <span
        className="text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded"
        style={{ background: "var(--coral-dim)", color: "var(--coral)" }}
      >
        Cancelled
      </span>
    );
  return <span className="badge-ended text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded">Ended</span>;
}

export default async function TournamentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  const playerId = (session?.user as any)?.playerId ?? undefined;
  const role = (session?.user as any)?.role;
  const { tournament, players } = await getTournament(id, playerId);
  if (!tournament) notFound();

  const canManage = tournament.isOrganizer || role === "ADMIN";
  const myEntrant = tournament.entrants.find((e: any) => e.player.id === playerId);

  // Freeform (non-bracket) matches — bracket matches are shown separately in
  // the TO-only bracket section below.
  const freeformMatches = tournament.matches.filter((m: any) => !m.bracketSide);

  // Group freeform matches by round
  const rounds: Record<string, any[]> = {};
  for (const match of freeformMatches) {
    if (!rounds[match.round]) rounds[match.round] = [];
    rounds[match.round].push(match);
  }

  return (
    <main className="max-w-5xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="fgc-card p-6 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div>
            <h1 className="font-rajdhani text-3xl font-bold text-[var(--text-primary)] leading-tight">
              {tournament.name}
              {tournament.visibility === "PRIVATE" && (
                <span className="ml-2 text-[13px] align-middle" style={{ color: "var(--text-muted)" }}>🔒 Private</span>
              )}
            </h1>
            <p className="text-[13px] text-[var(--text-secondary)] mt-1">
              {tournament.game} · {tournament.entrantCount} entrants · {new Date(tournament.startDate).toLocaleDateString()}
            </p>
            {tournament.status === "CANCELLED" && tournament.cancellationReason && (
              <p className="text-[13px] mt-1" style={{ color: "var(--coral)" }}>
                Cancelled: {tournament.cancellationReason}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            {statusBadge(tournament.status)}
            <TournamentStatusButton tournamentId={tournament.id} status={tournament.status} canManage={canManage} />
            <JoinTournamentButton
              tournamentId={tournament.id}
              isEntered={tournament.isEntered}
              entrantId={myEntrant?.id}
              status={tournament.status}
              visibility={tournament.visibility}
              isInvited={tournament.isInvited}
            />
          </div>
        </div>
        {canManage && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <ManageOrganizersButton
              tournamentId={tournament.id}
              organizers={tournament.organizers}
              entrants={tournament.entrants}
              canManage={canManage}
            />
            <InvitePlayerButton
              tournamentId={tournament.id}
              visibility={tournament.visibility}
              invitedPlayers={tournament.invitedPlayers}
              entrants={tournament.entrants}
              allPlayers={players}
              canManage={canManage}
            />
          </div>
        )}
      </div>

      {/* Bracket — visible to everyone once generated (Phase 2: public read-only
          view). Organizers/admins additionally get generate/edit controls and
          can see the "no bracket yet" state; non-managers just see nothing
          until one exists, so spectators aren't shown an empty section. */}
      {(tournament.bracket || canManage) && (
        <div className="fgc-card p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">Bracket</p>
              {canManage && (
                <p className="text-[11px] text-[var(--text-muted)] mt-0.5">You can report results and manage this bracket.</p>
              )}
            </div>
            {canManage && (
              <GenerateBracketButton
                tournamentId={tournament.id}
                entrants={tournament.entrants}
                canManage={canManage}
                hasBracket={!!tournament.bracket}
              />
            )}
          </div>
          {tournament.bracket ? (
            <BracketView bracket={tournament.bracket} canManage={canManage} />
          ) : (
            <p className="text-[13px] text-[var(--text-secondary)]">No bracket generated yet.</p>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Matches */}
        <div className="col-span-2">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">Matches</p>
            <CreateMatchButton tournamentId={tournament.id} entrants={tournament.entrants} canManage={canManage} />
          </div>
          {freeformMatches.length === 0 ? (
            <div className="fgc-card p-6 text-[var(--text-secondary)]">No matches yet.</div>
          ) : (
            Object.entries(rounds).map(([round, matches]) => (
              <div key={round} className="mb-4">
                <p className="text-[11px] uppercase tracking-wider text-[var(--text-muted)] mb-2 px-1">{round}</p>
                <div className="fgc-card">
                  {matches.map((match: any) => (
                    <div key={match.id} className="px-4 py-3 border-b border-[var(--border)] last:border-0">
                      <div className="flex items-center justify-end mb-1">
                        <ReportMatchButton match={match} canManage={canManage} />
                      </div>
                      {/* Player 1 */}
                      <div className={`flex items-center justify-between py-1 ${match.winner?.id === match.player1.id ? "opacity-100" : "opacity-50"}`}>
                        <div className="flex items-center gap-2">
                          {match.winner?.id === match.player1.id && (
                            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: "var(--green)" }} />
                          )}
                          <div className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden" style={{ background: "var(--navy-4)", border: "1px solid var(--border-strong)" }}>
                            {match.player1.avatarUrl ? (
                              <img src={match.player1.avatarUrl} alt={match.player1.tag} className="w-full h-full object-cover" />
                            ) : (
                              <span className="text-[8px] font-bold" style={{ color: "var(--text-secondary)" }}>{match.player1.tag.slice(0, 2).toUpperCase()}</span>
                            )}
                          </div>
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
                          <div className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden" style={{ background: "var(--navy-4)", border: "1px solid var(--border-strong)" }}>
                            {match.player2.avatarUrl ? (
                              <img src={match.player2.avatarUrl} alt={match.player2.tag} className="w-full h-full object-cover" />
                            ) : (
                              <span className="text-[8px] font-bold" style={{ color: "var(--text-secondary)" }}>{match.player2.tag.slice(0, 2).toUpperCase()}</span>
                            )}
                          </div>
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
                  <div
                    key={entrant.id}
                    className="flex items-center gap-3 px-4 py-2.5 border-b border-[var(--border)] last:border-0 hover:bg-[var(--navy-3)] transition-colors"
                  >
                    <Link href={`/players/${entrant.player.id}`} className="flex items-center gap-3 flex-1 min-w-0">
                      <span className="text-[11px] text-[var(--text-muted)] w-5 flex-shrink-0">{entrant.seed ?? "—"}</span>
                      <div
                        className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 font-rajdhani text-[10px] font-bold overflow-hidden"
                        style={{ background: "var(--blue-dim)", color: "var(--blue)", border: "1px solid rgba(79,142,247,0.3)" }}
                      >
                        {entrant.player.avatarUrl ? (
                          <img src={entrant.player.avatarUrl} alt={entrant.player.tag} className="w-full h-full object-cover" />
                        ) : (
                          entrant.player.tag.slice(0, 2).toUpperCase()
                        )}
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
                    <RemoveEntrantButton entrantId={entrant.id} playerTag={entrant.player.tag} canManage={canManage} status={tournament.status} />
                  </div>
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
