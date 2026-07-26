// app/tournaments/[id]/results/page.tsx
// Shareable post-tournament results page — Top 8 real placements, each
// player's avatar, the tournament's game logo, and a link back to the full
// bracket. Distinct from the in-progress Top 24/Top 8 filtered bracket-view
// tabs (commit d8bcdf6, which apply DURING a Model A/C main bracket while
// it's still narrowing) — this is a read-only view of already-final data,
// reusing the same Entrant.placement every tournament format (standard
// bracket, Pools + Bracket Models A/B/C) already writes via
// computeAndApplyBracketPlacements. No new data model, no new mutations.

import { notFound } from "next/navigation";
import Link from "next/link";

export const dynamic = "force-dynamic";

const GET_TOURNAMENT_RESULTS = `
  query GetTournamentResults($id: ID!) {
    tournament(id: $id) {
      id
      name
      game
      status
      entrants {
        placement
        player {
          id
          tag
          avatarUrl
        }
      }
    }
    games {
      name
      iconUrl
    }
  }
`;

async function getTournamentResults(id: string) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  try {
    const res = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: GET_TOURNAMENT_RESULTS, variables: { id } }),
      cache: "no-store",
    });
    const json = await res.json();
    if (json.errors) {
      console.error("[tournaments/[id]/results] GraphQL errors:", json.errors);
      return { tournament: null, games: [] };
    }
    return { tournament: json.data?.tournament ?? null, games: json.data?.games ?? [] };
  } catch (err) {
    console.error("[tournaments/[id]/results] Fetch error:", err);
    return { tournament: null, games: [] };
  }
}

function ordinal(n: number) {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  if (n % 10 === 1) return "st";
  if (n % 10 === 2) return "nd";
  if (n % 10 === 3) return "rd";
  return "th";
}

// Same gold/silver/bronze convention as the player profile page's
// tournament-history placement badges.
function placementStyle(placement: number) {
  if (placement === 1) return { background: "var(--gold-dim)", color: "var(--gold)", border: "1px solid rgba(240,180,41,0.2)" };
  if (placement === 2) return { background: "rgba(192,200,216,0.1)", color: "#C0C8D8", border: "1px solid rgba(192,200,216,0.2)" };
  if (placement === 3) return { background: "rgba(205,127,50,0.1)", color: "#CD7F32", border: "1px solid rgba(205,127,50,0.2)" };
  return { background: "var(--navy-4)", color: "var(--text-muted)", border: "1px solid var(--border)" };
}

export default async function TournamentResultsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { tournament, games } = await getTournamentResults(id);
  if (!tournament) notFound();

  const gameIcon = games.find((g: any) => g.name === tournament.game)?.iconUrl ?? "";

  // Real placements only, in order, capped at 8 — no padding with fake
  // entries for a bracket that produced fewer than 8 real placements.
  const top8 = [...tournament.entrants]
    .filter((e: any) => e.placement != null)
    .sort((a: any, b: any) => a.placement - b.placement)
    .slice(0, 8);

  return (
    <main className="max-w-2xl mx-auto px-4 py-8">
      <div className="fgc-card p-6 mb-6 flex items-center gap-4">
        <div
          className="w-14 h-14 rounded-[10px] flex items-center justify-center flex-shrink-0 font-rajdhani text-lg font-bold overflow-hidden"
          style={{ background: "var(--blue-dim)", border: "1px solid rgba(79,142,247,0.3)", color: "var(--blue)" }}
        >
          {gameIcon ? (
            <img src={gameIcon} alt={tournament.game} className="w-full h-full object-cover" />
          ) : (
            tournament.game.slice(0, 2).toUpperCase()
          )}
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-1">Final Results</p>
          <h1 className="font-rajdhani text-2xl font-bold text-[var(--text-primary)] leading-tight">{tournament.name}</h1>
          <p className="text-[13px] text-[var(--text-secondary)]">{tournament.game}</p>
        </div>
      </div>

      <h2 className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">Top {top8.length || 8}</h2>
      <div className="fgc-card mb-6">
        {top8.length === 0 ? (
          <p className="p-6 text-[var(--text-secondary)]">No results recorded yet.</p>
        ) : (
          top8.map((entry: any) => (
            <Link
              key={entry.player.id}
              href={`/players/${entry.player.id}`}
              className="flex items-center gap-4 px-5 py-3 border-b border-[var(--border)] last:border-0 hover:bg-[var(--navy-3)] transition-colors"
            >
              <div
                className="min-w-10 h-10 px-1.5 rounded flex items-center justify-center font-rajdhani text-[13px] font-bold flex-shrink-0"
                style={placementStyle(entry.placement)}
              >
                {entry.placement}
                {ordinal(entry.placement)}
              </div>
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 font-rajdhani text-[13px] font-bold overflow-hidden"
                style={{ background: "var(--blue-dim)", color: "var(--blue)", border: "1px solid rgba(79,142,247,0.3)" }}
              >
                {entry.player.avatarUrl ? (
                  <img src={entry.player.avatarUrl} alt={entry.player.tag} className="w-full h-full object-cover" />
                ) : (
                  entry.player.tag.slice(0, 2).toUpperCase()
                )}
              </div>
              <p className="flex-1 font-rajdhani text-[16px] font-semibold text-[var(--text-primary)] truncate">{entry.player.tag}</p>
              {entry.placement === 1 && <span className="text-xl">🏆</span>}
            </Link>
          ))
        )}
      </div>

      <div className="flex items-center justify-between">
        <Link href={`/tournaments/${tournament.id}`} className="text-[13px] text-[var(--text-secondary)] hover:text-[var(--blue)]">
          ← Back to tournament / full bracket
        </Link>
      </div>
    </main>
  );
}
