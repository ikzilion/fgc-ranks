// components/EventSearchFilter.tsx
// Card grid, not list rows — per the settled design ("browsable cards"),
// distinct from TournamentSearchFilter/PlayerSearchFilter's row layout.
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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(event => (
            <Link
              key={event.id}
              href={`/events/${event.id}`}
              className="fgc-card p-4 flex flex-col gap-3 hover:bg-[var(--navy-3)] transition-colors"
            >
              <div className="flex items-center gap-3">
                <div
                  className="w-12 h-12 rounded flex items-center justify-center flex-shrink-0 font-rajdhani text-[14px] font-bold overflow-hidden"
                  style={{ background: "var(--blue-dim)", border: "1px solid rgba(79,142,247,0.3)", color: "var(--blue)" }}
                >
                  {event.logoUrl ? (
                    <img src={event.logoUrl} alt={event.name} className="w-full h-full object-cover" />
                  ) : (
                    event.name.slice(0, 2).toUpperCase()
                  )}
                </div>
                <div className="min-w-0">
                  <p className="font-rajdhani text-[16px] font-bold text-[var(--text-primary)] leading-tight truncate">
                    {event.name}
                  </p>
                  <p className="text-[10px] font-mono text-[var(--text-muted)]">{event.displayId}</p>
                </div>
              </div>
              <p className="text-[12px] text-[var(--text-secondary)] truncate">
                {event.isOnlineOnly ? "🌐 Online only" : event.address || "Location not set"}
              </p>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
