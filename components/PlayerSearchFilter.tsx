// components/PlayerSearchFilter.tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

const PLAYERS_LEADERBOARD_QUERY = `
  query PlayersLeaderboard($page: Int, $pageSize: Int, $search: String) {
    playersLeaderboard(page: $page, pageSize: $pageSize, search: $search) {
      totalCount
      players {
        id
        tag
        region
        avatarUrl
        characters
        wins
        losses
        points
        winRate
        isLiveOnTwitch
      }
    }
  }
`;

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

// Real server-side pagination + search (settled July 29, 2026 — scales to
// 100k+ players, replacing the old fetch-1000-then-slice-client-side
// approach). initialPlayers/initialTotalCount are the server-rendered page 1
// (no search) from app/players/page.tsx, so there's no flash of an empty
// list on first paint; every subsequent page/pageSize/search change re-fetches
// playersLeaderboard directly.
//
// "Twitch Online" stays a client-side filter over just the CURRENTLY
// fetched page, not a server-side query param — isLiveOnTwitch is a live
// per-request Twitch API check (see the Player.isLiveOnTwitch resolver), not
// a stored/queryable Mongo field, so there's no way to ask the database for
// "every online player" without checking every candidate's live status
// first. A known, disclosed simplification: toggling it on can show fewer
// than a full page (or zero) if none of the current page's players happen
// to be live right now, rather than searching every player for whoever's
// online.
//
// rank (1st/2nd/3rd/Top 8 badges) is this player's position on the CURRENT
// page's server-provided order — since the server already returns players
// sorted by points descending, rank = (page-1)*pageSize + index + 1 is each
// player's true site-wide rank, not just a position within the page.
export function PlayerSearchFilter({
  initialPlayers,
  initialTotalCount,
}: {
  initialPlayers: Player[];
  initialTotalCount: number;
}) {
  const [query, setQuery] = useState("");
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [players, setPlayers] = useState<Player[]>(initialPlayers);
  const [totalCount, setTotalCount] = useState(initialTotalCount);
  const [loading, setLoading] = useState(false);

  // Debounced so every keystroke doesn't fire its own request — 300ms, same
  // ballpark as this codebase's other type-to-search inputs.
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  // Skips the redundant fetch on first mount — initialPlayers/initialTotalCount
  // already ARE page 1 with no search, exactly what this effect would ask for.
  const isFirstRun = useRef(true);
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }

    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: PLAYERS_LEADERBOARD_QUERY,
            variables: { page, pageSize, search: debouncedQuery || undefined },
          }),
        });
        const json = await res.json();
        if (cancelled) return;
        if (json.errors) {
          console.error("[PlayerSearchFilter] GraphQL errors:", json.errors);
          return;
        }
        setPlayers(json.data?.playersLeaderboard?.players ?? []);
        setTotalCount(json.data?.playersLeaderboard?.totalCount ?? 0);
      } catch (err) {
        console.error("[PlayerSearchFilter] fetch error:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [page, pageSize, debouncedQuery]);

  const visible = useMemo(() => {
    // rank must come from each player's position in the full (unfiltered)
    // page BEFORE the onlineOnly filter runs -- filtering first would
    // renumber/compress ranks, same bug class the old client-side version's
    // own comment called out ("ranks computed from the full original list").
    const ranked = players.map((p, i) => ({ ...p, rank: (page - 1) * pageSize + i + 1 }));
    return onlineOnly ? ranked.filter(p => p.isLiveOnTwitch) : ranked;
  }, [players, onlineOnly, page, pageSize]);

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
          placeholder="Search by player tag…"
          className="flex-1 px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
          style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
        />
        <button
          type="button"
          onClick={() => setOnlineOnly(v => !v)}
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

      <div className="fgc-card" style={{ opacity: loading ? 0.6 : 1, transition: "opacity 0.15s" }}>
        {visible.length === 0 && (
          <p className="p-6 text-[var(--text-secondary)]">
            {query || onlineOnly ? "No players match your filters." : "No players yet. Register to join the leaderboard!"}
          </p>
        )}
        {visible.map(player => (
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
        page={page}
        pageSize={pageSize}
        totalItems={totalCount}
        onPageChange={setPage}
        onPageSizeChange={size => {
          setPageSize(size);
          setPage(1);
        }}
      />
    </>
  );
}
