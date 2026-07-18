// app/tournaments/page.tsx
// Tournament list — upcoming, live, and ended.

import Link from "next/link";
import { auth } from "@/lib/auth";
import { CreateTournamentButton } from "@/components/CreateTournamentButton";
import { DeleteTournamentButton } from "@/components/DeleteTournamentButton";
import { CancelTournamentButton } from "@/components/CancelTournamentButton";

export const dynamic = "force-dynamic";

const GET_TOURNAMENTS = `
  query GetTournaments($playerId: ID) {
    tournaments(limit: 50) {
      id
      name
      game
      status
      cancellationReason
      entrantCount
      startDate
      isOrganizer(playerId: $playerId)
    }
  }
`;

async function getTournaments(playerId?: string) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  try {
    const res = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: GET_TOURNAMENTS, variables: { playerId } }),
      cache: "no-store",
    });
    const json = await res.json();
    if (json.errors) {
      console.error("[tournaments] GraphQL errors:", json.errors);
      return [];
    }
    return json.data?.tournaments ?? [];
  } catch (err) {
    console.error("[tournaments] Fetch error:", err);
    return [];
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

export default async function TournamentsPage() {
  const session = await auth();
  const playerId = (session?.user as any)?.playerId ?? undefined;
  const role = (session?.user as any)?.role;
  const tournaments = await getTournaments(playerId);

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-rajdhani text-2xl font-bold text-[var(--text-primary)]">Tournaments</h1>
        <div className="flex items-center gap-4">
          <p className="text-[12px] text-[var(--text-secondary)]">{tournaments.length} tournaments</p>
          <CreateTournamentButton />
        </div>
      </div>

      <div className="fgc-card">
        {tournaments.length === 0 && (
          <p className="p-6 text-[var(--text-secondary)]">No tournaments yet.</p>
        )}
        {tournaments.map((tournament: any) => {
          const canManage = tournament.isOrganizer || role === "ADMIN";
          return (
            <div
              key={tournament.id}
              className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-5 py-3 border-b border-[var(--border)] last:border-0 hover:bg-[var(--navy-3)] transition-colors"
            >
              <Link href={`/tournaments/${tournament.id}`} className="flex-1 min-w-0">
                <p className="font-rajdhani text-[16px] font-bold text-[var(--text-primary)] leading-tight">{tournament.name}</p>
                <p className="text-[12px] text-[var(--text-secondary)] truncate">
                  {tournament.game} · {tournament.entrantCount} entrants · {new Date(tournament.startDate).toLocaleDateString()}
                </p>
                {tournament.status === "CANCELLED" && tournament.cancellationReason && (
                  <p className="text-[12px] mt-0.5 truncate" style={{ color: "var(--coral)" }}>
                    Reason: {tournament.cancellationReason}
                  </p>
                )}
              </Link>
              <div className="flex items-center gap-2 flex-shrink-0">
                {statusBadge(tournament.status)}
                {canManage && tournament.status !== "CANCELLED" && (
                  <CancelTournamentButton tournamentId={tournament.id} canManage={canManage} />
                )}
                <DeleteTournamentButton tournamentId={tournament.id} canManage={canManage} />
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
