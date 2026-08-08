// components/StreamBracket.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { BracketView } from "./BracketView";

const POLL_INTERVAL_MS = 12000;

// Shared Match field selection — same convention as the tournament detail
// page's MATCH_FIELDS (no GraphQL fragments in this codebase — no Apollo
// Client — so it's just a repeated string).
const MATCH_FIELDS = `
  id
  round
  status
  bracketSide
  bracketRound
  bracketPosition
  player1Score
  player2Score
  isForfeit
  player1 { id tag }
  player2 { id tag }
  winner { id tag }
  nextMatch { id }
  nextLoserMatch { id }
`;

const GET_STREAM_TOURNAMENT = `
  query GetStreamTournament($id: ID!) {
    tournament(id: $id) {
      id
      name
      game
      status
      format
      streamBackgroundUrl
      sponsorBannerUrl
      sponsorBannerUrls { url linkUrl }
      sponsorBannerIntervalSeconds
      bracketLineColor
      bracketBoxColor
      bracketFontColor
      poolModel
      bracket {
        id
        seedingMethod
        size
        matches { ${MATCH_FIELDS} }
      }
      pools {
        id
        poolNumber
        roundNumber
        isFinalsCutoff
        bracket {
          id
          seedingMethod
          size
          matches { ${MATCH_FIELDS} }
        }
      }
      mainBracket {
        id
        seedingMethod
        size
        seedOrder { id }
        matches { ${MATCH_FIELDS} }
      }
    }
  }
`;

interface StreamPool {
  id: string;
  poolNumber: number;
  bracket: any;
  // Pool format Model B only — always 1 / false for Model A/C.
  roundNumber: number;
  isFinalsCutoff: boolean;
}

interface StreamTournament {
  id: string;
  name: string;
  game: string;
  status: string;
  format?: string | null;
  streamBackgroundUrl?: string | null;
  sponsorBannerUrl?: string | null;
  sponsorBannerUrls?: { url: string; linkUrl?: string | null }[] | null;
  sponsorBannerIntervalSeconds?: number | null;
  bracketLineColor?: string | null;
  bracketBoxColor?: string | null;
  bracketFontColor?: string | null;
  poolModel?: string | null;
  bracket: any;
  pools: StreamPool[];
  mainBracket: any;
}

// Small pill-button tab row — dark-broadcast-theme equivalent of
// PoolsSection.tsx's TabBar (admin/TO page), same active/inactive visual
// language this file already used inline for its pool/main-bracket
// selector, just extracted so both the round tier and pool tier (Model B)
// can share it instead of duplicating the button JSX.
function ViewTabs({
  tabs,
  activeKey,
  onSelect,
  className,
}: {
  tabs: { key: string; label: string }[];
  activeKey: string;
  onSelect: (key: string) => void;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap gap-2 ${className ?? ""}`}>
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
                : { background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.7)", border: "1px solid rgba(255,255,255,0.15)", cursor: "pointer" }
            }
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

// Models A/C's main bracket only — "live entrant count" = pool advancers
// (bracket.seedOrder) minus already-eliminated entrants (2 losses in this
// bracket; standard double-elim), recomputed from current match results
// every render. Duplicated from PoolsSection.tsx's identical helper (same
// "reuse BracketView unchanged" scope, no shared-component layer between
// the TO-facing page and this broadcast view) rather than imported.
function computeLiveEntrantCount(bracket: any): number {
  if (!bracket?.seedOrder) return 0;
  const losses = new Map<string, number>();
  for (const m of bracket.matches) {
    if (m.status !== "COMPLETED" || !m.winner) continue;
    const loserId = m.player1 && m.winner.id === m.player1.id ? m.player2?.id : m.player1?.id;
    if (!loserId) continue;
    losses.set(loserId, (losses.get(loserId) ?? 0) + 1);
  }
  return bracket.seedOrder.filter((p: any) => (losses.get(p.id) ?? 0) < 2).length;
}

// Duplicated from BracketView.tsx's own private getRoundPositionCounts —
// see PoolsSection.tsx's identical copy for the full explanation of why the
// trailing K rounds of a bigger bracket are structurally interchangeable
// with a standalone size-2^K bracket's own round sequence.
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
// not a new bracket. tierSize=8 for "Top 8"; tierSize=32 (nextPowerOfTwo(24))
// for "Top 24", since 24 itself isn't a power of two. See PoolsSection.tsx's
// identical helper for the full structural explanation.
function filterBracketToTier(bracket: any, tierSize: number) {
  const wbOffset = Math.max(0, Math.log2(bracket.size) - Math.log2(tierSize));
  const lbOffset = Math.max(0, trailingRoundCounts(bracket.size, "LOSERS").length - trailingRoundCounts(tierSize, "LOSERS").length);
  const matches = bracket.matches
    .filter((m: any) => {
      if (m.bracketSide === "WINNERS") return m.bracketRound > wbOffset;
      if (m.bracketSide === "LOSERS") return m.bracketRound > lbOffset;
      return true;
    })
    .map((m: any) => {
      if (m.bracketSide === "WINNERS") return { ...m, bracketRound: m.bracketRound - wbOffset };
      if (m.bracketSide === "LOSERS") return { ...m, bracketRound: m.bracketRound - lbOffset };
      return m;
    });
  return { seedingMethod: bracket.seedingMethod, size: tierSize, matches, seedOrder: bracket.seedOrder };
}

export function StreamBracket({ tournamentId, initialTournament }: { tournamentId: string; initialTournament: StreamTournament }) {
  const [tournament, setTournament] = useState(initialTournament);
  // Tracks the last-applied data as a string so a poll that returns identical
  // content never triggers setState — avoids remounting/re-measuring the
  // bracket's connector lines (and any visual flicker) when nothing changed.
  const lastSnapshot = useRef(JSON.stringify(initialTournament));

  useEffect(() => {
    let cancelled = false;

    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: GET_STREAM_TOURNAMENT, variables: { id: tournamentId } }),
        });
        const json = await res.json();
        const next = json.data?.tournament;
        if (!next || cancelled) return;

        const snapshot = JSON.stringify(next);
        if (snapshot !== lastSnapshot.current) {
          lastSnapshot.current = snapshot;
          setTournament(next);
        }
      } catch {
        // Silently keep showing the last known good state and retry next tick
        // — this runs unattended in OBS, there's no one to show an error to.
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [tournamentId]);

  const hasBackground = !!tournament.streamBackgroundUrl;

  // Sponsor banner slideshow — 2+ entries in sponsorBannerUrls rotates on
  // the TO-configured interval; 0 or 1 entries falls back to rendering the
  // single sponsorBannerUrl statically, exactly as before this feature
  // existed (see models/Tournament.ts). The single sponsorBannerUrl fallback
  // has no per-banner link concept (that's slideshow-only, settled July 28,
  // 2026) — linkUrl: null there renders it exactly as it always has.
  // Joined to a string for the effect's dependency array since the array
  // itself is a fresh reference every poll even when its contents haven't
  // changed.
  const bannerSlides: { url: string; linkUrl?: string | null }[] =
    tournament.sponsorBannerUrls && tournament.sponsorBannerUrls.length > 0
      ? tournament.sponsorBannerUrls
      : tournament.sponsorBannerUrl
        ? [{ url: tournament.sponsorBannerUrl, linkUrl: null }]
        : [];
  const bannerSlidesKey = bannerSlides.map(s => `${s.url}|${s.linkUrl ?? ""}`).join(",");
  const [bannerIndex, setBannerIndex] = useState(0);
  useEffect(() => {
    if (bannerSlides.length < 2) return;
    const intervalMs = Math.max(1, tournament.sponsorBannerIntervalSeconds || 8) * 1000;
    const id = setInterval(() => {
      setBannerIndex(i => (i + 1) % bannerSlides.length);
    }, intervalMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bannerSlidesKey, tournament.sponsorBannerIntervalSeconds]);
  // Clamp defensively — bannerSlides can shrink between polls (e.g. a
  // banner removed from the slideshow) while bannerIndex is mid-rotation.
  const activeBannerSlide = bannerSlides.length > 0 ? bannerSlides[bannerIndex % bannerSlides.length] : null;

  // Pool play + top-cut format only — a TO needs to put an individual
  // pool's bracket on stream during the pool stage, before the main bracket
  // even exists, not just the main/standard bracket. Selection is local
  // component state (not synced to a URL param) — a TO picks it once in the
  // browser source before/while going live; polling below only refreshes
  // match data, never resets which view is selected.
  const isPoolsFormat = tournament.format === "Pools + Bracket";
  const isModelB = isPoolsFormat && tournament.poolModel === "B";
  const hasMainBracket = !!tournament.mainBracket;

  // Models A/C only (settled design, July 24, 2026) — same live Top 24/
  // Top 8 tiers PoolsSection.tsx's TO-facing page has, re-themed here for
  // consistency. Model B has its own Semifinal-cutoff/Finals stages already.
  const mainStartCount = !isModelB ? (tournament.mainBracket?.seedOrder?.length ?? 0) : 0;
  const liveCount = !isModelB && tournament.mainBracket ? computeLiveEntrantCount(tournament.mainBracket) : 0;
  const showTop24 = !isModelB && hasMainBracket && mainStartCount >= 48 && liveCount <= 24;
  const showTop8 = !isModelB && hasMainBracket && mainStartCount >= 16 && liveCount <= 8;

  // Model B only — same round dimension PoolsSection.tsx's Phase 6 round
  // selector added for the TO-facing page, re-themed here. Every round that
  // has at least one pool so far, in order.
  const roundNumbers = isModelB
    ? Array.from(new Set(tournament.pools.map(p => p.roundNumber ?? 1))).sort((a, b) => a - b)
    : [];
  const latestRound = roundNumbers.length ? roundNumbers[roundNumbers.length - 1] : 1;
  const roundKeyFor = (r: number) => `round-${r}`;

  // A round is the Semifinal-cutoff round if its one pool says so (a
  // Finals-cutoff round is always exactly one pool — see advanceModelBRound).
  function roundLabel(r: number) {
    const roundPools = tournament.pools.filter(p => (p.roundNumber ?? 1) === r);
    return roundPools.length === 1 && roundPools[0].isFinalsCutoff ? "Semifinal Cutoff" : `Round ${r}`;
  }

  // Model B's round-selector tier — one tab per pool round generated so far,
  // plus a "Finals" tab once the real Finals bracket exists (same
  // Tournament.mainBracket slot Model A/C's "Main Bracket" tab already uses,
  // just elevated to this tier instead of sitting alongside pool tabs).
  const roundTabs = isModelB
    ? [
        ...roundNumbers.map(r => ({ key: roundKeyFor(r), label: roundLabel(r) })),
        ...(hasMainBracket ? [{ key: "main", label: "Finals" }] : []),
      ]
    : [];

  function firstPoolTabForRound(roundKey: string): string | undefined {
    if (roundKey === "main") return undefined;
    const roundPools = tournament.pools.filter(p => roundKeyFor(p.roundNumber ?? 1) === roundKey);
    return roundPools[0] ? `pool-${roundPools[0].id}` : undefined;
  }

  const defaultRoundKey = hasMainBracket ? "main" : roundKeyFor(latestRound);
  const [selectedRound, setSelectedRound] = useState<string | undefined>(isModelB ? defaultRoundKey : undefined);

  // Model A/C: unchanged shape — "Main Bracket" merged directly into this one
  // tab row alongside every pool. Model B: this tab row is scoped to
  // whichever round is currently selected above; Finals lives in roundTabs
  // instead, so it's empty while "Finals" is selected.
  const views = isModelB
    ? selectedRound === "main"
      ? []
      : tournament.pools.filter(p => roundKeyFor(p.roundNumber ?? 1) === selectedRound).map(p => ({ key: `pool-${p.id}`, label: `Pool ${p.poolNumber}` }))
    : isPoolsFormat
      ? [
          ...(hasMainBracket ? [{ key: "main", label: "Main Bracket" }] : []),
          ...(showTop24 ? [{ key: "main-top24", label: "Top 24" }] : []),
          ...(showTop8 ? [{ key: "main-top8", label: "Top 8" }] : []),
          ...tournament.pools.map(p => ({ key: `pool-${p.id}`, label: `Pool ${p.poolNumber}` })),
        ]
      : [];
  const [selectedView, setSelectedView] = useState<string | undefined>(
    isModelB ? firstPoolTabForRound(defaultRoundKey) : views[0]?.key
  );

  // Models A/C only -- this view polls for fresh tournament data itself
  // (the useEffect above), which correctly recomputes showTop24/showTop8
  // every time, but selectedView's useState above only ever applies its
  // initial value once, so a viewer sitting on "Main Bracket" or "Top 24"
  // while the field narrows during a live poll would never automatically
  // land on "Top 24"/"Top 8" once those newly become available (same root
  // cause as PoolsSection.tsx's activeTab, just driven by polling instead
  // of router.refresh()). Same design as there: only fires when showTop24/
  // showTop8 THEMSELVES change, skips the very first run so a fresh page
  // load still lands on "Main Bracket" by default, and never yanks the
  // viewer off a specific pool tab they clicked into.
  const selectedViewRef = useRef(selectedView);
  selectedViewRef.current = selectedView;
  const hasMountedViewEffect = useRef(false);
  useEffect(() => {
    if (isModelB) return;
    if (!hasMountedViewEffect.current) {
      hasMountedViewEffect.current = true;
      return;
    }
    const current = selectedViewRef.current;
    const isOnMetaView = current === "main" || current === "main-top24" || current === "main-top8";
    if (!isOnMetaView) return;
    const narrowestAvailable = showTop8 ? "main-top8" : showTop24 ? "main-top24" : "main";
    if (current !== narrowestAvailable) setSelectedView(narrowestAvailable);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedView read via ref on purpose, see comment above
  }, [isModelB, showTop24, showTop8]);

  function handleSelectRound(key: string) {
    setSelectedRound(key);
    setSelectedView(firstPoolTabForRound(key));
  }

  const selectedPool = tournament.pools.find(p => `pool-${p.id}` === selectedView);
  // Models A/C: "Main Bracket"/"Top 24"/"Top 8" are three different VIEWS of
  // the same tournament.mainBracket data (see filterBracketToTier) — the
  // selected tab just picks which one to hand to BracketView, unchanged.
  const mainViewKey =
    !isModelB && (selectedView === "main" || selectedView === "main-top24" || selectedView === "main-top8")
      ? selectedView
      : isModelB && selectedRound === "main"
        ? "main"
        : undefined;
  const displayedBracket = isPoolsFormat
    ? mainViewKey
      ? mainViewKey === "main"
        ? tournament.mainBracket
        : tournament.mainBracket
          ? filterBracketToTier(tournament.mainBracket, mainViewKey === "main-top8" ? 8 : 32)
          : null
      : (selectedPool?.bracket ?? null)
    : tournament.bracket;
  // Only meaningful when displayedBracket is a pool's own bracket (not the
  // main/Finals bracket, which mainViewKey selects and never has this
  // shape) — see BracketView's isFinalsCutoff prop for why a Finals-cutoff
  // pool bracket needs different round-shape handling than a standard one.
  const displayedBracketIsFinalsCutoff = isPoolsFormat && !mainViewKey && !!selectedPool?.isFinalsCutoff;
  const noPoolsYet = isModelB ? roundTabs.length === 0 : views.length === 0;

  return (
    <div className="min-h-screen w-full isolate">
      {/* Fixed backdrop — the bracket can be much taller than one viewport,
          so a `background` painted directly on this scrolling wrapper would
          scroll along with it. position:fixed decouples the two: this layer
          stays pinned to the viewport while everything else scrolls over it.
          No ancestor here sets transform/filter/perspective (checked
          app/layout.tsx's body and this component's own tree), so `fixed`
          resolves against the viewport as expected — same class of gotcha
          that broke the sponsor banner's sticky positioning previously,
          just via a different property (overflow there, transform here).
          `isolate` on this wrapper is load-bearing: without a stacking
          context boundary here, this div's negative z-index escapes all the
          way up past <body>'s own opaque background (`var(--navy)`) instead
          of just going behind the bracket content — the classic
          negative-z-index-background gotcha, confirmed by screenshot before
          this was added (backdrop was invisible, hidden behind body's bg). */}
      <div
        className="fixed inset-0 -z-10"
        style={{
          background: hasBackground
            ? `linear-gradient(rgba(13,15,26,0.55), rgba(13,15,26,0.55)), center / cover no-repeat url(${tournament.streamBackgroundUrl})`
            : "var(--navy)",
        }}
      />

      {activeBannerSlide && (
        // Sticky (not fixed) so it stays anchored to the top of the viewport
        // as the bracket scrolls beneath it, without needing to know the
        // page's height or take it out of normal flow — a broadcast overlay's
        // sponsor placement needs to stay visible throughout the stream.
        // Plain <img> (not next/image) is load-bearing for animated GIF
        // banners — Next's Image component re-encodes through its
        // optimizer and flattens GIFs to a static first frame.
        <div
          className="sticky top-0 z-20 w-full flex items-center justify-center py-3 px-4"
          style={{ background: "rgba(13,15,26,0.75)", borderBottom: "1px solid var(--border-strong)" }}
        >
          {activeBannerSlide.linkUrl ? (
            // Per-banner click-through link (settled July 28, 2026) — each
            // slide's own linkUrl, swapped as the slideshow rotates. New tab
            // since this is an OBS/broadcast-style page, not a normal
            // in-app link a viewer would want to navigate away from.
            <a href={activeBannerSlide.linkUrl} target="_blank" rel="noopener noreferrer">
              <img key={activeBannerSlide.url} src={activeBannerSlide.url} alt="Sponsor" className="max-h-16 sm:max-h-20 object-contain" />
            </a>
          ) : (
            <img key={activeBannerSlide.url} src={activeBannerSlide.url} alt="Sponsor" className="max-h-16 sm:max-h-20 object-contain" />
          )}
        </div>
      )}

      <div className="px-4 sm:px-8 py-6 sm:py-8">
        <h1 className="font-rajdhani text-3xl sm:text-4xl font-bold text-white leading-tight">{tournament.name}</h1>
        <p className="text-[13px] sm:text-[14px] mb-6" style={{ color: "rgba(255,255,255,0.7)" }}>
          {tournament.game}
        </p>

        {isModelB && roundTabs.length > 0 && (
          <ViewTabs tabs={roundTabs} activeKey={selectedRound ?? roundTabs[0].key} onSelect={handleSelectRound} className="mb-3" />
        )}

        {isPoolsFormat && (!isModelB || selectedRound !== "main") && views.length > 0 && (
          <ViewTabs tabs={views} activeKey={selectedView ?? views[0].key} onSelect={setSelectedView} className="mb-6" />
        )}

        {(mainViewKey === "main-top24" || mainViewKey === "main-top8") && (
          <p className="text-[12px] mb-3" style={{ color: "rgba(255,255,255,0.6)" }}>
            {liveCount} live {liveCount === 1 ? "entrant" : "entrants"} remaining
          </p>
        )}

        {displayedBracket ? (
          <BracketView
            bracket={displayedBracket}
            canManage={false}
            lineColor={tournament.bracketLineColor ?? undefined}
            boxColor={tournament.bracketBoxColor ?? undefined}
            fontColor={tournament.bracketFontColor ?? undefined}
            isFinalsCutoff={displayedBracketIsFinalsCutoff}
          />
        ) : (
          <p className="text-[14px]" style={{ color: "rgba(255,255,255,0.7)" }}>
            {isPoolsFormat && noPoolsYet ? "Pools haven't been generated yet." : "Bracket not yet generated."}
          </p>
        )}
      </div>
    </div>
  );
}
