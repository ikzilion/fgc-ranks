// app/players/page.tsx
import { PlayerSearchFilter } from "@/components/PlayerSearchFilter";

const GET_PLAYERS = `
  query {
    players(limit: 50) {
      id
      tag
      region
      avatarUrl
      characters
      wins
      losses
      points
      winRate
    }
  }
`;

async function getPlayers() {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const res = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: GET_PLAYERS }),
      cache: "no-store",
    });

    if (!res.ok) {
      console.error("[players] fetch failed:", res.status, await res.text());
      return [];
    }

    const json = await res.json();

    if (json.errors) {
      console.error("[players] GraphQL errors:", JSON.stringify(json.errors, null, 2));
      return [];
    }

    return json.data?.players ?? [];
  } catch (err) {
    console.error("[players] fetch error:", err);
    return [];
  }
}

export default async function PlayersPage() {
  const players = await getPlayers();

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-rajdhani text-2xl font-bold text-[var(--text-primary)]">Season rankings</h1>
        <p className="text-[12px] text-[var(--text-secondary)]">{players.length} players</p>
      </div>

      <PlayerSearchFilter players={players} />
    </main>
  );
}
