// components/PlayerSearchFilter.tsx
"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { Pagination } from "@/components/Pagination";

interface Player {
  id: string;
  tag: string;
  region: string;
  avatarUrl?: string;
  characters: string[];
  wins: number;
  losses: number;
  points: number;
  winRate: number | null;
  isLiveOnTwitch?: boolean;
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

export function PlayerSearchFilter({ players }: { players: Player[] }) {
  const [query, setQuery] = useState("");
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // Ranks are computed from the FULL original list, so filtering (search OR
  // the Twitch Online toggle) never changes a player's rank number.
  const ranked = useMemo(
    () => players.map((p, i) => ({ ...p, rank: i + 1 })),
    [players]
  );

  const filtered = useMemo(() => {
    let result = ranked;
    if (onlineOnly) {
      result = result.filter(p => p.isLiveOnTwitch);
    }
    if (query.trim()) {
      const q = query.toLowerCase();
      result = result.filter(
        p =>
          p.tag.toLowerCase().includes(q) ||
          p.region?.toLowerCase().includes(q) ||
          p.characters.some(c => c.toLowerCase().includes(q))
      );
    }
    return result;
  }, [ranked, query, onlineOnly]);

  // Clamped as a derived value (not synced via an effect) so the current
  // page can never strand the user on now-empty results — e.g. narrowing a
  // search from 4 pages down to 1 while sitting on page 4.
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);

  const paged = useMemo(
    () => filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [filtered, currentPage, pageSize]
  );

  return (
    <>
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <input
          type="text"
          value={query}
          onChange={e => {
            setQuery(e.target.value);
            setPage(1);
          }}
          placeholder="Search by tag, character, or region…"
          className="flex-1 px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
          style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
        />
        <button
          type="button"
          onClick={() => {
            setOnlineOnly(v => !v);
            setPage(1);
          }}
          className="text-[13px] font-semibold px-4 py-2.5 rounded-md whitespace-nowrap"
          style={{
            background: onlineOnly ? "var(--blue)" : "var(--navy-3)",
            color: onlineOnly ? "white" : "var(--text-secondary)",
            border: "1px solid var(--border-strong)",
            cursor: "pointer",
          }}
        >
          🔴 Twitch Online
        </button>
      </div>

      <div className="fgc-card">
        {filtered.length === 0 && (
          <p className="p-6 text-[var(--text-secondary)]">
            {query || onlineOnly ? "No players match your filters." : "No players yet. Register to join the leaderboard!"}
          </p>
        )}
        {paged.map(player => (
          <Link
            key={player.id}
            href={`/players/${player.id}`}
            className="flex items-center gap-2 sm:gap-4 px-3 sm:px-5 py-3 border-b border-[var(--border)] last:border-0 hover:bg-[var(--navy-3)] transition-colors"
          >
            <span className={`font-rajdhani text-[15px] font-bold w-6 flex-shrink-0 ${rankColor(player.rank)}`}>
              {player.rank}
            </span>
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 font-rajdhani text-[12px] font-bold overflow-hidden"
              style={{ background: "var(--blue-dim)", border: "1px solid rgba(79,142,247,0.3)", color: "var(--blue)" }}
            >
              {player.avatarUrl ? (
                <img src={player.avatarUrl} alt={player.tag} className="w-full h-full object-cover" />
              ) : (
                player.tag.slice(0, 2).toUpperCase()
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-rajdhani text-[16px] font-bold text-[var(--text-primary)] leading-tight flex items-center gap-2">
                {player.tag}
                {player.isLiveOnTwitch && (
                  <span
                    className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded flex-shrink-0 flex items-center gap-1"
                    style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.25)" }}
                  >
                    <span className="live-dot" /> Live
                  </span>
                )}
              </p>
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
            <div className="w-20 flex justify-end">{rankBadge(player.rank)}</div>
          </Link>
        ))}
      </div>

      <Pagination
        page={currentPage}
        pageSize={pageSize}
        totalItems={filtered.length}
        onPageChange={setPage}
        onPageSizeChange={size => {
          setPageSize(size);
          setPage(1);
        }}
      />
    </>
  );
}
