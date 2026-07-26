// app/games/[game]/page.tsx
// Dedicated per-game page — the FULL ranked leaderboard for one specific
// game (every player with an in-window result, not just a top-N slice; see
// lib/ranking.ts's computeGameLeaderboard) plus that game's live/upcoming
// tournaments in the right column, reusing the exact same component the
// homepage's 3-column layout already uses for that
// (components/LiveUpcomingTournaments.tsx) rather than a second copy of
// that styling. The existing filtered /tournaments?game=X search view is
// untouched and still reachable — only the /games grid's own link target
// changed to point here instead.

import { notFound } from "next/navigation";
import Link from "next/link";
import { LiveUpcomingTournaments } from "@/components/LiveUpcomingTournaments";

export const dynamic = "force-dynamic";

const GET_GAME_PAGE = `
  query GetGamePage($game: String!) {
    gameLeaderboard(game: $game) {
      rank
      points
      player {
        id
        tag
        avatarUrl
      }
    }
    tournaments(limit: 100) {
      id
      name
      game
      status
      entrantCount
      startDate
    }
  }
`;

async function getGamePageData(game: string) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  try {
    const res = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: GET_GAME_PAGE, variables: { game } }),
      cache: "no-store",
    });
    const json = await res.json();
    if (json.errors) {
      console.error("[games/[game]] GraphQL errors:", json.errors);
      return { leaderboard: [], tournaments: [] };
    }
    return { leaderboard: json.data?.gameLeaderboard ?? [], tournaments: json.data?.tournaments ?? [] };
  } catch (err) {
    console.error("[games/[game]] Fetch error:", err);
    return { leaderboard: [], tournaments: [] };
  }
}

export default async function GamePage({ params }: { params: Promise<{ game: string }> }) {
  const { game: rawGame } = await params;
  const game = decodeURIComponent(rawGame);
  const { leaderboard, tournaments } = await getGamePageData(game);
  const gameTournaments = tournaments.filter((t: any) => t.game === game);

  if (leaderboard.length === 0 && gameTournaments.length === 0) notFound();

  return (
    <main className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-rajdhani text-2xl font-bold text-[var(--text-primary)]">{game}</h1>
          <p className="text-[12px] text-[var(--text-secondary)]">
            {leaderboard.length} ranked player{leaderboard.length === 1 ? "" : "s"}
          </p>
        </div>
        <Link
          href={`/tournaments?game=${encodeURIComponent(game)}`}
          className="text-[12px] font-semibold px-3 py-1.5 rounded"
          style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)" }}
        >
          Search {game} tournaments
        </Link>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-6">
        {/* LEFT/MAIN — full ranked leaderboard for this game */}
        <div className="sm:col-span-3">
          <h2 className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">{game} rankings</h2>
          <div className="fgc-card">
            {leaderboard.length === 0 ? (
              <p className="p-6 text-[var(--text-secondary)]">No ranked players for {game} yet.</p>
            ) : (
              leaderboard.map((entry: any) => (
                <Link
                  key={entry.player.id}
                  href={`/players/${entry.player.id}`}
                  className="flex items-center gap-4 px-5 py-3 border-b border-[var(--border)] last:border-0 hover:bg-[var(--navy-3)] transition-colors"
                >
                  <span className="font-rajdhani text-[15px] font-bold text-[var(--text-muted)] w-8 flex-shrink-0 text-center">
                    #{entry.rank}
                  </span>
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 font-rajdhani text-[11px] font-bold overflow-hidden"
                    style={{ background: "var(--blue-dim)", color: "var(--blue)", border: "1px solid rgba(79,142,247,0.3)" }}
                  >
                    {entry.player.avatarUrl ? (
                      <img src={entry.player.avatarUrl} alt={entry.player.tag} className="w-full h-full object-cover" />
                    ) : (
                      entry.player.tag.slice(0, 2).toUpperCase()
                    )}
                  </div>
                  <p className="flex-1 font-rajdhani text-[15px] font-semibold text-[var(--text-primary)] truncate">{entry.player.tag}</p>
                  <span
                    className="text-[11px] font-bold px-2 py-1 rounded font-rajdhani flex-shrink-0"
                    style={{ background: "var(--gold-dim)", color: "var(--gold)", border: "1px solid rgba(240,180,41,0.25)" }}
                  >
                    {entry.points.toLocaleString()} pts
                  </span>
                </Link>
              ))
            )}
          </div>
        </div>

        {/* RIGHT — live/upcoming tournaments for this game, same styling as the homepage's right column */}
        <div className="sm:col-span-1">
          <LiveUpcomingTournaments tournaments={gameTournaments} viewAllHref={`/tournaments?game=${encodeURIComponent(game)}`} viewAllLabel={`View all ${game} tournaments`} />
        </div>
      </div>
    </main>
  );
}
