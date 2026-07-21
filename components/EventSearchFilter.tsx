// components/EventSearchFilter.tsx
// Card grid, not list rows — per the settled design ("browsable cards"),
// distinct from TournamentSearchFilter/PlayerSearchFilter's row layout.
// Cards use flex-wrap + a min-width (not a fixed grid-cols-N) so they grow
// to fill each row's leftover space — with only 1-2 Events, a rigid
// grid-cols-3 still reserves 3 equal tracks and leaves the unused ones
// blank; flex-wrap only creates as many "columns" as there are cards per
// row, so a lone card stretches to fill the row instead of sitting narrow
// next to empty space.
"use client";

import { useState, useMemo } from "react";
import Link from "next/link";

interface EventCard {
  id: string;
  displayId: string;
  name: string;
  logoUrl?: string | null;
  isOnlineOnly: boolean;
  address?: string | null;
  twitchUrl?: string | null;
  tournamentCount: number;
  gameCount: number;
}

export function EventSearchFilter({ events }: { events: EventCard[] }) {
  const [query, setQuery] = useState("");
  const [onlineOnly, setOnlineOnly] = useState(false);

  const filtered = useMemo(() => {
    let result = events;
    if (onlineOnly) {
      result = result.filter(e => e.isOnlineOnly);
    }
    if (query.trim()) {
      const q = query.toLowerCase();
      result = result.filter(
        e =>
          e.name.toLowerCase().includes(q) ||
          e.address?.toLowerCase().includes(q) ||
          e.displayId.toLowerCase().includes(q)
      );
    }
    return result;
  }, [events, query, onlineOnly]);

  return (
    <>
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search by name, location, or Event ID…"
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
          🌐 Online only
        </button>
      </div>

      {filtered.length === 0 ? (
        <div className="fgc-card p-6">
          <p className="text-[var(--text-secondary)]">
            {query || onlineOnly ? "No events match your filters." : "No events yet."}
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap gap-4">
          {filtered.map(event => (
            <Link
              key={event.id}
              href={`/events/${event.id}`}
              className="fgc-card p-4 flex flex-col gap-3 hover:bg-[var(--navy-3)] transition-colors flex-1 min-w-[280px]"
            >
              <div className="flex items-center gap-3">
                <div
                  className="w-14 h-14 rounded flex items-center justify-center flex-shrink-0 font-rajdhani text-[16px] font-bold overflow-hidden"
                  style={{ background: "var(--blue-dim)", border: "1px solid rgba(79,142,247,0.3)", color: "var(--blue)" }}
                >
                  {event.logoUrl ? (
                    <img src={event.logoUrl} alt={event.name} className="w-full h-full object-cover" />
                  ) : (
                    event.name.slice(0, 2).toUpperCase()
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-rajdhani text-[17px] font-bold text-[var(--text-primary)] leading-tight truncate">
                    {event.name}
                  </p>
                  <p className="text-[10px] font-mono text-[var(--text-muted)]">{event.displayId}</p>
                </div>
                {event.twitchUrl && (
                  <span
                    title="Has a Twitch link"
                    className="text-[10px] font-semibold px-2 py-1 rounded flex-shrink-0"
                    style={{ background: "var(--coral-dim)", color: "var(--coral)" }}
                  >
                    📺 Twitch
                  </span>
                )}
              </div>
              <p className="text-[12px] text-[var(--text-secondary)] truncate">
                {event.isOnlineOnly ? "🌐 Online only" : event.address || "Location not set"}
              </p>
              <p className="text-[12px] font-semibold" style={{ color: "var(--text-secondary)" }}>
                {event.tournamentCount === 0
                  ? "No tournaments yet"
                  : event.gameCount > 1
                    ? `🎮 ${event.gameCount} games · 🏆 ${event.tournamentCount} tournament${event.tournamentCount === 1 ? "" : "s"}`
                    : `🏆 ${event.tournamentCount} tournament${event.tournamentCount === 1 ? "" : "s"}`}
              </p>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
