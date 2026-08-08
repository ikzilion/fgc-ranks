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

import { useEffect, useRef } from "react";

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

// Standard/Model A/Model C's shared Top 24/Top 8 gate — a "Top 24" tab
// appears once live count <=24, but only if the bracket started with >=48
// entrants; "Top 8" once live count <=8, but only if it started with >=16.
// A bracket that never reaches either threshold simply never shows the
// extra tabs. This exact 4-line computation used to be hand-written
// independently in StandardBracketSection.tsx, PoolsSection.tsx (Models
// A/C branch), AND StreamBracket.tsx (Models A/C branch) -- three separate
// chances for one of them to drift from the other two the next time this
// threshold or rule ever changes (settled Aug 8, 2026, after this exact
// class of drift caused three separate incidents on the Model B side of
// this file today).
export function computeLiveTierGating(bracket: TierBracket | null | undefined): {
  mainStartCount: number;
  liveCount: number;
  showTop24: boolean;
  showTop8: boolean;
} {
  const mainStartCount = bracket?.seedOrder?.length ?? 0;
  const liveCount = bracket ? computeLiveEntrantCount(bracket) : 0;
  const showTop24 = !!bracket && mainStartCount >= 48 && liveCount <= 24;
  const showTop8 = !!bracket && mainStartCount >= 16 && liveCount <= 8;
  return { mainStartCount, liveCount, showTop24, showTop8 };
}

// Shared "auto-follow the narrowest available tier" behavior for Standard/
// Model A/C's main-bracket meta-tabs ("main"/"main-top24"/"main-top8").
// PoolsSection.tsx's page updates via router.refresh() and StreamBracket.tsx
// updates via polling -- neither remounts the component or resets its own
// tab useState, so without this a viewer already sitting on one of these
// three tabs would never automatically land on "Top 24"/"Top 8" once those
// newly become available as the field narrows live. Previously two
// nearly-identical useEffects (differing only in variable names) -- shared
// here for the same reason every other cross-page gating/label helper in
// this file was extracted (Aug 8, 2026): a second hand-copied version is
// exactly what let earlier Model B fixes land in one file and not the
// other.
//
// Deliberately narrow, matching both original implementations exactly:
// only fires when showTop24/showTop8 THEMSELVES change (not on every
// render or manual tab click -- `current` is read via a ref, not listed as
// an effect dependency), skips the very first run so a fresh page load
// still lands on "main" by default even if the field has already narrowed
// to Top 8 range, and never yanks the viewer off a tab that isn't one of
// the three meta-tabs (e.g. a specific pool tab they clicked into).
// StandardBracketSection.tsx does NOT use this -- it has no equivalent
// live-refresh path today (its own activeTab never auto-advances), and
// adding one is a product decision outside this refactor's scope, not a
// duplication gap to close.
export function useAutoFollowNarrowestTier({
  enabled,
  showTop24,
  showTop8,
  current,
  setCurrent,
}: {
  enabled: boolean;
  showTop24: boolean;
  showTop8: boolean;
  current: string | undefined;
  setCurrent: (key: string) => void;
}): void {
  const currentRef = useRef(current);
  currentRef.current = current;
  const hasMounted = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    if (!hasMounted.current) {
      hasMounted.current = true;
      return;
    }
    const now = currentRef.current;
    const isOnMetaView = now === "main" || now === "main-top24" || now === "main-top8";
    if (!isOnMetaView) return;
    const narrowestAvailable = showTop8 ? "main-top8" : showTop24 ? "main-top24" : "main";
    if (now !== narrowestAvailable) setCurrent(narrowestAvailable);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- current read via ref on purpose, see comment above
  }, [enabled, showTop24, showTop8]);
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

// Model B only — its entrants are spread across several independent pool
// brackets within a round, not one continuous bracket, so there's no single
// tree to slice into a trailing-rounds view the way Models A/C's
// filterBracketToTier does. This computes the equivalent "who's still alive
// right now" concept directly instead: for each of the given round's pools,
// count real eliminations (see requiredLossesToEliminate below) and return
// the survivors, tagged with which pool they're still playing in.
// Deliberately a roster list, not a bracket rendering — there's no single
// bracket to draw once results span multiple pools. Kept conceptually
// separate from the Semifinal Cutoff round (which is a real, structural
// pool round Model B's own algorithm always builds once pool_count<=8,
// unrelated to this) — this can trigger during ANY round the moment that
// round's own live count first narrows to <=24, same live/dynamic spirit as
// Models A/C's tabs.
//
// requiredLossesToEliminate: any round 2+ pool (normal merge-stage AND the
// Finals-cutoff round alike) mixes two populations per source pool it was
// built from — a winners-champion entering fresh (0 prior losses, needs 2
// MORE losses here to be out, same as a real double-elim life count) and up
// to 2 losers-survivors who already carry 1 loss from the round they came
// from (need only 1 MORE loss here to be truly out). A flat "2 losses
// within this bracket" rule (correct for Round 1, where every entrant
// starts fresh) silently overcounts survivors among the carried-over-loss
// population everywhere else, most visibly on the Finals-cutoff round
// (found via live verification, 2026-07-31): a player entering there via
// buildFinalsCutoffBracket's LOSERS side, upon their first loss in that
// bracket, is actually already eliminated (their real 2nd lifetime loss),
// but the flat rule kept counting them as still alive until a 2nd loss
// that's structurally never coming (no further match is ever wired for
// them). Derived here from data already in the query response rather than
// a new persisted field: a player who appears in ANY "WINNERS"-side match
// in this pool's own bracket entered fresh (their bracket-generation
// functions -- buildDoubleEliminationBracket for Round 1,
// buildRepooledBracket/buildFinalsCutoffBracket for Round 2+ -- always seed
// a winners-side survivor into a WINNERS match, never a LOSERS one); anyone
// who never appears in a WINNERS match already carried a loss in. Round 1
// is unaffected by this generalization: every Round 1 entrant's own first
// match is on the Winners side (buildDoubleEliminationBracket), so this
// still resolves to "needs 2 losses" for everyone there, identical to the
// original flat rule already verified live at that round.
//
// Promoted here from PoolsSection.tsx (Aug 8, 2026) alongside
// computeModelBRoundTier below, for the same "one shared implementation,
// not two that can drift" reasoning as everything else in this file.
export interface ModelBRoundPool {
  poolNumber: number;
  roundNumber?: number;
  isFinalsCutoff: boolean;
  entrants: { player: { id: string; tag: string; avatarUrl?: string | null } }[];
  bracket: {
    matches: {
      bracketSide: string;
      status: string;
      winner?: { id: string } | null;
      player1?: { id: string } | null;
      player2?: { id: string } | null;
    }[];
  } | null;
}
export interface ModelBLiveEntrant {
  playerId: string;
  tag: string;
  avatarUrl?: string | null;
  poolNumber: number;
}
export function computeModelBRoundLiveEntrants(roundPools: ModelBRoundPool[]): ModelBLiveEntrant[] {
  const out: ModelBLiveEntrant[] = [];
  for (const pool of roundPools) {
    const losses = new Map<string, number>();
    const enteredViaWinners = new Set<string>();
    if (pool.bracket) {
      for (const m of pool.bracket.matches) {
        if (m.bracketSide !== "WINNERS") continue;
        if (m.player1) enteredViaWinners.add(m.player1.id);
        if (m.player2) enteredViaWinners.add(m.player2.id);
      }
      for (const m of pool.bracket.matches) {
        if (m.status !== "COMPLETED" || !m.winner) continue;
        const loserId = m.player1 && m.winner.id === m.player1.id ? m.player2?.id : m.player1?.id;
        if (!loserId) continue;
        losses.set(loserId, (losses.get(loserId) ?? 0) + 1);
      }
    }
    for (const entrant of pool.entrants) {
      const requiredLossesToEliminate = enteredViaWinners.has(entrant.player.id) ? 2 : 1;
      if ((losses.get(entrant.player.id) ?? 0) < requiredLossesToEliminate) {
        out.push({ playerId: entrant.player.id, tag: entrant.player.tag, avatarUrl: entrant.player.avatarUrl, poolNumber: pool.poolNumber });
      }
    }
  }
  return out;
}

// Model B's round-tier state — one tab per pool round generated so far, the
// mid-round live "Top 24"/"Top 8" roster tier once the current round has
// narrowed enough (gated the same >=48/>=16 start / <=24/<=8 live spirit as
// Models A/C's computeLiveTierGating above, just driven by
// computeModelBRoundLiveEntrants since there's no single bracket to slice),
// deliberately separate from the Semifinal Cutoff round itself (a real
// structural round the algorithm always builds once pool_count<=8,
// unrelated to this). Promoted from PoolsSection.tsx (Aug 8, 2026) so
// StreamBracket.tsx can share the exact same round-tier logic instead of
// building its own (narrower) version — see this file's module comment for
// why that gap existed.
export interface ModelBRoundTierState {
  roundNumbers: number[];
  latestRound: number;
  roundKeyFor: (r: number) => string;
  roundLabel: (r: number) => string;
  modelBRoundStartCount: number;
  modelBLiveEntrants: ModelBLiveEntrant[];
  modelBShowTop24: boolean;
  modelBShowTop8: boolean;
}
export function computeModelBRoundTier(pools: ModelBRoundPool[], hasMainBracket: boolean): ModelBRoundTierState {
  const roundNumbers = Array.from(new Set(pools.map(p => p.roundNumber ?? 1))).sort((a, b) => a - b);
  const latestRound = roundNumbers.length ? roundNumbers[roundNumbers.length - 1] : 1;
  const roundKeyFor = (r: number) => `round-${r}`;
  const roundLabel = (r: number) => modelBRoundLabel(pools, r);
  const latestRoundPools = pools.filter(p => (p.roundNumber ?? 1) === latestRound);
  const modelBRoundStartCount = latestRoundPools.reduce((sum, p) => sum + p.entrants.length, 0);
  const modelBLiveEntrants = computeModelBRoundLiveEntrants(latestRoundPools);
  const modelBShowTop24 = !hasMainBracket && modelBRoundStartCount >= 48 && modelBLiveEntrants.length <= 24;
  const modelBShowTop8 = !hasMainBracket && modelBRoundStartCount >= 16 && modelBLiveEntrants.length <= 8;
  return { roundNumbers, latestRound, roundKeyFor, roundLabel, modelBRoundStartCount, modelBLiveEntrants, modelBShowTop24, modelBShowTop8 };
}

// Model B's own roster-list rendering for the Top 24/Top 8 tabs — a simple
// grouped-by-pool list (avatar, tag, which pool they're still alive in)
// rather than BracketView, since these entrants span multiple independent
// pool brackets with no single tree to draw. highlightedPlayerIds follows
// the same player-search convention used elsewhere (empty Set on the Stream
// page, since it has no player-search feature at all — passing an empty Set
// there is equivalent to "nothing highlighted", not a special case). Moved
// here from PoolsSection.tsx (Aug 8, 2026) so StreamBracket.tsx can render
// it too instead of never having had it at all.
export function ModelBLiveRoster({
  entrants,
  tierLabel,
  highlightedPlayerIds,
}: {
  entrants: ModelBLiveEntrant[];
  tierLabel: string;
  highlightedPlayerIds: Set<string>;
}) {
  const byPool = new Map<number, typeof entrants>();
  for (const e of entrants) {
    if (!byPool.has(e.poolNumber)) byPool.set(e.poolNumber, []);
    byPool.get(e.poolNumber)!.push(e);
  }
  const poolNumbers = [...byPool.keys()].sort((a, b) => a - b);
  return (
    <div>
      <p className="font-rajdhani text-lg font-bold text-[var(--text-primary)] mb-1">{tierLabel}</p>
      <p className="text-[11px] text-[var(--text-muted)] mb-4">
        {entrants.length} live entrant{entrants.length === 1 ? "" : "s"} remaining this round, across {poolNumbers.length} pool{poolNumbers.length === 1 ? "" : "s"} — real-time, not final placements.
      </p>
      <div className="flex flex-col gap-4">
        {poolNumbers.map(poolNumber => (
          <div key={poolNumber}>
            <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Pool {poolNumber}</p>
            <div className="flex flex-wrap gap-1.5">
              {byPool.get(poolNumber)!.map(e => {
                const highlighted = highlightedPlayerIds.has(e.playerId);
                return (
                  <span
                    key={e.playerId}
                    className="flex items-center gap-1.5 text-[12px] px-2 py-1 rounded"
                    style={
                      highlighted
                        ? { background: "rgba(240,180,41,0.16)", outline: "1px solid var(--gold)", color: "var(--gold)" }
                        : { background: "rgba(74,222,128,0.12)", color: "var(--green)" }
                    }
                  >
                    <span
                      className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden font-rajdhani text-[9px] font-bold"
                      style={{ background: "var(--blue-dim)", color: "var(--blue)" }}
                    >
                      {e.avatarUrl ? <img src={e.avatarUrl} alt={e.tag} className="w-full h-full object-cover" /> : e.tag.slice(0, 2).toUpperCase()}
                    </span>
                    {e.tag}
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// A Model B Finals-cutoff pool (Pool.isFinalsCutoff) whose Winners-side
// entry size already equals FINALS_HALF plays ZERO real Winners-side
// matches (buildFinalsCutoffBracket's winnersRounds=0 branch, lib/bracket.ts
// -- see its own big comment) -- those entrants are already-decided Finals
// qualifiers with nothing left to play this round. Confirmed against real
// production data (Aug 8, 2026): both existing Model B tournaments' Top 24
// stage hit exactly this case (0 WINNERS matches, 4 real entrants never
// appearing in ANY match at all), which is what a viewer sees as "the Top
// 24 view only shows the Losers side" -- a real UX gap (those 4 real people
// are never displayed anywhere on the page), not a data or render bug.
//
// Only derives a roster when bracket.matches has ZERO real WINNERS-side
// matches -- if a future tournament's winnersEntrySize ever exceeds
// FINALS_HALF, real WINNERS matches DO exist and BracketView already
// renders them normally (its own "Winners Bracket" section), so this
// deliberately returns nothing there rather than guessing at partial
// qualification from match data alone: an entrant not yet appearing in a
// LOSERS match could just be mid-match on a real Winners bracket, not
// "already advanced" -- only safe to assume the former when there's no
// Winners bracket being drawn at all.
export interface FinalsCutoffEntrant {
  id: string;
  player: { id: string; tag: string; avatarUrl?: string | null };
}
interface FinalsCutoffBracket {
  matches: { bracketSide: string; player1?: { id: string } | null; player2?: { id: string } | null }[];
}
export function finalsCutoffWinnersQualifiedEntrants<E extends FinalsCutoffEntrant>(
  entrants: E[],
  bracket: FinalsCutoffBracket | null | undefined
): E[] {
  if (!bracket) return [];
  const hasRealWinnersMatches = bracket.matches.some(m => m.bracketSide === "WINNERS");
  if (hasRealWinnersMatches) return [];
  const losersPlayerIds = new Set<string>();
  for (const m of bracket.matches) {
    if (m.bracketSide !== "LOSERS") continue;
    if (m.player1) losersPlayerIds.add(m.player1.id);
    if (m.player2) losersPlayerIds.add(m.player2.id);
  }
  return entrants.filter(e => !losersPlayerIds.has(e.player.id));
}

// Shared with BracketView's own "Winners Bracket"/"Losers Bracket" heading
// style (font-rajdhani text-2xl font-bold uppercase tracking-wide) and
// ModelBLiveRoster's pill-list treatment (PoolsSection.tsx) — rendered
// directly above BracketView so the two read as one continuous bracket
// view rather than a bolted-on separate widget. Used on both the
// TO-facing Overview page and the OBS Stream page (same reasoning as
// modelBRoundLabel/MODEL_B_FINALS_TAB_LABEL above — one shared component
// instead of two copies that can silently drift apart).
export function FinalsCutoffWinnersRoster({
  entrants,
  accentColor,
}: {
  entrants: FinalsCutoffEntrant[];
  accentColor?: string;
}) {
  if (entrants.length === 0) return null;
  return (
    <div className="mb-6">
      <p className="font-rajdhani text-2xl font-bold uppercase tracking-wide mb-3" style={{ color: accentColor || "var(--green)" }}>
        Winners Bracket
      </p>
      <p className="text-[11px] mb-3" style={{ color: "var(--text-muted)" }}>
        Already advanced to the Top 8 Finals — this round's Winners-side field was small enough that these entrants qualified directly, with no match to play here.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {entrants.map(e => (
          <span
            key={e.id}
            className="flex items-center gap-1.5 text-[12px] px-2 py-1 rounded"
            style={{ background: "rgba(74,222,128,0.12)", color: "var(--green)" }}
          >
            <span
              className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden font-rajdhani text-[9px] font-bold"
              style={{ background: "var(--blue-dim)", color: "var(--blue)" }}
            >
              {e.player.avatarUrl ? (
                <img src={e.player.avatarUrl} alt={e.player.tag} className="w-full h-full object-cover" />
              ) : (
                e.player.tag.slice(0, 2).toUpperCase()
              )}
            </span>
            {e.player.tag}
          </span>
        ))}
      </div>
    </div>
  );
}

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
