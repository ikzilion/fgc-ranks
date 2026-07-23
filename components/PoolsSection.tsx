// components/PoolsSection.tsx
"use client";

import { useState } from "react";
import { BracketView } from "./BracketView";
import { GeneratePoolsButton } from "./GeneratePoolsButton";
import { GenerateMainBracketButton } from "./GenerateMainBracketButton";
import { DeletePoolsButton } from "./DeletePoolsButton";
import { DeleteMainBracketButton } from "./DeleteMainBracketButton";

interface PoolBracketMatch {
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
}

interface PoolEntrant {
  id: string;
  player: { id: string; tag: string; avatarUrl?: string | null };
}

interface PoolBracket {
  seedingMethod: string;
  size: number;
  matches: PoolBracketMatch[];
}

interface PoolData {
  id: string;
  poolNumber: number;
  entrants: PoolEntrant[];
  bracket: PoolBracket | null;
}

// A pool is "decided" the same way the server treats it (see resolvers'
// isBracketDecided): a Grand Final Reset match, if one exists, is the true
// decider; otherwise a completed Grand Final (no reset needed) is.
function poolAdvancers(pool: PoolData): { winnersFinalist: string; losersFinalist: string } | null {
  if (!pool.bracket) return null;
  const grandFinal = pool.bracket.matches.find(m => m.bracketSide === "GRAND_FINAL");
  if (!grandFinal?.player1?.id || !grandFinal?.player2?.id) return null;
  const reset = pool.bracket.matches.find(m => m.bracketSide === "GRAND_FINAL_RESET");
  const decided = reset ? reset.status === "COMPLETED" : grandFinal.status === "COMPLETED";
  if (!decided) return null;
  // Grand Final convention: player1 = winners-finalist, player2 = losers-finalist.
  return { winnersFinalist: grandFinal.player1.id, losersFinalist: grandFinal.player2.id };
}

function PoolAdvancementTags({ pool }: { pool: PoolData }) {
  const advancers = poolAdvancers(pool);
  return (
    <div className="flex flex-wrap gap-1.5 mb-4">
      {pool.entrants.map(entrant => {
        if (!advancers) {
          return (
            <span
              key={entrant.id}
              className="text-[11px] px-2 py-1 rounded"
              style={{ background: "var(--navy-3)", color: "var(--text-secondary)" }}
            >
              {entrant.player.tag}
            </span>
          );
        }
        const advanced = entrant.player.id === advancers.winnersFinalist || entrant.player.id === advancers.losersFinalist;
        return (
          <span
            key={entrant.id}
            className="text-[11px] px-2 py-1 rounded"
            style={
              advanced
                ? { background: "rgba(74,222,128,0.12)", color: "var(--green)" }
                : { background: "var(--navy-3)", color: "var(--text-muted)" }
            }
          >
            {entrant.player.tag} {advanced ? "— Advanced" : "— Eliminated"}
          </span>
        );
      })}
    </div>
  );
}

// Small pill-button tab bar — no existing tab component elsewhere in this
// codebase to reuse, so this follows the site's existing button-styling
// conventions (blue = active/primary, navy-4 = inactive, same as e.g.
// GenerateBracketButton's cancel/confirm pair) rather than introducing a
// new visual language.
function TabBar({
  tabs,
  activeKey,
  onSelect,
}: {
  tabs: { key: string; label: string }[];
  activeKey: string;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {tabs.map(tab => {
        const active = tab.key === activeKey;
        return (
          <button
            key={tab.key}
            onClick={() => onSelect(tab.key)}
            className="font-rajdhani text-[13px] font-bold tracking-wide px-3 py-1.5 rounded"
            style={
              active
                ? { background: "var(--blue)", color: "white", border: "none", cursor: "pointer" }
                : { background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border)", cursor: "pointer" }
            }
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export function PoolsSection({
  tournamentId,
  pools,
  mainBracket,
  entrantCount,
  suggestedPoolCount,
  allPoolsComplete,
  canManage,
  lineColor,
  boxColor,
  fontColor,
}: {
  tournamentId: string;
  pools: PoolData[];
  mainBracket: PoolBracket | null;
  entrantCount: number;
  suggestedPoolCount: number;
  allPoolsComplete: boolean;
  canManage: boolean;
  lineColor?: string;
  boxColor?: string;
  fontColor?: string;
}) {
  const hasMainBracket = !!mainBracket;

  // Tab list is stable for the lifetime of one page load — every mutation
  // that changes it (generatePools, generateMainBracket) calls
  // router.refresh(), which remounts this component with fresh props, so a
  // plain useState default (not recomputed on every render) is enough; no
  // effect needed to keep it in sync with prop changes mid-session.
  const tabs = [
    ...(hasMainBracket ? [{ key: "main", label: "Main Bracket" }] : []),
    ...pools.map(p => ({ key: `pool-${p.id}`, label: `Pool ${p.poolNumber}` })),
  ];
  const [activeTab, setActiveTab] = useState(tabs[0]?.key);

  if (pools.length === 0) {
    return (
      <div className="fgc-card p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">Pools</p>
            <p className="text-[13px] text-[var(--text-secondary)] mt-1">
              {canManage ? "Split entrants into pools to begin the pool stage." : "Pools haven't been generated yet."}
            </p>
          </div>
          <GeneratePoolsButton
            tournamentId={tournamentId}
            entrantCount={entrantCount}
            suggestedPoolCount={suggestedPoolCount}
            canManage={canManage}
          />
        </div>
      </div>
    );
  }

  const activePool = pools.find(p => `pool-${p.id}` === activeTab);

  return (
    <div className="fgc-card p-6" style={{ overflow: "visible" }}>
      <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Pools</p>
          <TabBar tabs={tabs} activeKey={activeTab ?? tabs[0].key} onSelect={setActiveTab} />
          {!allPoolsComplete && (
            <p className="text-[11px] text-[var(--text-muted)] mt-2">
              Top 2 finishers of each pool (winners-finalist + losers-finalist) advance to the main bracket once every pool finishes.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {hasMainBracket ? (
            <DeleteMainBracketButton tournamentId={tournamentId} canManage={canManage} />
          ) : (
            <>
              <GenerateMainBracketButton tournamentId={tournamentId} allPoolsComplete={allPoolsComplete} canManage={canManage} />
              {/* Full reset is allowed mid-play, not just before any results —
                  deletePools itself is what actually blocks this once a main
                  bracket exists (delete that first), so this button doesn't
                  need its own extra gating beyond hasMainBracket above. */}
              <DeletePoolsButton tournamentId={tournamentId} canManage={canManage} />
            </>
          )}
        </div>
      </div>

      {activeTab === "main" && mainBracket && (
        <BracketView bracket={mainBracket} canManage={canManage} lineColor={lineColor} boxColor={boxColor} fontColor={fontColor} />
      )}

      {activePool && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="font-rajdhani text-lg font-bold text-[var(--text-primary)]">Pool {activePool.poolNumber}</p>
            <p className="text-[11px] text-[var(--text-muted)]">{activePool.entrants.length} entrants</p>
          </div>
          <PoolAdvancementTags pool={activePool} />
          {activePool.bracket ? (
            <BracketView bracket={activePool.bracket} canManage={canManage} lineColor={lineColor} boxColor={boxColor} fontColor={fontColor} />
          ) : (
            <p className="text-[13px] text-[var(--text-secondary)]">No bracket for this pool yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
