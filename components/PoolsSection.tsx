// components/PoolsSection.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { BracketView } from "./BracketView";
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

// Models A/C's main bracket only — "live entrant count" = pool advancers
// (bracket.seedOrder) minus already-eliminated entrants (2 losses in this
// bracket; standard double-elim), recomputed from current match results
// every render (no stored/cached elimination state). GRAND_FINAL_RESET is
// just another bracket match here — its loser's 2nd loss eliminates them
// exactly like any Losers-side match would.
function computeLiveEntrantCount(bracket: PoolBracket): number {
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

// Duplicated (not imported) from BracketView.tsx's own private
// getRoundPositionCounts — same exact formula, kept separate per this
// feature's "reuse BracketView unchanged" scope. Used here only to compute
// how many TRAILING Winners/Losers rounds make up a Top-N filtered view,
// never to render anything directly.
function trailingRoundCounts(size: number, side: "WINNERS" | "LOSERS"): number[] {
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

// Models A/C's main bracket only — a live-narrowing PRESENTATION filter,
// not a new bracket: same underlying Bracket/Match data, just the trailing
// `tierSize`-worth of Winners/Losers rounds (plus Grand Finals, always
// included). This works cleanly with BracketView completely unchanged
// because of one structural fact about every double-elimination bracket
// this codebase generates (lib/bracket.ts's buildConsolidationRound/
// buildDropInRound, both always 0-indexed PER ROUND): the trailing K
// Winners/Losers rounds of a size-S bracket have IDENTICAL per-round
// entrant counts AND identical 0-indexed bracketPosition numbering to the
// full round sequence of a standalone size-2^K bracket. So slicing to the
// last few rounds and shifting bracketRound down to start at 1 again
// reproduces exactly what BracketView already knows how to render for a
// bracket of that smaller size — unlike a naive "only matches touching a
// still-live player" filter, which would leave every earlier, un-included
// round's positions looking like genuine bye gaps to BracketView's byes
// math (it always expects every round 1..log2(size) to be present).
// tierSize=8 for the "Top 8" tab; tierSize=32 (nextPowerOfTwo(24)) for the
// "Top 24" tab, since 24 itself isn't a power of two — the entry gating
// (mainStartCount >= 48 for Top 24, >= 16 for Top 8) always guarantees the
// real bracket has enough rounds for this slice to be valid.
function filterBracketToTier(bracket: PoolBracket, tierSize: number): PoolBracket {
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
  return { seedingMethod: bracket.seedingMethod, size: tierSize, matches, seedOrder: bracket.seedOrder };
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

  // Model B's round-selector tier — one tab per pool round generated so far,
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
        ...(hasMainBracket ? [{ key: "main", label: "Finals", hasHighlight: mainBracketHasHighlight }] : []),
      ]
    : [];

  function firstPoolTabForRound(roundKey: string): string | undefined {
    if (roundKey === "main") return undefined;
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
  // whichever round is currently selected above; Finals lives in roundTabs
  // instead, so it renders no pool tabs while "Finals" is selected.
  const tabs = isModelB
    ? activeRound === "main"
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
          {!hasMainBracket && (
            <p className="text-[11px] font-bold text-[var(--text-secondary)] mt-2">
              {isModelB
                ? "Each pool's real advancers regroup into fresh pools once the current round finishes, narrowing down to the real Finals bracket."
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
