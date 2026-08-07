// components/StandardBracketSection.tsx
"use client";

import { useState } from "react";
import { BracketView } from "./BracketView";
import { GenerateBracketButton } from "./GenerateBracketButton";
import { computeLiveEntrantCount, filterBracketToTier, TabBar } from "@/lib/bracketTierView";

interface EntrantOption {
  id: string;
  player: { id: string; tag: string };
}

interface FullBracketMatch {
  id: string;
  round: string;
  status: string;
  bracketSide: string;
  bracketRound: number;
  bracketPosition: number;
  player1Score: number;
  player2Score: number;
  isForfeit: boolean;
  player1?: { id: string; tag: string } | null;
  player2?: { id: string; tag: string } | null;
  winner?: { id: string; tag: string } | null;
  nextMatch?: { id: string } | null;
  nextLoserMatch?: { id: string } | null;
  canUndo?: boolean;
}

// The real tournament.bracket shape (see app/tournaments/[id]/page.tsx's
// GET_TOURNAMENT query) — a superset of lib/bracketTierView.tsx's minimal
// TierBracket, so it satisfies filterBracketToTier's <T extends TierBracket>
// constraint while still carrying every field BracketView needs to render.
interface FullBracket {
  id?: string;
  seedingMethod: string;
  size: number;
  matches: FullBracketMatch[];
  seedOrder?: { id: string }[];
}

// Standard (non-Pools+Bracket) tournaments' own bracket section — previously
// just rendered BracketView directly with no tab bar at all. This ports the
// same live-narrowing Top 24/Top 8 filtered-view tabs Models A/C's main
// bracket already has (PoolsSection.tsx, commit d8bcdf6), reusing the
// extracted lib/bracketTierView.tsx logic unchanged rather than
// reimplementing it — same >=48/>=16 entrant thresholds, same trailing-
// rounds slicing technique. A tab bar only appears once there's an actual
// choice to make (Top 24 or Top 8 has become eligible) — a small tournament
// that never reaches either threshold renders exactly as it always has, no
// single-tab clutter.
export function StandardBracketSection({
  tournamentId,
  bracket,
  entrants,
  canManage,
  highlightedPlayerIds,
}: {
  tournamentId: string;
  bracket: FullBracket | null;
  entrants: EntrantOption[];
  canManage: boolean;
  // Player-search highlighting (Aug 1, 2026) — same convention as
  // PoolsSection.tsx: empty Set means nothing highlighted.
  highlightedPlayerIds: Set<string>;
}) {
  const mainStartCount = bracket?.seedOrder?.length ?? 0;
  const liveCount = bracket ? computeLiveEntrantCount(bracket) : 0;
  const showTop24 = !!bracket && mainStartCount >= 48 && liveCount <= 24;
  const showTop8 = !!bracket && mainStartCount >= 16 && liveCount <= 8;
  const showTabs = showTop24 || showTop8;
  const bracketHasHighlight = !!bracket?.seedOrder?.some(p => highlightedPlayerIds.has(p.id));

  const tabs = showTabs
    ? [
        { key: "main", label: "Main Bracket", hasHighlight: bracketHasHighlight },
        ...(showTop24 ? [{ key: "top24", label: "Top 24", hasHighlight: bracketHasHighlight }] : []),
        ...(showTop8 ? [{ key: "top8", label: "Top 8", hasHighlight: bracketHasHighlight }] : []),
      ]
    : [];
  const [activeTab, setActiveTab] = useState<string>("main");

  const displayedBracket =
    !bracket || activeTab === "main" ? bracket : filterBracketToTier(bracket, activeTab === "top8" ? 8 : 32);

  return (
    <div className="fgc-card p-6" style={{ overflow: "visible" }}>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">Bracket</p>
          {canManage && <p className="text-[11px] text-[var(--text-muted)] mt-0.5">You can report results and manage this bracket.</p>}
          {showTabs && (
            <div className="mt-2">
              <TabBar tabs={tabs} activeKey={activeTab} onSelect={setActiveTab} />
            </div>
          )}
          {(activeTab === "top24" || activeTab === "top8") && (
            <p className="text-[11px] text-[var(--text-muted)] mt-2">
              {liveCount} live {liveCount === 1 ? "entrant" : "entrants"} remaining — the complete Main Bracket is always available in its own tab.
            </p>
          )}
        </div>
        {canManage && (
          <GenerateBracketButton tournamentId={tournamentId} entrants={entrants} canManage={canManage} hasBracket={!!bracket} />
        )}
      </div>
      {displayedBracket ? (
        // No lineColor/boxColor/fontColor here -- Stream-only (Aug 1, 2026),
        // same as PoolsSection's own BracketView calls. This component only
        // ever renders on the Overview page (see TournamentBracketSection.tsx).
        <BracketView bracket={displayedBracket} canManage={canManage} highlightedPlayerIds={highlightedPlayerIds} />
      ) : (
        <p className="text-[13px] text-[var(--text-secondary)]">No bracket generated yet.</p>
      )}
    </div>
  );
}
