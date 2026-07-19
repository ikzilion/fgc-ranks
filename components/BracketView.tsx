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

// Design system default when a tournament hasn't set a custom line color.
const DEFAULT_LINE_COLOR = "var(--border-strong)";

function PlayerRow({ player, score, status, isWinner }: { player?: { id: string; tag: string } | null; score: number; status: string; isWinner: boolean }) {
  return (
    <div className={`flex items-center justify-between py-1 ${isWinner ? "opacity-100" : "opacity-60"}`}>
      <div className="flex items-center gap-1.5 min-w-0">
        {isWinner && status === "COMPLETED" && (
          <span className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full flex-shrink-0" style={{ background: "var(--green)" }} />
        )}
        <span
          className="font-rajdhani text-[13px] font-semibold truncate"
          style={{ color: player ? "var(--text-primary)" : "var(--text-muted)", fontStyle: player ? "normal" : "italic" }}
        >
          {player ? player.tag : "TBD"}
        </span>
      </div>
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
  midX: number;
}

export function BracketView({
  bracket,
  canManage,
  lineColor,
}: {
  bracket: { seedingMethod: string; size: number; matches: BracketMatch[] };
  canManage: boolean;
  lineColor?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cardEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const [overlay, setOverlay] = useState<{ width: number; height: number; clientWidth: number; lines: Line[] }>({
    width: 0,
    height: 0,
    clientWidth: 0,
    lines: [],
  });
  // Mirrors containerRef's scrollLeft so the sticky range-slider scrollbar
  // below can show/drive the current scroll position without re-measuring
  // the whole bracket on every scroll tick.
  const [scrollLeft, setScrollLeft] = useState(0);

  const resolvedLineColor = lineColor && lineColor.trim() ? lineColor : DEFAULT_LINE_COLOR;

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
      const matchById = new Map(bracket.matches.map(m => [m.id, m]));
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

        // Winner-advance lines (same-side progression, WB→WB or LB→LB) always
        // draw — this is also how the WB Final and LB Final converge into
        // Grand Finals in the normal (3+ entrant) case, since both resolve
        // through nextMatchId there (see lib/bracket.ts's wireFeeder).
        if (m.nextMatch) {
          const to = posById.get(m.nextMatch.id);
          if (to) lines.push({ x1: from.right, y1: from.midY, x2: to.left, y2: to.midY, midX: 0 });
        }
        // nextLoserMatch normally represents a mid-bracket WB→LB drop, which
        // is visually confusing at real bracket scale — suppress those. The
        // one exception: the trivial 2-entrant bracket has no Losers Bracket
        // at all, so the sole WB match's loser feeds Grand Finals directly
        // via nextLoserMatch — that's an intentional convergence line, not a
        // drop, so it's still drawn (detected by checking the target's side).
        if (m.nextLoserMatch) {
          const targetSide = matchById.get(m.nextLoserMatch.id)?.bracketSide;
          if (targetSide === "GRAND_FINAL") {
            const to = posById.get(m.nextLoserMatch.id);
            if (to) lines.push({ x1: from.right, y1: from.midY, x2: to.left, y2: to.midY, midX: 0 });
          }
        }
      }

      // Every line between the same pair of columns shares the same x1/x2
      // (all cards in a column share the same left/right edge), so a plain
      // (x1+x2)/2 midpoint puts every line's vertical elbow segment at the
      // identical X position. When a column has fewer visible matches than
      // its neighbor (e.g. Losers Bracket consolidation rounds, which lose
      // rows to byes), several lines' vertical segments end up stacked on
      // top of each other and become visually indistinguishable — a line
      // can look like it terminates at a different card than it actually
      // does. Stagger each line's elbow X within its column-transition
      // group so overlapping lines separate into distinct visual lanes.
      const byTransition = new Map<string, Line[]>();
      for (const line of lines) {
        const key = `${line.x1}|${line.x2}`;
        if (!byTransition.has(key)) byTransition.set(key, []);
        byTransition.get(key)!.push(line);
      }
      for (const group of byTransition.values()) {
        group.sort((a, b) => a.y1 - b.y1);
        group.forEach((line, i) => {
          line.midX = line.x1 + (line.x2 - line.x1) * ((i + 1) / (group.length + 1));
        });
      }

      setOverlay({ width: containerEl.scrollWidth, height: containerEl.scrollHeight, clientWidth: containerEl.clientWidth, lines });
    }

    measure();
    const resizeObserver = new ResizeObserver(() => measure());
    resizeObserver.observe(container);
    window.addEventListener("resize", measure);

    // Keep the sticky scrollbar's thumb in sync when the user scrolls the
    // bracket directly (trackpad, touch, arrow keys) rather than dragging
    // the slider itself.
    function onScroll() {
      setScrollLeft(container!.scrollLeft);
    }
    container.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", measure);
      container!.removeEventListener("scroll", onScroll);
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
        <span style={{ color: "var(--green)" }}>●</span> winner &nbsp;&nbsp;
        <span style={{ color: resolvedLineColor }}>―</span> match progression
      </p>

      {/* No vertical clipping — a fixed vh-based cap kept looking out of
          place once tested against the real 30-entrant bracket (4 Winners
          rounds + 7 Losers rounds is a lot taller than the smaller brackets
          this was first tuned against), whatever the percentage. The
          bracket now flows to its natural height like any other page
          content. Horizontal panning is still needed at that width though,
          so instead of relying on the container's own scrollbar (unreachable
          without scrolling to wherever the bottom of a very tall box lands)
          there's a custom range-slider scrollbar right below, kept sticky to
          the bottom of the viewport for as long as any part of the bracket
          is on screen — see the sticky div after this one. */}
      <div ref={containerRef} className="relative overflow-x-auto no-scrollbar pb-2" style={{ WebkitOverflowScrolling: "touch" }}>
        <svg
          className="absolute top-0 left-0 pointer-events-none"
          width={overlay.width}
          height={overlay.height}
          style={{ minWidth: "100%" }}
        >
          {overlay.lines.map((line, i) => {
            const d = `M ${line.x1} ${line.y1} H ${line.midX} V ${line.y2} H ${line.x2}`;
            return <path key={i} d={d} fill="none" stroke={resolvedLineColor} strokeWidth={1.25} />;
          })}
        </svg>

        <div className="relative flex gap-10" style={{ minWidth: "max-content" }}>
          {/* Winners Bracket stacked above Losers Bracket, both reading
              left-to-right by round. */}
          <div className="flex flex-col">
            {bySide.WINNERS.length > 0 && <BracketSideSection side="WINNERS" matches={bySide.WINNERS} canManage={canManage} registerRef={registerRef} />}
            {bySide.LOSERS.length > 0 && <BracketSideSection side="LOSERS" matches={bySide.LOSERS} canManage={canManage} registerRef={registerRef} />}
          </div>
          {/* Grand Finals is its own final column to the right of both
              brackets — not interleaved — vertically centered between them,
              matching where its two converging lines (WB Final + LB Final
              winners) actually land. */}
          {(bySide.GRAND_FINAL.length > 0 || bySide.GRAND_FINAL_RESET.length > 0) && (
            <div className="flex flex-col justify-center">
              {bySide.GRAND_FINAL.length > 0 && <BracketSideSection side="GRAND_FINAL" matches={bySide.GRAND_FINAL} canManage={canManage} registerRef={registerRef} />}
              {bySide.GRAND_FINAL_RESET.length > 0 && <BracketSideSection side="GRAND_FINAL_RESET" matches={bySide.GRAND_FINAL_RESET} canManage={canManage} registerRef={registerRef} />}
            </div>
          )}
        </div>
      </div>

      {overlay.width > overlay.clientWidth && (
        <div className="sticky bottom-2 z-10 mt-2 px-3 py-2 rounded-md" style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}>
          <input
            type="range"
            aria-label="Scroll bracket horizontally"
            min={0}
            max={overlay.width - overlay.clientWidth}
            value={scrollLeft}
            onChange={e => {
              const v = Number(e.target.value);
              setScrollLeft(v);
              if (containerRef.current) containerRef.current.scrollLeft = v;
            }}
            className="w-full block cursor-pointer"
            style={{ accentColor: resolvedLineColor }}
          />
        </div>
      )}
    </div>
  );
}
