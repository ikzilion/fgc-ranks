// components/StreamBracket.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { BracketView } from "./BracketView";

const POLL_INTERVAL_MS = 12000;

const GET_STREAM_TOURNAMENT = `
  query GetStreamTournament($id: ID!) {
    tournament(id: $id) {
      id
      name
      game
      status
      streamBackgroundUrl
      sponsorBannerUrl
      bracketLineColor
      bracket {
        id
        seedingMethod
        size
        matches {
          id
          round
          status
          bracketSide
          bracketRound
          bracketPosition
          player1Score
          player2Score
          player1 { id tag }
          player2 { id tag }
          winner { id tag }
          nextMatch { id }
          nextLoserMatch { id }
        }
      }
    }
  }
`;

interface StreamTournament {
  id: string;
  name: string;
  game: string;
  status: string;
  streamBackgroundUrl?: string | null;
  sponsorBannerUrl?: string | null;
  bracketLineColor?: string | null;
  bracket: any;
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

  return (
    <div
      className="min-h-screen w-full"
      style={{
        background: hasBackground
          ? `linear-gradient(rgba(13,15,26,0.55), rgba(13,15,26,0.55)), center / cover no-repeat url(${tournament.streamBackgroundUrl})`
          : "var(--navy)",
      }}
    >
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

        {tournament.bracket ? (
          <BracketView bracket={tournament.bracket} canManage={false} lineColor={tournament.bracketLineColor ?? undefined} />
        ) : (
          <p className="text-[14px]" style={{ color: "rgba(255,255,255,0.7)" }}>
            Bracket not yet generated.
          </p>
        )}
      </div>
    </div>
  );
}
