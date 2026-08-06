// components/GameSearchFilter.tsx
"use client";

import { useState, useMemo } from "react";
import Link from "next/link";

interface Game {
  id: string;
  name: string;
  iconUrl?: string;
  tournamentCount: number;
}

// Client-side filtering only, same pattern as TournamentSearchFilter -- the
// games list is a handful to a few dozen entries, nowhere near the scale
// that made PlayerSearchFilter need real server-side pagination.
export function GameSearchFilter({ games }: { games: Game[] }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!query.trim()) return games;
    const q = query.toLowerCase();
    return games.filter(g => g.name.toLowerCase().includes(q));
  }, [games, query]);

  return (
    <>
      <input
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Search games…"
        className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)] mb-4"
        style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
      />

      <div className="fgc-card">
        {filtered.length === 0 && (
          <p className="p-6 text-[var(--text-secondary)]">
            {query ? "No games match your search." : "No games yet."}
          </p>
        )}
        {filtered.map(game => (
          <Link
            key={game.id}
            href={`/games/${encodeURIComponent(game.name)}`}
            className="flex items-center gap-4 px-5 py-3 border-b border-[var(--border)] last:border-0 hover:bg-[var(--navy-3)] transition-colors"
          >
            <div
              className="w-11 h-11 rounded-[10px] flex items-center justify-center flex-shrink-0 font-rajdhani text-[13px] font-bold overflow-hidden"
              style={{ background: "var(--blue-dim)", border: "1px solid rgba(79,142,247,0.3)", color: "var(--blue)" }}
            >
              {game.iconUrl ? (
                <img src={game.iconUrl} alt={game.name} className="w-full h-full object-cover" />
              ) : (
                game.name.slice(0, 2).toUpperCase()
              )}
            </div>
            <p className="flex-1 min-w-0 font-rajdhani text-[16px] font-bold text-[var(--text-primary)] truncate">
              {game.name}
            </p>
            <p className="text-[12px] text-[var(--text-muted)] flex-shrink-0">
              {game.tournamentCount} tournament{game.tournamentCount === 1 ? "" : "s"}
            </p>
          </Link>
        ))}
      </div>
    </>
  );
}
