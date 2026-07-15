// app/players/page.tsx
// Ranked player leaderboard — sorted by points descending.

import Link from "next/link";

const GET_PLAYERS = `
  query {
    players(limit: 50) {
      id
      tag
      region
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

function rankColor(rank: number) {
  if (rank === 1) return "text-[var(--gold)]";
  if (rank === 2) return "text-[#C0C8D8]";
  if (rank === 3) return "text-[#CD7F32]";
  return "text-[var(--text-muted)]";
}

function rankBadge(rank: number) {
  if (rank === 1)
    return <span className="text-[10px] font-bold uppercase px-2 py-1 rounded" style={{ background: "var(--gold-dim)", color: "var(--gold)", border: "1px solid rgba(240,180,41,0.25)" }}>Champion</span>;
  if (rank <= 3)
    return <span className="text-[10px] font-bold uppercase px-2 py-1 rounded" style={{ background: "rgba(192,200,216,0.1)", color: "#C0C8D8", border: "1px solid rgba(192,200,216,0.2)" }}>Top 3</span>;
  if (rank <= 8)
    return <span className="badge-ended text-[10px] font-bold uppercase px-2 py-1 rounded">Top 8</span>;
  return null;
}

export default async function PlayersPage() {
  const players = await getPlayers();

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-rajdhani text-2xl font-bold text-[var(--text-primary)]">Season rankings</h1>
        <p className="text-[12px] text-[var(--text-secondary)]">{players.length} players</p>
      </div>

      <div className="fgc-card">
        {players.length === 0 && (
          <p className="p-6 text-[var(--text-secondary)]">No players yet. Register to join the leaderboard!</p>
        )}
        {players.map((player: any, i: number) => {
          const rank = i + 1;
          return (
            <Link
              key={player.id}
              href={`/players/${player.id}`}
              className="flex items-center gap-2 sm:gap-4 px-3 sm:px-5 py-3 border-b border-[var(--border)] last:border-0 hover:bg-[var(--navy-3)] transition-colors"
            >
              <span className={`font-rajdhani text-[15px] font-bold w-6 flex-shrink-0 ${rankColor(rank)}`}>
                {rank}
              </span>
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 font-rajdhani text-[12px] font-bold"
                style={{ background: "var(--blue-dim)", border: "1px solid rgba(79,142,247,0.3)", color: "var(--blue)" }}
              >
                {player.tag.slice(0, 2).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-rajdhani text-[16px] font-bold text-[var(--text-primary)] leading-tight">{player.tag}</p>
                <p className="text-[12px] text-[var(--text-secondary)] truncate">
                  {player.characters.length > 0 ? player.characters.join(", ") : "No main"} · {player.region || "Unknown region"}
                </p>
              </div>
              <div className="text-right mr-3 hidden sm:block">
                <p className="font-rajdhani text-[15px] font-bold text-[var(--text-primary)]">
                  {player.winRate != null ? `${Math.round(player.winRate * 100)}%` : "—"}
                </p>
                <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">win rate</p>
              </div>
              <div className="text-right mr-3">
                <p className="font-rajdhani text-[16px] font-bold text-[var(--text-primary)]">
                  {player.points.toLocaleString()}
                </p>
                <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">pts</p>
              </div>
              <div className="w-20 flex justify-end">{rankBadge(rank)}</div>
            </Link>
          );
        })}
      </div>
    </main>
  );
}
