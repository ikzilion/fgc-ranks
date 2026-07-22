// app/games/page.tsx
// Games browse page — curated games (plus any un-curated drift, see the
// `games` resolver), each linking to the Tournaments list pre-filtered to
// that game via TournamentSearchFilter's existing name/game/address search.

import Link from "next/link";

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

      {games.length === 0 ? (
        <div className="fgc-card p-6">
          <p className="text-[var(--text-secondary)]">No games yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {games.map((game: any) => (
            <Link
              key={game.id}
              href={`/tournaments?game=${encodeURIComponent(game.name)}`}
              className="fgc-card p-5 flex flex-col items-center gap-3 text-center hover:bg-[var(--navy-3)] transition-colors"
            >
              <div
                className="w-14 h-14 rounded-full flex items-center justify-center flex-shrink-0 font-rajdhani text-lg font-bold overflow-hidden"
                style={{ background: "var(--blue-dim)", border: "1px solid rgba(79,142,247,0.3)", color: "var(--blue)" }}
              >
                {game.iconUrl ? (
                  <img src={game.iconUrl} alt={game.name} className="w-full h-full object-cover" />
                ) : (
                  game.name.slice(0, 2).toUpperCase()
                )}
              </div>
              <div>
                <p className="font-rajdhani text-[15px] font-bold text-[var(--text-primary)] leading-tight">{game.name}</p>
                <p className="text-[11px] text-[var(--text-muted)]">
                  {game.tournamentCount} tournament{game.tournamentCount === 1 ? "" : "s"}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
