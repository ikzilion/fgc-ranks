// components/PoolsSection.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { BracketView } from "./BracketView";
import { computeLiveEntrantCount, filterBracketToTier, TabBar } from "@/lib/bracketTierView";
import { GeneratePoolsButton } from "./GeneratePoolsButton";
import { GenerateModelBPoolsButton } from "./GenerateModelBPoolsButton";
import { GenerateMainBracketButton } from "./GenerateMainBracketButton";
import { AdvanceModelBRoundButton } from "./AdvanceModelBRoundButton";
import { DeletePoolsButton } from "./DeletePoolsButton";
import { DeleteMainBracketButton } from "./DeleteMainBracketButton";
import { ReportMatchButton } from "./ReportMatchButton";

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
  canUndo?: boolean;
}

interface PoolEntrant {
  id: string;
  player: { id: string; tag: string; avatarUrl?: string | null };
}

interface PoolBracket {
  seedingMethod: string;
  size: number;
  matches: PoolBracketMatch[];
  // Only needed/queried for the main bracket (Models A/C's live Top 24/
  // Top 8 tiers below) — real ordered entrant list, no bye padding, so its
  // length is "how many entrants the main bracket actually started with".
  // Unused for a pool's own bracket.
  seedOrder?: { id: string }[];
}

interface PoolStandingRow {
  rank: number;
  matchWins: number;
  matchLosses: number;
  gamesWon: number;
  gamesLost: number;
  entrant: { id: string; player: { id: string; tag: string; avatarUrl?: string | null } };
}

interface PoolData {
  id: string;
  poolNumber: number;
  entrants: PoolEntrant[];
  // Set only for a double-elim pool (Models B/C) — null for round-robin.
  bracket: PoolBracket | null;
  // Model A (round-robin) only — every match this pool's entrants played.
  matches: PoolBracketMatch[];
  // Model A (round-robin) only — null for a Model B/C pool.
  standings: PoolStandingRow[] | null;
  // Pool format Model B only — which repooling round this pool belongs to.
  // Always 1 for Model A/C.
  roundNumber: number;
  // Pool format Model B only — true for the Semifinal-cutoff round's pool.
  isFinalsCutoff: boolean;
}

// A pool is "decided" the same way the server treats it: for a double-elim
// pool (see resolvers' isBracketDecided), a Grand Final Reset match, if one
// exists, is the true decider; otherwise a completed Grand Final (no reset
// needed) is. For a round-robin pool, standings is only ever populated once
// there ARE completed matches to rank — but "advanced" here specifically
// means "pool is fully done AND this player finished top 2", so it also
// checks every match is COMPLETED (mirrors the server's isPoolComplete).
function poolAdvancers(pool: PoolData): { first: string; second: string } | null {
  if (pool.standings) {
    if (pool.matches.length === 0 || pool.matches.some(m => m.status !== "COMPLETED")) return null;
    if (pool.standings.length < 2) return null;
    return { first: pool.standings[0].entrant.player.id, second: pool.standings[1].entrant.player.id };
  }
  if (!pool.bracket) return null;
  const grandFinal = pool.bracket.matches.find(m => m.bracketSide === "GRAND_FINAL");
  if (!grandFinal?.player1?.id || !grandFinal?.player2?.id) return null;
  const reset = pool.bracket.matches.find(m => m.bracketSide === "GRAND_FINAL_RESET");
  const decided = reset ? reset.status === "COMPLETED" : grandFinal.status === "COMPLETED";
  if (!decided) return null;
  // Grand Final convention: player1 = winners-finalist, player2 = losers-finalist.
  return { first: grandFinal.player1.id, second: grandFinal.player2.id };
}

// GenerateMainBracketButton's MANUAL_BRACKET seeder needs the flat list of
// real advancing participants (2 per pool) with their tags, not just IDs —
// reuses poolAdvancers' own per-pool computation (handles both round-robin
// and bracket pools, and the Grand Final Reset "decided" check) rather than
// re-deriving it, then looks each advancer's tag up from that same pool's
// own entrants list (poolAdvancers only returns IDs).
function allPoolAdvancerParticipants(pools: PoolData[]): { playerId: string; tag: string }[] {
  const out: { playerId: string; tag: string }[] = [];
  for (const pool of pools) {
    const advancers = poolAdvancers(pool);
    if (!advancers) continue;
    for (const playerId of [advancers.first, advancers.second]) {
      const tag = pool.entrants.find(e => e.player.id === playerId)?.player.tag ?? playerId;
      out.push({ playerId, tag });
    }
  }
  return out;
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
        const advanced = entrant.player.id === advancers.first || entrant.player.id === advancers.second;
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

// Model A (round-robin) pools only — a standings table (rank, W-L, games,
// tiebreak order already resolved server-side) plus the individual match
// list, in place of BracketView's bracket rendering (there's no bracket to
// draw for a round-robin pool).
function PoolStandingsView({
  pool,
  canManage,
  highlightedPlayerIds,
}: {
  pool: PoolData;
  canManage: boolean;
  highlightedPlayerIds: Set<string>;
}) {
  const standings = pool.standings ?? [];
  return (
    <div>
      <div className="overflow-x-auto mb-6">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
              <th className="text-left py-2 pr-3">Rank</th>
              <th className="text-left py-2 pr-3">Player</th>
              <th className="text-right py-2 pr-3">W-L</th>
              <th className="text-right py-2">Games</th>
            </tr>
          </thead>
          <tbody>
            {standings.map(row => {
              const highlighted = highlightedPlayerIds.has(row.entrant.player.id);
              return (
                <tr
                  key={row.entrant.id}
                  style={
                    highlighted
                      ? { background: "rgba(240,180,41,0.16)", outline: "1px solid var(--gold)" }
                      : row.rank <= 2
                        ? { background: "rgba(74,222,128,0.08)" }
                        : undefined
                  }
                >
                  <td className="py-2 pr-3 font-rajdhani font-bold text-[var(--text-primary)]">{row.rank}</td>
                  <td className="py-2 pr-3 text-[var(--text-primary)]">
                    {row.entrant.player.tag}
                    {row.rank <= 2 && (
                      <span className="ml-2 text-[10px] font-bold" style={{ color: "var(--green)" }}>
                        ADVANCING
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right text-[var(--text-secondary)]">
                    {row.matchWins}-{row.matchLosses}
                  </td>
                  <td className="py-2 text-right text-[var(--text-secondary)]">
                    {row.gamesWon}-{row.gamesLost}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Matches</p>
      <div className="flex flex-col gap-2">
        {pool.matches.map(match => {
          const highlighted =
            (!!match.player1 && highlightedPlayerIds.has(match.player1.id)) ||
            (!!match.player2 && highlightedPlayerIds.has(match.player2.id));
          return (
            <div
              key={match.id}
              className="flex items-center justify-between gap-3 flex-wrap px-3 py-2 rounded"
              style={
                highlighted
                  ? { background: "rgba(240,180,41,0.1)", border: "1px solid var(--gold)" }
                  : { background: "var(--navy-3)", border: "1px solid var(--border)" }
              }
            >
              <div className="text-[13px] text-[var(--text-primary)]">
                {match.player1?.tag} <span className="text-[var(--text-muted)]">vs</span> {match.player2?.tag}
              </div>
              <div className="flex items-center gap-3">
                {match.status === "COMPLETED" ? (
                  <span className="text-[12px] font-semibold text-[var(--text-secondary)]">
                    {match.isForfeit ? "FF" : `${match.player1Score}-${match.player2Score}`}
                    {match.winner && <span className="ml-1" style={{ color: "var(--green)" }}>({match.winner.tag} won)</span>}
                  </span>
                ) : (
                  <span className="text-[11px] text-[var(--text-muted)]">Pending</span>
                )}
                <ReportMatchButton match={match as any} canManage={canManage} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

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
function computeModelBRoundLiveEntrants(roundPools: PoolData[]): { playerId: string; tag: string; avatarUrl?: string | null; poolNumber: number }[] {
  const out: { playerId: string; tag: string; avatarUrl?: string | null; poolNumber: number }[] = [];
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

// Model B's own roster-list rendering for the Top 24/Top 8 tabs — a simple
// grouped-by-pool list (avatar, tag, which pool they're still alive in)
// rather than BracketView, since these entrants span multiple independent
// pool brackets with no single tree to draw. highlightedPlayerIds follows
// the same player-search convention as everywhere else in this file.
function ModelBLiveRoster({
  entrants,
  tierLabel,
  highlightedPlayerIds,
}: {
  entrants: { playerId: string; tag: string; avatarUrl?: string | null; poolNumber: number }[];
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

// No lineColor/boxColor/fontColor props here on purpose -- this component
// only ever renders on the Overview page, which always uses plain theme
// colors regardless of a tournament's custom bracket colors. Those are
// Stream-only as of Aug 1, 2026 (reversing the July 29, 2026 "apply
// uniformly across every view" decision, commit 2826625) -- see
// components/StreamBracket.tsx's own BracketView calls for where they're
// still used.
export function PoolsSection({
  tournamentId,
  pools,
  mainBracket,
  entrantCount,
  suggestedPoolCount,
  allPoolsComplete,
  poolModel,
  modelBCurrentRoundComplete,
  canManage,
  highlightedPlayerIds,
}: {
  tournamentId: string;
  pools: PoolData[];
  mainBracket: PoolBracket | null;
  entrantCount: number;
  suggestedPoolCount: number;
  allPoolsComplete: boolean;
  poolModel: string;
  modelBCurrentRoundComplete: boolean;
  canManage: boolean;
  // Player-search highlighting (Aug 1, 2026) — empty Set means nothing
  // highlighted, same as no search query entered. Every tab already has
  // this pool/bracket's full entrant list in props regardless of which tab
  // is currently active, so "does this tab contain the searched player" is
  // just a plain array check here, no extra data needed.
  highlightedPlayerIds: Set<string>;
}) {
  const isModelB = poolModel === "B";
  const hasMainBracket = !!mainBracket;

  // Models A/C only (settled design, July 24, 2026) — a "Top 24" tab
  // appears once live count <=24, but only if the main bracket started with
  // >=48 entrants; a "Top 8" tab appears once live count <=8, but only if
  // it started with >=16. A small main bracket that never reaches these
  // thresholds simply never shows the extra tabs. Model B has its own
  // Semifinal-cutoff/Finals presentation stages already — this doesn't
  // apply there.
  const mainStartCount = !isModelB ? (mainBracket?.seedOrder?.length ?? 0) : 0;
  const liveCount = !isModelB && mainBracket ? computeLiveEntrantCount(mainBracket) : 0;
  const showTop24 = !isModelB && hasMainBracket && mainStartCount >= 48 && liveCount <= 24;
  const showTop8 = !isModelB && hasMainBracket && mainStartCount >= 16 && liveCount <= 8;

  // Player-search tab badging (Aug 1, 2026) — a pool/the main bracket
  // "contains" the searched player if any of its own entrants match, which
  // is already sitting in props for every pool regardless of which tab is
  // currently active (this is what makes badging a HIDDEN tab possible at
  // all — its match cards aren't in the DOM, but its entrant list still is).
  const poolHasHighlight = (pool: PoolData) => pool.entrants.some(e => highlightedPlayerIds.has(e.player.id));
  const mainBracketHasHighlight = !!mainBracket?.seedOrder?.some(p => highlightedPlayerIds.has(p.id));

  // Model B only — every round that has at least one pool so far, in order.
  // Model A/C never have more than one pool round, so this stays empty for
  // them and the round-selector tier below never renders.
  const roundNumbers = isModelB
    ? Array.from(new Set(pools.map(p => p.roundNumber ?? 1))).sort((a, b) => a - b)
    : [];
  const latestRound = roundNumbers.length ? roundNumbers[roundNumbers.length - 1] : 1;
  const roundKeyFor = (r: number) => `round-${r}`;

  // A round is the Semifinal-cutoff round if its one pool says so (a
  // Finals-cutoff round is always exactly one pool — see advanceModelBRound).
  function roundLabel(r: number) {
    const roundPools = pools.filter(p => (p.roundNumber ?? 1) === r);
    return roundPools.length === 1 && roundPools[0].isFinalsCutoff ? "Semifinal Cutoff" : `Round ${r}`;
  }

  // Model B's own Top 24/Top 8 — deliberately separate from Semifinal
  // Cutoff (a real structural round the algorithm always builds once
  // pool_count<=8, unrelated to this) and from Models A/C's tabs (no single
  // bracket to slice here, entrants span several pools). Gated the same
  // spirit as Models A/C: >=48/>=16 entrants for this round to START with,
  // narrowed to <=24/<=8 STILL ALIVE right now, live/dynamic across
  // whichever round is currently in progress (not just the Finals-cutoff
  // round, though that round's own ~24-entrant target often lands here
  // naturally too).
  const latestRoundPools = isModelB ? pools.filter(p => (p.roundNumber ?? 1) === latestRound) : [];
  const modelBRoundStartCount = latestRoundPools.reduce((sum, p) => sum + p.entrants.length, 0);
  const modelBLiveEntrants = isModelB ? computeModelBRoundLiveEntrants(latestRoundPools) : [];
  const modelBShowTop24 = isModelB && !hasMainBracket && modelBRoundStartCount >= 48 && modelBLiveEntrants.length <= 24;
  const modelBShowTop8 = isModelB && !hasMainBracket && modelBRoundStartCount >= 16 && modelBLiveEntrants.length <= 8;
  const modelBTop24HasHighlight = modelBLiveEntrants.some(e => highlightedPlayerIds.has(e.playerId));

  // Model B's round-selector tier — one tab per pool round generated so far,
  // Top 24/Top 8 once the current round has narrowed enough (see above),
  // plus a "Finals" tab once the real Finals bracket exists (same
  // Tournament.mainBracket slot Model A/C's "Main Bracket" tab already uses,
  // just elevated to this tier instead of sitting alongside pool tabs).
  const roundTabs = isModelB
    ? [
        ...roundNumbers.map(r => ({
          key: roundKeyFor(r),
          label: roundLabel(r),
          hasHighlight: pools.some(p => (p.roundNumber ?? 1) === r && poolHasHighlight(p)),
        })),
        ...(modelBShowTop24 ? [{ key: "top24", label: "Top 24", hasHighlight: modelBTop24HasHighlight }] : []),
        ...(modelBShowTop8 ? [{ key: "top8", label: "Top 8", hasHighlight: modelBTop24HasHighlight }] : []),
        ...(hasMainBracket ? [{ key: "main", label: "Finals", hasHighlight: mainBracketHasHighlight }] : []),
      ]
    : [];

  function firstPoolTabForRound(roundKey: string): string | undefined {
    if (roundKey === "main" || roundKey === "top24" || roundKey === "top8") return undefined;
    const roundPools = pools.filter(p => roundKeyFor(p.roundNumber ?? 1) === roundKey);
    return roundPools[0] ? `pool-${roundPools[0].id}` : undefined;
  }

  const defaultRoundKey = hasMainBracket ? "main" : roundKeyFor(latestRound);

  // Model B round progression (advanceModelBRound) is TO-initiated, not
  // something a viewer watches narrow in real time the way Top 24/Top 8
  // below does -- activeRound just needs a sane initial default per page
  // load, which this still gives it.
  const [activeRound, setActiveRound] = useState<string | undefined>(isModelB ? defaultRoundKey : undefined);

  // Model A/C: unchanged shape — "Main Bracket" merged directly into this
  // one tab bar alongside every pool. Model B: this tab bar is scoped to
  // whichever round is currently selected above; Finals/Top 24/Top 8 all
  // live in roundTabs instead, so none of them render pool tabs here.
  const tabs = isModelB
    ? activeRound === "main" || activeRound === "top24" || activeRound === "top8"
      ? []
      : pools
          .filter(p => roundKeyFor(p.roundNumber ?? 1) === activeRound)
          .map(p => ({ key: `pool-${p.id}`, label: `Pool ${p.poolNumber}`, hasHighlight: poolHasHighlight(p) }))
    : [
        ...(hasMainBracket ? [{ key: "main", label: "Main Bracket", hasHighlight: mainBracketHasHighlight }] : []),
        ...(showTop24 ? [{ key: "main-top24", label: "Top 24", hasHighlight: mainBracketHasHighlight }] : []),
        ...(showTop8 ? [{ key: "main-top8", label: "Top 8", hasHighlight: mainBracketHasHighlight }] : []),
        ...pools.map(p => ({ key: `pool-${p.id}`, label: `Pool ${p.poolNumber}`, hasHighlight: poolHasHighlight(p) })),
      ];
  const [activeTab, setActiveTab] = useState<string | undefined>(
    isModelB ? firstPoolTabForRound(defaultRoundKey) : tabs[0]?.key
  );

  // Models A/C only -- reportResult (every match played in the main
  // bracket) calls router.refresh(), NOT a real remount, so this useState's
  // initial value is the only time activeTab would otherwise get set: a
  // viewer sitting on "Main Bracket" or "Top 24" while the field keeps
  // narrowing would never automatically land on "Top 24" or "Top 8" once
  // those newly become available, since router.refresh() only refreshes
  // the server-fetched props this component receives, it doesn't remount
  // the component or reset its state.
  //
  // Deliberately narrow: only fires when showTop24/showTop8 THEMSELVES
  // change (i.e. new data actually arrived), not on every render or every
  // manual tab click -- activeTab is read via a ref instead of listed as a
  // dependency so clicking a tab doesn't re-trigger this effect. Skips the
  // very first run (hasMountedRef) so a fresh page load still lands on
  // "Main Bracket" by default even if the field has already narrowed to
  // Top 8 range -- this only auto-follows narrowing that happens WHILE
  // watching, it doesn't change the initial landing tab. Also never yanks
  // the viewer off a specific pool tab they clicked into.
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const hasMountedTabEffect = useRef(false);
  useEffect(() => {
    if (isModelB) return;
    if (!hasMountedTabEffect.current) {
      hasMountedTabEffect.current = true;
      return;
    }
    const current = activeTabRef.current;
    const isOnMetaView = current === "main" || current === "main-top24" || current === "main-top8";
    if (!isOnMetaView) return;
    const narrowestAvailable = showTop8 ? "main-top8" : showTop24 ? "main-top24" : "main";
    if (current !== narrowestAvailable) setActiveTab(narrowestAvailable);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeTab read via ref on purpose, see comment above
  }, [isModelB, showTop24, showTop8]);

  function handleSelectRound(key: string) {
    setActiveRound(key);
    setActiveTab(firstPoolTabForRound(key));
  }

  if (pools.length === 0) {
    return (
      <div className="fgc-card p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">Pools</p>
            <p className="text-[13px] text-[var(--text-secondary)] mt-1">
              {canManage
                ? isModelB
                  ? "Generate this tournament's Round 1 pools to begin the pool stage (requires at least 128 entrants)."
                  : "Split entrants into pools to begin the pool stage."
                : "Pools haven't been generated yet."}
            </p>
          </div>
          {isModelB ? (
            <GenerateModelBPoolsButton tournamentId={tournamentId} entrantCount={entrantCount} canManage={canManage} />
          ) : (
            <GeneratePoolsButton
              tournamentId={tournamentId}
              entrantCount={entrantCount}
              suggestedPoolCount={suggestedPoolCount}
              canManage={canManage}
            />
          )}
        </div>
      </div>
    );
  }

  const activePool = pools.find(p => `pool-${p.id}` === activeTab);
  const isViewingLatestRound = activeRound === roundKeyFor(latestRound);
  // Models A/C: "Main Bracket"/"Top 24"/"Top 8" are three different VIEWS
  // of the exact same mainBracket data (see filterBracketToTier) — the
  // active tab just picks which one to hand to BracketView, unchanged.
  const mainViewKey = isModelB
    ? activeRound === "main"
      ? "main"
      : undefined
    : activeTab === "main" || activeTab === "main-top24" || activeTab === "main-top8"
      ? activeTab
      : undefined;
  const displayedMainBracket =
    !mainViewKey || !mainBracket
      ? null
      : mainViewKey === "main"
        ? mainBracket
        : filterBracketToTier(mainBracket, mainViewKey === "main-top8" ? 8 : 32);

  return (
    <div className="fgc-card p-6" style={{ overflow: "visible" }}>
      <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Pools</p>
          {isModelB && (
            <div className="mb-3">
              <TabBar tabs={roundTabs} activeKey={activeRound ?? roundTabs[0]?.key ?? ""} onSelect={handleSelectRound} />
            </div>
          )}
          {(!isModelB || activeRound !== "main") && (
            <TabBar tabs={tabs} activeKey={activeTab ?? tabs[0]?.key ?? ""} onSelect={setActiveTab} />
          )}
          {(!hasMainBracket || isModelB) && (
            <p className="text-[11px] font-bold text-[var(--text-secondary)] mt-2">
              {isModelB
                ? hasMainBracket
                  ? "This tournament's field narrowed through per-round pools down to a ~24-entrant Semifinal Cutoff, then a Top 8 Finals bracket."
                  : "Each pool's real advancers regroup into fresh pools once the current round finishes, narrowing down to the real Finals bracket."
                : "Top 2 finishers of each pool advance to the main bracket once every pool finishes."}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {hasMainBracket ? (
            <DeleteMainBracketButton tournamentId={tournamentId} canManage={canManage} />
          ) : isModelB ? (
            <>
              {/* Advancing always targets the CURRENT (latest) round — hidden
                  while browsing an earlier round's pools as history, so it
                  never reads as attached to whichever round happens to be
                  on screen. */}
              {isViewingLatestRound && (
                <AdvanceModelBRoundButton tournamentId={tournamentId} modelBCurrentRoundComplete={modelBCurrentRoundComplete} canManage={canManage} />
              )}
              {/* deletePools already handles every round's pools for a
                  tournament (unscoped Pool.find({tournamentId})), so it works
                  unchanged for Model B's multi-round pools too. */}
              <DeletePoolsButton tournamentId={tournamentId} canManage={canManage} />
            </>
          ) : (
            <>
              <GenerateMainBracketButton
                tournamentId={tournamentId}
                allPoolsComplete={allPoolsComplete}
                canManage={canManage}
                poolAdvancerParticipants={allPoolAdvancerParticipants(pools)}
              />
              {/* Full reset is allowed mid-play, not just before any results —
                  deletePools itself is what actually blocks this once a main
                  bracket exists (delete that first), so this button doesn't
                  need its own extra gating beyond hasMainBracket above. */}
              <DeletePoolsButton tournamentId={tournamentId} canManage={canManage} />
            </>
          )}
        </div>
      </div>

      {displayedMainBracket && (
        <div>
          {(mainViewKey === "main-top24" || mainViewKey === "main-top8") && (
            <p className="text-[11px] text-[var(--text-muted)] mb-3">
              {liveCount} live {liveCount === 1 ? "entrant" : "entrants"} remaining — the complete Main Bracket is always available in its own tab.
            </p>
          )}
          <BracketView bracket={displayedMainBracket} canManage={canManage} highlightedPlayerIds={highlightedPlayerIds} />
        </div>
      )}

      {isModelB && (activeRound === "top24" || activeRound === "top8") && (
        <ModelBLiveRoster
          entrants={modelBLiveEntrants}
          tierLabel={activeRound === "top8" ? "Top 8" : "Top 24"}
          highlightedPlayerIds={highlightedPlayerIds}
        />
      )}

      {activePool && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="font-rajdhani text-lg font-bold text-[var(--text-primary)]">
              Pool {activePool.poolNumber}
              {activePool.isFinalsCutoff && (
                <span className="ml-2 text-[11px] font-bold" style={{ color: "var(--gold)" }}>SEMIFINAL CUTOFF</span>
              )}
            </p>
            <p className="text-[11px] text-[var(--text-muted)]">{activePool.entrants.length} entrants</p>
          </div>
          <PoolAdvancementTags pool={activePool} />
          {activePool.bracket ? (
            <BracketView bracket={activePool.bracket} canManage={canManage} highlightedPlayerIds={highlightedPlayerIds} />
          ) : activePool.matches.length > 0 ? (
            <PoolStandingsView pool={activePool} canManage={canManage} highlightedPlayerIds={highlightedPlayerIds} />
          ) : (
            <p className="text-[13px] text-[var(--text-secondary)]">No matches for this pool yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
