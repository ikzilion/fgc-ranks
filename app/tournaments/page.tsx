// app/tournaments/page.tsx
// Tournament list — upcoming, live, and ended.

import { auth } from "@/lib/auth";
import { isAdminOrAbove } from "@/lib/roles";
import { CreateTournamentButton } from "@/components/CreateTournamentButton";
import { TournamentSearchFilter } from "@/components/TournamentSearchFilter";

export const dynamic = "force-dynamic";

const GET_TOURNAMENTS = `
  query GetTournaments($playerId: ID) {
    tournaments(limit: 50) {
      id
      name
      game
      status
      cancellationReason
      visibility
      entrantCount
      startDate
      isOnlineOnly
      address
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

export default async function TournamentsPage() {
  const session = await auth();
  const playerId = (session?.user as any)?.playerId ?? undefined;
  const role = (session?.user as any)?.role;
  const tournaments = await getTournaments(playerId);

  const withCanManage = tournaments.map((t: any) => ({
    ...t,
    canManage: t.isOrganizer || isAdminOrAbove(role),
  }));

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-rajdhani text-2xl font-bold text-[var(--text-primary)]">Tournaments</h1>
        <div className="flex items-center gap-4">
          <p className="text-[12px] text-[var(--text-secondary)]">{tournaments.length} tournaments</p>
          <CreateTournamentButton />
        </div>
      </div>

      <TournamentSearchFilter tournaments={withCanManage} />
    </main>
  );
}
