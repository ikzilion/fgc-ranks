// lib/bracketTierView.tsx
//
// Shared, format-agnostic "live-narrowing filtered bracket view" logic —
// extracted from components/PoolsSection.tsx (where it originated, commit
// d8bcdf6) so components/StandardBracketSection.tsx (standard/bracket-only
// tournaments) can reuse it unchanged instead of duplicating it. Operates
// purely on the generic Bracket GraphQL shape (seedingMethod/size/matches/
// seedOrder) — works identically whether that bracket is a Pools+Bracket
// Model A/C main bracket or a standard tournament's own bracket, since both
// are literally the same underlying type.
"use client";

interface TierMatch {
  id: string;
  status: string;
  bracketSide: string;
  bracketRound: number;
  player1?: { id: string } | null;
  player2?: { id: string } | null;
  winner?: { id: string } | null;
}

export interface TierBracket {
  seedingMethod: string;
  size: number;
  matches: TierMatch[];
  seedOrder?: { id: string }[];
}

// "Live entrant count" = pool advancers (bracket.seedOrder) minus
// already-eliminated entrants (2 losses in this bracket; standard
// double-elim), recomputed from current match results every render (no
// stored/cached elimination state). GRAND_FINAL_RESET is just another
// bracket match here — its loser's 2nd loss eliminates them exactly like
// any Losers-side match would.
export function computeLiveEntrantCount(bracket: TierBracket): number {
  if (!bracket.seedOrder) return 0;
  const losses = new Map<string, number>();
  for (const m of bracket.matches) {
    if (m.status !== "COMPLETED" || !m.winner) continue;
    const loserId = m.player1 && m.winner.id === m.player1.id ? m.player2?.id : m.player1?.id;
    if (!loserId) continue;
    losses.set(loserId, (losses.get(loserId) ?? 0) + 1);
  }
  return bracket.seedOrder.filter(p => (losses.get(p.id) ?? 0) < 2).length;
}

// How many TRAILING Winners/Losers rounds make up a Top-N filtered view,
// never used to render anything directly.
export function trailingRoundCounts(size: number, side: "WINNERS" | "LOSERS"): number[] {
  const m = Math.log2(size);
  if (side === "WINNERS") {
    const counts: number[] = [];
    for (let r = 1; r <= m; r++) counts.push(size / 2 ** r);
    return counts;
  }
  if (m === 1) return [];
  const counts: number[] = [];
  let current = size / 4;
  counts.push(current);
  for (let j = 1; j <= m - 1; j++) {
    const isLastDropIn = j === m - 1;
    counts.push(current);
    if (!isLastDropIn) {
      current = current / 2;
      counts.push(current);
    }
  }
  return counts;
}

// A live-narrowing PRESENTATION filter, not a new bracket: same underlying
// Bracket/Match data, just the trailing `tierSize`-worth of Winners/Losers
// rounds (plus Grand Finals, always included). See PoolsSection.tsx's
// original header comment (unchanged) for the full structural reasoning —
// this works cleanly with BracketView completely unchanged because of one
// structural fact about every double-elimination bracket this codebase
// generates: the trailing K Winners/Losers rounds of a size-S bracket have
// IDENTICAL per-round entrant counts AND identical 0-indexed bracketPosition
// numbering to the full round sequence of a standalone size-2^K bracket.
export function filterBracketToTier<T extends TierBracket>(bracket: T, tierSize: number): T {
  const wbOffset = Math.max(0, Math.log2(bracket.size) - Math.log2(tierSize));
  const lbOffset = Math.max(0, trailingRoundCounts(bracket.size, "LOSERS").length - trailingRoundCounts(tierSize, "LOSERS").length);
  const matches = bracket.matches
    .filter(m => {
      if (m.bracketSide === "WINNERS") return m.bracketRound > wbOffset;
      if (m.bracketSide === "LOSERS") return m.bracketRound > lbOffset;
      return true; // GRAND_FINAL / GRAND_FINAL_RESET — always included
    })
    .map(m => {
      if (m.bracketSide === "WINNERS") return { ...m, bracketRound: m.bracketRound - wbOffset };
      if (m.bracketSide === "LOSERS") return { ...m, bracketRound: m.bracketRound - lbOffset };
      return m;
    });
  return { ...bracket, size: tierSize, matches };
}

// Model B pool-round tab label: "Top 24" once a round's own single pool is
// the real Finals-cutoff round (Pool.isFinalsCutoff — see lib/bracket.ts's
// buildFinalsCutoffBracket), else "Round {r}". Shared between
// PoolsSection.tsx (TO-facing Overview page) and StreamBracket.tsx (OBS
// broadcast page) on purpose — this used to be duplicated verbatim in both,
// which is exactly how the "Semifinal Cutoff" -> "Top 24" rename (commit
// 1724d03) landed in PoolsSection.tsx but silently never touched
// StreamBracket.tsx's own copy (confirmed via a real user report, Aug 8,
// 2026, the Stream page was still showing "Semifinal Cutoff"/"Finals" after
// that commit shipped). A single shared source makes that class of bug
// structurally impossible to reintroduce a third time.
export interface ModelBRoundLabelPool {
  roundNumber?: number;
  isFinalsCutoff: boolean;
}
export function modelBRoundLabel(pools: ModelBRoundLabelPool[], r: number): string {
  const roundPools = pools.filter(p => (p.roundNumber ?? 1) === r);
  return roundPools.length === 1 && roundPools[0].isFinalsCutoff ? "Top 24" : `Round ${r}`;
}

// Model B's real Finals bracket tab label, once Tournament.mainBracket
// exists — same Standard/Model A/C "Top 8" parity naming already used for
// the equivalent tab elsewhere (settled design, Aug 8, 2026). Shared for the
// same reason modelBRoundLabel above is — a bare string literal duplicated
// across two files is exactly as easy to rename in one place and miss in
// the other as a whole function was.
export const MODEL_B_FINALS_TAB_LABEL = "Top 8";

// Small pill-button tab bar — no existing tab component elsewhere in this
// codebase to reuse, so this follows the site's existing button-styling
// conventions (blue = active/primary, navy-4 = inactive, same as e.g.
// GenerateBracketButton's cancel/confirm pair) rather than introducing a
// new visual language.
export function TabBar({
  tabs,
  activeKey,
  onSelect,
}: {
  tabs: { key: string; label: string; hasHighlight?: boolean }[];
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
            className="relative font-rajdhani text-[13px] font-bold tracking-wide px-3 py-1.5 rounded"
            style={
              active
                ? { background: "var(--blue)", color: "white", border: "none", cursor: "pointer" }
                : { background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border)", cursor: "pointer" }
            }
          >
            {tab.label}
            {/* Marks "the searched player appears somewhere in here" --
                deliberately a separate visual (small corner dot) from the
                active/inactive background above, so a tab can be both
                active AND flagged at once without the two states colliding. */}
            {tab.hasHighlight && (
              <span
                className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full"
                style={{ background: "var(--gold)", border: "1.5px solid var(--navy)" }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
