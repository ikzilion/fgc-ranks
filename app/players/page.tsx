// app/players/page.tsx
import { auth } from "@/lib/auth";
import { PlayerCard } from "@/components/PlayerCard";
import { PlayerSearchFilter } from "@/components/PlayerSearchFilter";

export const dynamic = "force-dynamic";

const GET_PLAYERS = `
  query {
    players(limit: 50) {
      id
      tag
      displayId
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

// Same shape as the homepage's GET_HOME_PLAYER query — this is the same
// "your player card" widget (components/PlayerCard.tsx), so it needs the
// same fields.
const GET_OWN_PLAYER = `
  query GetOwnPlayer($id: ID!) {
    player(id: $id) {
      id
      tag
      region
      team
      avatarUrl
      wins
      losses
      points
    }
  }
`;

async function getPlayersPageData(playerId?: string) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  try {
    const [listJson, ownJson] = await Promise.all([
      fetch(`${baseUrl}/api/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: GET_PLAYERS }),
        cache: "no-store",
      }).then(r => r.json()),
      playerId
        ? fetch(`${baseUrl}/api/graphql`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: GET_OWN_PLAYER, variables: { id: playerId } }),
            cache: "no-store",
          }).then(r => r.json())
        : Promise.resolve(null),
    ]);

    if (listJson.errors) console.error("[players] GraphQL errors:", JSON.stringify(listJson.errors, null, 2));
    if (ownJson?.errors) console.error("[players] GraphQL own-player errors:", ownJson.errors);

    return {
      players: listJson.data?.players ?? [],
      ownPlayer: ownJson?.data?.player ?? null,
    };
  } catch (err) {
    console.error("[players] fetch error:", err);
    return { players: [], ownPlayer: null };
  }
}

export default async function PlayersPage() {
  const session = await auth();
  const playerId = (session?.user as any)?.playerId ?? undefined;
  const { players, ownPlayer } = await getPlayersPageData(playerId);

  return (
    <main className="max-w-6xl mx-auto px-4 py-8">
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-6">
        {/* LEFT — same player card / sign-in prompt as the homepage */}
        <div className="sm:col-span-1 order-1">
          <PlayerCard player={ownPlayer} />
        </div>

        {/* RIGHT — existing players list + search/filter, unchanged */}
        <div className="sm:col-span-3 order-2">
          <div className="flex items-center justify-between mb-6">
            <h1 className="font-rajdhani text-2xl font-bold text-[var(--text-primary)]">Season rankings</h1>
            <p className="text-[12px] text-[var(--text-secondary)]">{players.length} players</p>
          </div>

          <PlayerSearchFilter players={players} />
        </div>
      </div>
    </main>
  );
}
