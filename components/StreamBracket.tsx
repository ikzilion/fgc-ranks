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
      bracketLineColor
      bracketBoxColor
      bracketFontColor
      bracket {
        id
        seedingMethod
        size
        matches { ${MATCH_FIELDS} }
      }
      pools {
        id
        poolNumber
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
        matches { ${MATCH_FIELDS} }
      }
    }
  }
`;

interface StreamPool {
  id: string;
  poolNumber: number;
  bracket: any;
}

interface StreamTournament {
  id: string;
  name: string;
  game: string;
  status: string;
  format?: string | null;
  streamBackgroundUrl?: string | null;
  sponsorBannerUrl?: string | null;
  bracketLineColor?: string | null;
  bracketBoxColor?: string | null;
  bracketFontColor?: string | null;
  bracket: any;
  pools: StreamPool[];
  mainBracket: any;
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

  // Pool play + top-cut format only — a TO needs to put an individual
  // pool's bracket on stream during the pool stage, before the main bracket
  // even exists, not just the main/standard bracket. Selection is local
  // component state (not synced to a URL param) — a TO picks it once in the
  // browser source before/while going live; polling below only refreshes
  // match data, never resets which view is selected.
  const isPoolsFormat = tournament.format === "Pools + Bracket";
  const views = isPoolsFormat
    ? [
        ...(tournament.mainBracket ? [{ key: "main", label: "Main Bracket" }] : []),
        ...tournament.pools.map(p => ({ key: `pool-${p.id}`, label: `Pool ${p.poolNumber}` })),
      ]
    : [];
  const [selectedView, setSelectedView] = useState(views[0]?.key);
  const selectedPool = tournament.pools.find(p => `pool-${p.id}` === selectedView);
  const displayedBracket = isPoolsFormat
    ? selectedView === "main"
      ? tournament.mainBracket
      : (selectedPool?.bracket ?? null)
    : tournament.bracket;

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

      {tournament.sponsorBannerUrl && (
        // Sticky (not fixed) so it stays anchored to the top of the viewport
        // as the bracket scrolls beneath it, without needing to know the
        // page's height or take it out of normal flow — a broadcast overlay's
        // sponsor placement needs to stay visible throughout the stream.
        <div
          className="sticky top-0 z-20 w-full flex items-center justify-center py-3 px-4"
          style={{ background: "rgba(13,15,26,0.75)", borderBottom: "1px solid var(--border-strong)" }}
        >
          <img src={tournament.sponsorBannerUrl} alt="Sponsor" className="max-h-16 sm:max-h-20 object-contain" />
        </div>
      )}

      <div className="px-4 sm:px-8 py-6 sm:py-8">
        <h1 className="font-rajdhani text-3xl sm:text-4xl font-bold text-white leading-tight">{tournament.name}</h1>
        <p className="text-[13px] sm:text-[14px] mb-6" style={{ color: "rgba(255,255,255,0.7)" }}>
          {tournament.game}
        </p>

        {isPoolsFormat && views.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-6">
            {views.map(view => {
              const active = view.key === selectedView;
              return (
                <button
                  key={view.key}
                  onClick={() => setSelectedView(view.key)}
                  className="font-rajdhani text-[13px] font-bold tracking-wide px-3 py-1.5 rounded"
                  style={
                    active
                      ? { background: "var(--blue)", color: "white", border: "none", cursor: "pointer" }
                      : { background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.7)", border: "1px solid rgba(255,255,255,0.15)", cursor: "pointer" }
                  }
                >
                  {view.label}
                </button>
              );
            })}
          </div>
        )}

        {displayedBracket ? (
          <BracketView
            bracket={displayedBracket}
            canManage={false}
            lineColor={tournament.bracketLineColor ?? undefined}
            boxColor={tournament.bracketBoxColor ?? undefined}
            fontColor={tournament.bracketFontColor ?? undefined}
          />
        ) : (
          <p className="text-[14px]" style={{ color: "rgba(255,255,255,0.7)" }}>
            {isPoolsFormat && views.length === 0 ? "Pools haven't been generated yet." : "Bracket not yet generated."}
          </p>
        )}
      </div>
    </div>
  );
}
