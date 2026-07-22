// app/admin/games/page.tsx
// Curated Games management — ADMIN-only. Same admin-gated SSR pattern as
// app/admin/events/page.tsx/app/admin/users/page.tsx: this page's own
// auth() check is just the notFound() gate (UX); real enforcement lives in
// the createGame/updateGame/deleteGame resolvers, which run as browser
// mutations from AdminGameManager and so carry the session cookie normally.
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { isAdminOrAbove } from "@/lib/roles";
import { AdminGameManager } from "@/components/AdminGameManager";

export const dynamic = "force-dynamic";

const GET_GAMES_FOR_ADMIN = `
  query GetGamesForAdmin {
    games {
      id
      name
      iconUrl
      tournamentCount
    }
  }
`;

async function getGames() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  try {
    const res = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: GET_GAMES_FOR_ADMIN }),
      cache: "no-store",
    });
    const json = await res.json();
    if (json.errors) {
      console.error("[admin/games] GraphQL errors:", json.errors);
      return [];
    }
    return json.data?.games ?? [];
  } catch (err) {
    console.error("[admin/games] Fetch error:", err);
    return [];
  }
}

export default async function AdminGamesPage() {
  const session = await auth();
  const role = (session?.user as any)?.role;
  if (!isAdminOrAbove(role)) notFound();

  const games = await getGames();

  return (
    <main className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-1">
        <h1 className="font-rajdhani text-2xl font-bold text-[var(--text-primary)]">Manage games</h1>
      </div>
      <p className="text-[12px] text-[var(--text-secondary)] mb-6">
        Add, rename, or re-icon the curated Games list — this drives the "Games" nav tab and the game dropdown when creating a tournament.
      </p>

      <AdminGameManager games={games} />
    </main>
  );
}
