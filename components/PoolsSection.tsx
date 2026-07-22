// components/PoolsSection.tsx
"use client";

import { BracketView } from "./BracketView";
import { GeneratePoolsButton } from "./GeneratePoolsButton";
import { GenerateMainBracketButton } from "./GenerateMainBracketButton";

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

interface PoolData {
  id: string;
  poolNumber: number;
  entrants: PoolEntrant[];
  bracket: { seedingMethod: string; size: number; matches: PoolBracketMatch[] } | null;
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

function PoolCard({
  pool,
  canManage,
  lineColor,
  boxColor,
  fontColor,
}: {
  pool: PoolData;
  canManage: boolean;
  lineColor?: string;
  boxColor?: string;
  fontColor?: string;
}) {
  const advancers = poolAdvancers(pool);

  return (
    <div className="fgc-card p-6" style={{ overflow: "visible" }}>
      <div className="flex items-center justify-between mb-3">
        <p className="font-rajdhani text-lg font-bold text-[var(--text-primary)]">Pool {pool.poolNumber}</p>
        <p className="text-[11px] text-[var(--text-muted)]">{pool.entrants.length} entrants</p>
      </div>

      {/* Advancement/elimination status — only meaningful once the pool's
          Grand Final has actually decided a winner. Before that, every
          entrant is just "In progress". */}
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

      {pool.bracket ? (
        <BracketView bracket={pool.bracket} canManage={canManage} lineColor={lineColor} boxColor={boxColor} fontColor={fontColor} />
      ) : (
        <p className="text-[13px] text-[var(--text-secondary)]">No bracket for this pool yet.</p>
      )}
    </div>
  );
}

export function PoolsSection({
  tournamentId,
  pools,
  entrantCount,
  suggestedPoolCount,
  allPoolsComplete,
  hasMainBracket,
  canManage,
  lineColor,
  boxColor,
  fontColor,
}: {
  tournamentId: string;
  pools: PoolData[];
  entrantCount: number;
  suggestedPoolCount: number;
  allPoolsComplete: boolean;
  hasMainBracket: boolean;
  canManage: boolean;
  lineColor?: string;
  boxColor?: string;
  fontColor?: string;
}) {
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

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">Pools</p>
          {!allPoolsComplete && (
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
              Top 2 finishers of each pool (winners-finalist + losers-finalist) advance to the main bracket once every pool finishes.
            </p>
          )}
        </div>
        {!hasMainBracket && (
          <GenerateMainBracketButton tournamentId={tournamentId} allPoolsComplete={allPoolsComplete} canManage={canManage} />
        )}
      </div>

      <div className="flex flex-col gap-4">
        {pools.map(pool => (
          <PoolCard key={pool.id} pool={pool} canManage={canManage} lineColor={lineColor} boxColor={boxColor} fontColor={fontColor} />
        ))}
      </div>
    </div>
  );
}
