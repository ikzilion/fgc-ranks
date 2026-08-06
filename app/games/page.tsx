// app/games/page.tsx
// Games browse page — curated games (plus any un-curated drift, see the
// `games` resolver), each linking to its own dedicated /games/[game] page
// (full ranked leaderboard + that game's live/upcoming tournaments). The
// Tournaments list pre-filtered to a game via TournamentSearchFilter's
// existing name/game/address search is untouched and still reachable —
// /games/[game] itself links out to it ("Search {game} tournaments").

import { GameSearchFilter } from "@/components/GameSearchFilter";
import { AdSlot } from "@/components/AdSlot";

export const dynamic = "force-dynamic";

const GET_GAMES = `
  query GetGames {
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
      body: JSON.stringify({ query: GET_GAMES }),
      cache: "no-store",
    });
    const json = await res.json();
    if (json.errors) {
      console.error("[games] GraphQL errors:", json.errors);
      return [];
    }
    return json.data?.games ?? [];
  } catch (err) {
    console.error("[games] Fetch error:", err);
    return [];
  }
}

export default async function GamesPage() {
  const games = await getGames();

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-rajdhani text-2xl font-bold text-[var(--text-primary)]">Games</h1>
        <p className="text-[12px] text-[var(--text-secondary)]">{games.length} games</p>
      </div>

      <GameSearchFilter games={games} />

      <AdSlot className="mt-6" />
    </main>
  );
}
