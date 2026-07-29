// components/EntrantSearchFilter.tsx
"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { CheckInToggleButton } from "@/components/CheckInToggleButton";
import { SetPlacementButton } from "@/components/SetPlacementButton";
import { RemoveEntrantButton } from "@/components/RemoveEntrantButton";

interface Entrant {
  id: string;
  seed?: number | null;
  placement?: number | null;
  checkedInAt?: string | null;
  player: { id: string; tag: string; avatarUrl?: string | null };
}

// Renders as two separate flex items (search bar + entrant list) instead of
// one block, so a shared flex parent's `order` utilities can place them at
// opposite ends of the mobile column (search top, entrants bottom) with the
// Bracket/Pools section's own flex item sitting between them at `order-2` —
// no duplicated markup for mobile vs desktop, and desktop (where the search
// bar is hidden entirely) keeps this exact sidebar layout unchanged.
export function EntrantSearchFilter({
  entrants,
  canManage,
  tournamentId,
  status,
}: {
  entrants: Entrant[];
  canManage: boolean;
  tournamentId: string;
  status: string;
}) {
  const [query, setQuery] = useState("");

  const sorted = useMemo(
    () => [...entrants].sort((a, b) => (a.seed ?? 999) - (b.seed ?? 999)),
    [entrants]
  );

  const filtered = useMemo(() => {
    if (!query.trim()) return sorted;
    const q = query.toLowerCase();
    return sorted.filter(e => e.player.tag.toLowerCase().includes(q));
  }, [sorted, query]);

  return (
    <>
      {/* Mobile-only (settled scope, July 29, 2026): filters the Entrants
          list below only -- never scrolls to or highlights a bracket match. */}
      <div className="order-1 w-full sm:hidden">
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search entrants by tag…"
          className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
          style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
        />
      </div>

      <div className="order-3 w-full sm:order-none sm:w-72 sm:flex-shrink-0">
        <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">Entrants</p>
        <div className="fgc-card">
          {filtered.length === 0 ? (
            <p className="p-4 text-[var(--text-secondary)] text-[13px]">
              {query.trim() ? "No entrants match your search." : "No entrants yet."}
            </p>
          ) : (
            filtered.map(entrant => (
              // Two-line layout when canManage — photo+name alone on one
              // line (full width to breathe, same as the public/non-managing
              // row below) with the action buttons (Set placement, Remove)
              // on their own row underneath, instead of squeezing all of it
              // onto one line where a long player tag got cut off. A public/
              // non-managing viewer never sees the action row at all, so
              // their row stays exactly the single-line layout it always was.
              <div
                key={entrant.id}
                className="flex flex-col gap-2 px-4 py-2.5 border-b border-[var(--border)] last:border-0 hover:bg-[var(--navy-3)] transition-colors"
              >
                <Link href={`/players/${entrant.player.id}`} className="flex items-center gap-3 min-w-0">
                  <span className="text-[11px] text-[var(--text-muted)] w-5 flex-shrink-0">{entrant.seed ?? "—"}</span>
                  <div
                    className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 font-rajdhani text-[10px] font-bold overflow-hidden"
                    style={{ background: "var(--blue-dim)", color: "var(--blue)", border: "1px solid rgba(79,142,247,0.3)" }}
                  >
                    {entrant.player.avatarUrl ? (
                      <img src={entrant.player.avatarUrl} alt={entrant.player.tag} className="w-full h-full object-cover" />
                    ) : (
                      entrant.player.tag.slice(0, 2).toUpperCase()
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-rajdhani text-[13px] font-semibold text-[var(--text-primary)] truncate">{entrant.player.tag}</p>
                    {entrant.placement && (
                      <p className="text-[11px]" style={{ color: entrant.placement === 1 ? "var(--gold)" : "var(--text-muted)" }}>
                        {entrant.placement === 1 ? "🏆 Champion" : `${entrant.placement}th place`}
                      </p>
                    )}
                    {entrant.checkedInAt && (
                      <p className="text-[11px]" style={{ color: "var(--green)" }}>✓ Checked in</p>
                    )}
                  </div>
                </Link>
                {canManage && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <CheckInToggleButton
                      tournamentId={tournamentId}
                      playerId={entrant.player.id}
                      checkedInAt={entrant.checkedInAt}
                      canManage={canManage}
                      status={status}
                    />
                    <SetPlacementButton entrantId={entrant.id} placement={entrant.placement} canManage={canManage} />
                    <RemoveEntrantButton entrantId={entrant.id} playerTag={entrant.player.tag} canManage={canManage} status={status} />
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
