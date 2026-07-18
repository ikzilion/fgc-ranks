// components/BracketView.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { ReportMatchButton } from "./ReportMatchButton";

interface BracketMatch {
  id: string;
  round: string;
  status: string;
  bracketSide: string;
  bracketRound: number;
  bracketPosition: number;
  player1Score: number;
  player2Score: number;
  player1?: { id: string; tag: string } | null;
  player2?: { id: string; tag: string } | null;
  winner?: { id: string; tag: string } | null;
  nextMatch?: { id: string } | null;
  nextLoserMatch?: { id: string } | null;
}

const SEEDING_LABELS: Record<string, string> = {
  RANDOM: "Fully random",
  RANDOM_WITHIN_TIERS: "Random within tiers",
  MANUAL: "Manual",
};

const SIDE_LABELS: Record<string, string> = {
  WINNERS: "Winners Bracket",
  LOSERS: "Losers Bracket",
  GRAND_FINAL: "Grand Finals",
  GRAND_FINAL_RESET: "Bracket Reset",
};

function PlayerRow({ player, score, status, isWinner }: { player?: { id: string; tag: string } | null; score: number; status: string; isWinner: boolean }) {
  return (
    <div className={`flex items-center justify-between py-1 ${isWinner ? "opacity-100" : "opacity-60"}`}>
      <span
        className="font-rajdhani text-[13px] font-semibold truncate"
        style={{ color: player ? "var(--text-primary)" : "var(--text-muted)", fontStyle: player ? "normal" : "italic" }}
      >
        {player ? player.tag : "TBD"}
      </span>
      <span className="font-rajdhani text-[13px] font-bold" style={{ color: isWinner ? "var(--green)" : "var(--text-muted)" }}>
        {status === "COMPLETED" ? score : "—"}
      </span>
    </div>
  );
}

function MatchCard({ match, canManage, registerRef }: { match: BracketMatch; canManage: boolean; registerRef: (id: string, el: HTMLDivElement | null) => void }) {
  const ready = !!match.player1 && !!match.player2;

  return (
    <div ref={el => registerRef(match.id, el)} className="fgc-card p-3 w-56 flex-shrink-0">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">{match.round}</p>
        {ready && <ReportMatchButton match={match as any} canManage={canManage} />}
      </div>

      <PlayerRow player={match.player1} score={match.player1Score} status={match.status} isWinner={!!match.winner && match.winner.id === match.player1?.id} />
      <PlayerRow player={match.player2} score={match.player2Score} status={match.status} isWinner={!!match.winner && match.winner.id === match.player2?.id} />
    </div>
  );
}

function BracketSideSection({
  side,
  matches,
  canManage,
  registerRef,
}: {
  side: string;
  matches: BracketMatch[];
  canManage: boolean;
  registerRef: (id: string, el: HTMLDivElement | null) => void;
}) {
  const rounds = new Map<number, BracketMatch[]>();
  for (const m of matches) {
    if (!rounds.has(m.bracketRound)) rounds.set(m.bracketRound, []);
    rounds.get(m.bracketRound)!.push(m);
  }
  const roundNumbers = [...rounds.keys()].sort((a, b) => a - b);

  return (
    <div className="mb-6">
      <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">{SIDE_LABELS[side] ?? side}</p>
      <div className="flex gap-10">
        {roundNumbers.map(r => (
          <div key={r} className="flex flex-col gap-6 justify-center">
            {rounds.get(r)!
              .sort((a, b) => a.bracketPosition - b.bracketPosition)
              .map(m => (
                <MatchCard key={m.id} match={m} canManage={canManage} registerRef={registerRef} />
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  kind: "winner" | "loser";
}

export function BracketView({
  bracket,
  canManage,
}: {
  bracket: { seedingMethod: string; size: number; matches: BracketMatch[] };
  canManage: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cardEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const [overlay, setOverlay] = useState<{ width: number; height: number; lines: Line[] }>({ width: 0, height: 0, lines: [] });

  function registerRef(id: string, el: HTMLDivElement | null) {
    if (el) cardEls.current.set(id, el);
    else cardEls.current.delete(id);
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function measure() {
      const containerEl = containerRef.current;
      if (!containerEl) return;
      const containerRect = containerEl.getBoundingClientRect();

      const posById = new Map<string, { top: number; bottom: number; left: number; right: number; midY: number }>();
      for (const m of bracket.matches) {
        const el = cardEls.current.get(m.id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const top = r.top - containerRect.top + containerEl.scrollTop;
        const left = r.left - containerRect.left + containerEl.scrollLeft;
        posById.set(m.id, { top, bottom: top + r.height, left, right: left + r.width, midY: top + r.height / 2 });
      }

      const lines: Line[] = [];
      for (const m of bracket.matches) {
        const from = posById.get(m.id);
        if (!from) continue;

        if (m.nextMatch) {
          const to = posById.get(m.nextMatch.id);
          if (to) lines.push({ x1: from.right, y1: from.midY, x2: to.left, y2: to.midY, kind: "winner" });
        }
        if (m.nextLoserMatch) {
          const to = posById.get(m.nextLoserMatch.id);
          if (to) lines.push({ x1: from.right, y1: from.midY, x2: to.left, y2: to.midY, kind: "loser" });
        }
      }

      setOverlay({ width: containerEl.scrollWidth, height: containerEl.scrollHeight, lines });
    }

    measure();
    const resizeObserver = new ResizeObserver(() => measure());
    resizeObserver.observe(container);
    window.addEventListener("resize", measure);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [bracket.matches]);

  const bySide: Record<string, BracketMatch[]> = { WINNERS: [], LOSERS: [], GRAND_FINAL: [], GRAND_FINAL_RESET: [] };
  for (const m of bracket.matches) {
    if (bySide[m.bracketSide]) bySide[m.bracketSide].push(m);
  }

  return (
    <div>
      <p className="text-[12px] mb-1" style={{ color: "var(--text-secondary)" }}>
        Seeded: {SEEDING_LABELS[bracket.seedingMethod] ?? bracket.seedingMethod} · Bracket size {bracket.size}
      </p>
      <p className="text-[11px] mb-4" style={{ color: "var(--text-muted)" }}>
        <span style={{ color: "var(--border-strong)" }}>―</span> winner advances &nbsp;
        <span style={{ color: "var(--coral)" }}>┄</span> loser drops to losers bracket
      </p>

      <div ref={containerRef} className="relative overflow-x-auto pb-2" style={{ WebkitOverflowScrolling: "touch" }}>
        <svg
          className="absolute top-0 left-0 pointer-events-none"
          width={overlay.width}
          height={overlay.height}
          style={{ minWidth: "100%" }}
        >
          {overlay.lines.map((line, i) => {
            const midX = (line.x1 + line.x2) / 2;
            const d = `M ${line.x1} ${line.y1} H ${midX} V ${line.y2} H ${line.x2}`;
            const isWinner = line.kind === "winner";
            return (
              <path
                key={i}
                d={d}
                fill="none"
                stroke={isWinner ? "var(--border-strong)" : "var(--coral)"}
                strokeWidth={1.5}
                strokeOpacity={isWinner ? 1 : 0.55}
                strokeDasharray={isWinner ? undefined : "4 3"}
              />
            );
          })}
        </svg>

        <div className="relative" style={{ minWidth: "max-content" }}>
          {bySide.WINNERS.length > 0 && <BracketSideSection side="WINNERS" matches={bySide.WINNERS} canManage={canManage} registerRef={registerRef} />}
          {bySide.LOSERS.length > 0 && <BracketSideSection side="LOSERS" matches={bySide.LOSERS} canManage={canManage} registerRef={registerRef} />}
          {bySide.GRAND_FINAL.length > 0 && <BracketSideSection side="GRAND_FINAL" matches={bySide.GRAND_FINAL} canManage={canManage} registerRef={registerRef} />}
          {bySide.GRAND_FINAL_RESET.length > 0 && <BracketSideSection side="GRAND_FINAL_RESET" matches={bySide.GRAND_FINAL_RESET} canManage={canManage} registerRef={registerRef} />}
        </div>
      </div>
    </div>
  );
}
