// components/TournamentSearchFilter.tsx
"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { DeleteTournamentButton } from "@/components/DeleteTournamentButton";
import { CancelTournamentButton } from "@/components/CancelTournamentButton";
import { Pagination } from "@/components/Pagination";

interface Tournament {
  id: string;
  name: string;
  game: string;
  status: string;
  cancellationReason?: string | null;
  visibility: string;
  entrantCount: number;
  startDate: string;
  isOnlineOnly: boolean;
  address?: string | null;
  canManage: boolean;
}

function statusBadge(status: string) {
  if (status === "LIVE")
    return (
      <span className="badge-live text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded flex items-center gap-1">
        <span className="live-dot" /> Live
      </span>
    );
  if (status === "UPCOMING")
    return <span className="badge-upcoming text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded">Upcoming</span>;
  if (status === "CANCELLED")
    return (
      <span
        className="text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded"
        style={{ background: "var(--coral-dim)", color: "var(--coral)" }}
      >
        Cancelled
      </span>
    );
  return <span className="badge-ended text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded">Ended</span>;
}

export function TournamentSearchFilter({
  tournaments,
  // Pre-fills the search box — used by the Games list's "browse this game's
  // tournaments" links (/tournaments?game=<name>). Reuses this component's
  // own existing name/game/address search-match logic rather than adding a
  // separate filtering mechanism, so it's exactly as (im)precise as typing
  // the game name into the box yourself would be.
  initialQuery = "",
}: {
  tournaments: Tournament[];
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const filtered = useMemo(() => {
    let result = tournaments;
    if (onlineOnly) {
      result = result.filter(t => t.isOnlineOnly);
    }
    if (query.trim()) {
      const q = query.toLowerCase();
      result = result.filter(
        t =>
          t.name.toLowerCase().includes(q) ||
          t.game.toLowerCase().includes(q) ||
          t.address?.toLowerCase().includes(q)
      );
    }
    return result;
  }, [tournaments, query, onlineOnly]);

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
          placeholder="Search by name, game, or location…"
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
          🌐 Online only
        </button>
      </div>

      <div className="fgc-card">
        {filtered.length === 0 && (
          <p className="p-6 text-[var(--text-secondary)]">
            {query || onlineOnly ? "No tournaments match your filters." : "No tournaments yet."}
          </p>
        )}
        {paged.map(tournament => (
          <div
            key={tournament.id}
            className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-5 py-3 border-b border-[var(--border)] last:border-0 hover:bg-[var(--navy-3)] transition-colors"
          >
            <Link href={`/tournaments/${tournament.id}`} className="flex-1 min-w-0">
              <p className="font-rajdhani text-[16px] font-bold text-[var(--text-primary)] leading-tight">
                {tournament.visibility === "PRIVATE" && <span className="mr-1">🔒</span>}
                {tournament.name}
              </p>
              <p className="text-[12px] text-[var(--text-secondary)] truncate">
                {tournament.game} · {tournament.entrantCount} entrants · {new Date(tournament.startDate).toLocaleDateString()}
                {tournament.isOnlineOnly ? " · 🌐 Online" : tournament.address ? ` · ${tournament.address}` : ""}
              </p>
              {tournament.status === "CANCELLED" && tournament.cancellationReason && (
                <p className="text-[12px] mt-0.5 truncate" style={{ color: "var(--coral)" }}>
                  Reason: {tournament.cancellationReason}
                </p>
              )}
            </Link>
            <div className="flex items-center gap-2 flex-shrink-0">
              {statusBadge(tournament.status)}
              {tournament.canManage && tournament.status !== "CANCELLED" && (
                <CancelTournamentButton tournamentId={tournament.id} canManage={tournament.canManage} />
              )}
              <DeleteTournamentButton tournamentId={tournament.id} canManage={tournament.canManage} />
            </div>
          </div>
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
