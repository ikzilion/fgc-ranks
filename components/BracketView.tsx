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
  isForfeit: boolean;
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

// Bracket "pyramid" spacing constants — MatchCard's rendered height is
// effectively fixed (p-3 padding + the round-label row + two PlayerRows,
// all driven by fixed Tailwind classes with truncating text, no wrapping),
// measured directly against the live Community Showdown bracket via
// headless Chrome + getBoundingClientRect (58/58 cards, mixed TBD/pending/
// completed states, all exactly 98px). CARD_GAP is the previous gap-6
// column spacing (measured, not the nominal 1.5rem, since the project's
// root font-size isn't the 16px default). If MatchCard's internal
// structure/classes ever change, remeasure and update these two numbers —
// everything below is computed from them, not re-guessed per round.
const CARD_HEIGHT = 98;
const CARD_GAP = 21;
const ROUND0_SPACING = CARD_HEIGHT + CARD_GAP;

function PlayerRow({
  player,
  score,
  status,
  isWinner,
  isForfeit,
  fontColor,
}: {
  player?: { id: string; tag: string } | null;
  score: number;
  status: string;
  isWinner: boolean;
  isForfeit: boolean;
  // TO-configurable, applied only to an actual player's tag — TBD text stays
  // its own muted/italic styling (a status indicator, not decorative text),
  // and the winner dot + score coloring stay green/muted regardless, same as
  // the divider work left the winner indicator alone (see BracketSideSection).
  fontColor?: string;
}) {
  // Grey-out is a "this player lost" indicator, not a default state — only
  // applies once the match actually has a recorded result. A pending match
  // (no winner yet) previously greyed out BOTH names, since neither was
  // "the winner"; now it only dims the loser once the match is COMPLETED.
  return (
    <div className={`flex items-center justify-between py-1 ${status === "COMPLETED" && !isWinner ? "opacity-60" : "opacity-100"}`}>
      <div className="flex items-center gap-1.5 min-w-0">
        {isWinner && status === "COMPLETED" && (
          <span className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full flex-shrink-0" style={{ background: "var(--green)" }} />
        )}
        <span
          className="font-rajdhani text-[13px] font-semibold truncate"
          style={{ color: player ? (fontColor || "var(--text-primary)") : "var(--text-muted)", fontStyle: player ? "normal" : "italic" }}
        >
          {player ? player.tag : "TBD"}
        </span>
      </div>
      {/* Score used var(--text-muted) for the non-winner unconditionally,
          same bug as the name/row opacity fix above — stacked on top of the
          row's own opacity-60 dimming once the match is COMPLETED, the
          loser's score read as double-greyed, and a still-pending match's
          "—" placeholder was greyed out too even though nothing's decided
          yet. The row's opacity already conveys win/loss; the score text
          itself just needs the same normal color the name text uses,
          highlighting the winner in green. */}
      <span className="font-rajdhani text-[13px] font-bold" style={{ color: isWinner ? "var(--green)" : "var(--text-primary)" }}>
        {status === "COMPLETED" ? (isForfeit ? "FF" : score) : "—"}
      </span>
    </div>
  );
}

function MatchCard({
  match,
  canManage,
  registerRef,
  boxColor,
  fontColor,
  marginTop,
}: {
  match: BracketMatch;
  canManage: boolean;
  registerRef: (id: string, el: HTMLDivElement | null) => void;
  // TO-configurable card background — only applied when set, otherwise the
  // .fgc-card class's own default background applies as before.
  boxColor?: string;
  fontColor?: string;
  // Pyramid positioning within its round column — see BracketSideSection's
  // centerById computation. Undefined/0 behaves exactly like the old plain
  // stacked layout.
  marginTop?: number;
}) {
  const ready = !!match.player1 && !!match.player2;

  return (
    <div
      ref={el => registerRef(match.id, el)}
      className="fgc-card p-3 w-56 flex-shrink-0"
      style={{ ...(boxColor ? { background: boxColor } : undefined), ...(marginTop ? { marginTop } : undefined) }}
    >
      <div className="flex items-center justify-between mb-2">
        {/* Same fontColor prop/fallback pattern as PlayerRow's tag text below
            — was left out when bracketFontColor was originally scoped, per
            user follow-up now brought into scope alongside it. TBD text and
            win/loss score styling remain deliberately untouched. */}
        <p className="text-[10px] uppercase tracking-widest" style={{ color: fontColor || "var(--text-muted)" }}>{match.round}</p>
        {ready && <ReportMatchButton match={match as any} canManage={canManage} />}
      </div>

      <PlayerRow player={match.player1} score={match.player1Score} status={match.status} isForfeit={match.isForfeit} isWinner={!!match.winner && match.winner.id === match.player1?.id} fontColor={fontColor} />
      <PlayerRow player={match.player2} score={match.player2Score} status={match.status} isForfeit={match.isForfeit} isWinner={!!match.winner && match.winner.id === match.player2?.id} fontColor={fontColor} />
    </div>
  );
}

function BracketSideSection({
  side,
  matches,
  canManage,
  registerRef,
  emphasized,
  dividerAbove,
  accentColor,
  boxColor,
  fontColor,
}: {
  side: string;
  matches: BracketMatch[];
  canManage: boolean;
  registerRef: (id: string, el: HTMLDivElement | null) => void;
  // Winners/Losers are the two big top-level sections of the tree and get
  // a bigger, bolder heading than the default — Grand Finals/Bracket Reset
  // stay at the small muted style since they read fine as a single column,
  // not a whole side someone needs to visually locate while scanning.
  emphasized?: boolean;
  // Renders a border-top rule above the section's heading, for the seam
  // between Winners and Losers specifically — see the usage below.
  dividerAbove?: boolean;
  // The same TO-configurable color already used for the connector lines
  // (BracketView's resolvedLineColor) — reused here so a TO's color choice
  // applies consistently across the bracket's accents, not just the
  // connector lines. Only read when emphasized/dividerAbove is set.
  accentColor?: string;
  // TO-configurable match-card background/text colors — passed straight
  // through to every MatchCard in this section.
  boxColor?: string;
  fontColor?: string;
}) {
  const rounds = new Map<number, BracketMatch[]>();
  for (const m of matches) {
    if (!rounds.has(m.bracketRound)) rounds.set(m.bracketRound, []);
    rounds.get(m.bracketRound)!.push(m);
  }
  const roundNumbers = [...rounds.keys()].sort((a, b) => a - b);

  // Sorted once per round, reused for both the pyramid-position computation
  // below and rendering.
  const sortedByRound = new Map<number, BracketMatch[]>();
  for (const r of roundNumbers) {
    sortedByRound.set(r, [...rounds.get(r)!].sort((a, b) => a.bracketPosition - b.bracketPosition));
  }

  // Classic bracket "pyramid" positioning: each round's cards are centered
  // on their same-side feeder match(es) from the previous round, computed
  // recursively outward from round 0's evenly-spaced baseline — rather than
  // the plain even-stacking (`justify-center` on a `gap-6` column) this
  // replaces, which never aligned a card with its feeders' actual midpoint.
  //
  // Reuses the exact same feeder-collection rule the connector lines below
  // use: only `nextMatch` (same-side progression) counts. A WB→LB drop via
  // `nextLoserMatch` is deliberately NOT counted here either, for the same
  // reason the connector lines don't draw it — Winners and Losers render as
  // two independently-stacked blocks with no shared coordinate frame, so
  // centering an LB drop-in match on a WB card in a different block
  // wouldn't be meaningful.
  //
  // This also correctly handles the Losers Bracket's alternating
  // consolidation/drop-in rounds (see lib/bracket.ts) without assuming
  // every round simply halves in count:
  //  - 2 feeders (every WB round; LB consolidation rounds) — center is the
  //    midpoint of both feeders, and the tree visually narrows here.
  //  - 1 feeder (LB drop-in rounds — the other slot is a freshly-dropped WB
  //    loser, not a same-side match) — center = that lone feeder's center,
  //    unchanged. Match count didn't shrink this round, so there's no
  //    narrowing, matching how a real double-elim bracket actually looks.
  //  - 0 feeders (round 0 of this side) — evenly-spaced baseline.
  // Byes are handled the same way: a round's real match count can be less
  // than a naive power-of-two count would assume, but this only ever reads
  // the REAL feeder relationships, never an assumed index/count pattern, so
  // a bye-shortened round just naturally has fewer entries — nothing here
  // miscounts or needs special-casing for it.
  const idsInSide = new Set(matches.map(m => m.id));
  const feedersByTarget = new Map<string, string[]>();
  for (const m of matches) {
    if (m.nextMatch && idsInSide.has(m.nextMatch.id)) {
      if (!feedersByTarget.has(m.nextMatch.id)) feedersByTarget.set(m.nextMatch.id, []);
      feedersByTarget.get(m.nextMatch.id)!.push(m.id);
    }
  }
  const centerById = new Map<string, number>();
  for (const r of roundNumbers) {
    sortedByRound.get(r)!.forEach((m, idx) => {
      const feeders = feedersByTarget.get(m.id) ?? [];
      if (feeders.length === 2) {
        centerById.set(m.id, (centerById.get(feeders[0])! + centerById.get(feeders[1])!) / 2);
      } else if (feeders.length === 1) {
        centerById.set(m.id, centerById.get(feeders[0])!);
      } else {
        centerById.set(m.id, idx * ROUND0_SPACING + CARD_HEIGHT / 2);
      }
    });
  }

  return (
    <div className="mb-6" style={dividerAbove ? { borderTop: `6px solid ${accentColor}`, paddingTop: 24, marginTop: 8 } : undefined}>
      {emphasized ? (
        <p className="font-rajdhani text-2xl font-bold uppercase tracking-wide mb-3" style={{ color: accentColor }}>{SIDE_LABELS[side] ?? side}</p>
      ) : (
        <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">{SIDE_LABELS[side] ?? side}</p>
      )}
      {/* Back to the site's standard gap-10 — the wider gap-24 from an
          earlier pass existed only to spread out a lane-staggering scheme
          that fanned every line sharing a column pair across the gap. The
          connector logic below now draws one shared elbow trunk per sibling
          pair, always at the gap's own midpoint regardless of how many
          pairs share that column transition, so there's no more fan-in to
          make room for — a normal gap keeps the classic bracket look. */}
      <div className="flex gap-10">
        {roundNumbers.map(r => {
          const roundMatches = sortedByRound.get(r)!;
          return (
            <div key={r} className="flex flex-col">
              {roundMatches.map((m, idx) => {
                const center = centerById.get(m.id)!;
                // First card in the column: offset from the column's own
                // top (y=0) to this card's top. Every card after: the gap
                // needed between the previous card's bottom and this one's
                // top so the two cards' centers land the right distance
                // apart — this is what lets the *rendered* margin actually
                // achieve the computed `center` values above, since flex
                // children stack from the previous child's bottom edge.
                const marginTop =
                  idx === 0 ? center - CARD_HEIGHT / 2 : center - centerById.get(roundMatches[idx - 1].id)! - CARD_HEIGHT;
                return (
                  <MatchCard
                    key={m.id}
                    match={m}
                    canManage={canManage}
                    registerRef={registerRef}
                    boxColor={boxColor}
                    fontColor={fontColor}
                    marginTop={marginTop}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function BracketView({
  bracket,
  canManage,
  lineColor,
  boxColor,
  fontColor,
}: {
  bracket: { seedingMethod: string; size: number; matches: BracketMatch[] };
  canManage: boolean;
  lineColor?: string;
  // Unlike lineColor, these have no JS-level default constant here — when
  // unset, MatchCard/PlayerRow simply don't apply an inline style, so their
  // own existing CSS-class/hardcoded defaults (.fgc-card background,
  // var(--text-primary)) apply exactly as before this feature existed.
  boxColor?: string;
  fontColor?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cardEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const [overlay, setOverlay] = useState<{ width: number; height: number; clientWidth: number; paths: string[] }>({
    width: 0,
    height: 0,
    clientWidth: 0,
    paths: [],
  });
  // Mirrors containerRef's scrollLeft so the sticky range-slider scrollbar
  // below can show/drive the current scroll position without re-measuring
  // the whole bracket on every scroll tick.
  const [scrollLeft, setScrollLeft] = useState(0);

  const resolvedLineColor = lineColor && lineColor.trim() ? lineColor : DEFAULT_LINE_COLOR;
  const resolvedBoxColor = boxColor && boxColor.trim() ? boxColor : undefined;
  const resolvedFontColor = fontColor && fontColor.trim() ? fontColor : undefined;

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

      // Collect every source ("feeder") card's exit point, grouped by which
      // downstream match it feeds into. A target match normally has exactly
      // two feeders (its two slots) — occasionally just one, when a bye
      // cascaded a player directly into this match without a played match
      // on that side (see lib/bracket.ts's buildMatch/wireFeeder), so
      // nothing draws into that slot at all.
      const feedersByTarget = new Map<string, { x1: number; y1: number }[]>();
      function addFeeder(targetId: string, x1: number, y1: number) {
        if (!feedersByTarget.has(targetId)) feedersByTarget.set(targetId, []);
        feedersByTarget.get(targetId)!.push({ x1, y1 });
      }
      for (const m of bracket.matches) {
        const from = posById.get(m.id);
        if (!from) continue;

        // Winner-advance feeders (same-side progression, WB→WB or LB→LB)
        // always draw — this is also how the WB Final and LB Final converge
        // into Grand Finals in the normal (3+ entrant) case, since both
        // resolve through nextMatchId there (see lib/bracket.ts's wireFeeder).
        if (m.nextMatch && posById.has(m.nextMatch.id)) {
          addFeeder(m.nextMatch.id, from.right, from.midY);
        }
        // nextLoserMatch normally represents a mid-bracket WB→LB drop, which
        // is visually confusing at real bracket scale — suppress those. The
        // one exception: the trivial 2-entrant bracket has no Losers Bracket
        // at all, so the sole WB match's loser feeds Grand Finals directly
        // via nextLoserMatch — that's an intentional convergence feeder, not
        // a drop, so it's still drawn (detected by checking the target's side).
        if (m.nextLoserMatch && matchById.get(m.nextLoserMatch.id)?.bracketSide === "GRAND_FINAL" && posById.has(m.nextLoserMatch.id)) {
          addFeeder(m.nextLoserMatch.id, from.right, from.midY);
        }
      }

      // Classic "elbow bracket per sibling pair" connector: for a target
      // with two feeders, draw ONE shared vertical trunk at the horizontal
      // midpoint between the source and target columns, spanning from the
      // top feeder's Y to the bottom feeder's Y, with a short horizontal
      // stub from each feeder into the trunk and one stub from the trunk's
      // own midpoint into the target — the classic single "[" shape, with
      // no lane-staggering needed since a pair never overlaps with another
      // pair's trunk (each pair gets its own X only within its own column
      // gap, and different targets' trunks don't share an endpoint).
      const paths: string[] = [];
      for (const [targetId, feeders] of feedersByTarget) {
        const to = posById.get(targetId);
        if (!to) continue;
        feeders.sort((a, b) => a.y1 - b.y1);

        let i = 0;
        while (i < feeders.length) {
          if (i + 1 < feeders.length) {
            const top = feeders[i];
            const bottom = feeders[i + 1];
            if (Math.abs(top.x1 - bottom.x1) < 1) {
              // Common case: both siblings are in the same source column
              // (true for every Winners/Losers round transition, since a
              // target's two feeders always come from the immediately
              // preceding round) — the classic shared-trunk "[" pair.
              //
              // The trunk's Y span must include the target's OWN actual
              // midY, not just average the two feeders' Y and assume the
              // target sits exactly there. Each round column is
              // independently centered (`justify-center`) within the row's
              // shared height (driven by the tallest column, normally
              // Round 1), so a target's real position only equals its
              // feeders' average when the whole tree is a perfectly
              // symmetric power-of-two layout — Round 1 -> 2 mostly, but it
              // drifts further out at deeper rounds (Round 2 -> 3, 3 -> 4)
              // and anywhere byes skew the column heights. Terminating the
              // final stub at the averaged Y instead of the target's real
              // one left it floating next to the card instead of touching
              // it. Extending the trunk to span all three Y's guarantees
              // every stub — both feeders' and the target's — starts
              // exactly on the trunk, so nothing can end up disconnected.
              const midX = (top.x1 + to.left) / 2;
              const trunkTop = Math.min(top.y1, bottom.y1, to.midY);
              const trunkBottom = Math.max(top.y1, bottom.y1, to.midY);
              paths.push(`M ${midX} ${trunkTop} V ${trunkBottom}`);
              paths.push(`M ${top.x1} ${top.y1} H ${midX}`);
              paths.push(`M ${bottom.x1} ${bottom.y1} H ${midX}`);
              paths.push(`M ${midX} ${to.midY} H ${to.left}`);
            } else {
              // Different source columns — only happens at the Grand
              // Finals convergence, where the Winners Final and Losers
              // Final usually sit at different round depths (Losers has
              // more rounds), so there's no single column gap to share a
              // trunk X within. Each feeder gets its own independent elbow
              // converging on the target's actual center instead; two
              // lines meeting at one shared point can't overlap.
              for (const feeder of [top, bottom]) {
                const midX = (feeder.x1 + to.left) / 2;
                paths.push(`M ${feeder.x1} ${feeder.y1} H ${midX} V ${to.midY} H ${to.left}`);
              }
            }
            i += 2;
          } else {
            // Lone feeder — the other slot was filled directly by a bye
            // cascade, nothing to pair with: a plain point-to-point elbow.
            const solo = feeders[i];
            const midX = (solo.x1 + to.left) / 2;
            paths.push(`M ${solo.x1} ${solo.y1} H ${midX} V ${to.midY} H ${to.left}`);
            i += 1;
          }
        }
      }

      setOverlay({ width: containerEl.scrollWidth, height: containerEl.scrollHeight, clientWidth: containerEl.clientWidth, paths });
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
          {overlay.paths.map((d, i) => (
            <path key={i} d={d} fill="none" stroke={resolvedLineColor} strokeWidth={1.25} />
          ))}
        </svg>

        <div className="relative flex gap-10" style={{ minWidth: "max-content" }}>
          {/* Winners Bracket stacked above Losers Bracket, both reading
              left-to-right by round. */}
          <div className="flex flex-col">
            {bySide.WINNERS.length > 0 && <BracketSideSection side="WINNERS" matches={bySide.WINNERS} canManage={canManage} registerRef={registerRef} emphasized accentColor={resolvedLineColor} boxColor={resolvedBoxColor} fontColor={resolvedFontColor} />}
            {bySide.LOSERS.length > 0 && <BracketSideSection side="LOSERS" matches={bySide.LOSERS} canManage={canManage} registerRef={registerRef} emphasized dividerAbove={bySide.WINNERS.length > 0} accentColor={resolvedLineColor} boxColor={resolvedBoxColor} fontColor={resolvedFontColor} />}
          </div>
          {/* Grand Finals is its own final column to the right of both
              brackets — not interleaved — vertically centered between them,
              matching where its two converging lines (WB Final + LB Final
              winners) actually land. */}
          {(bySide.GRAND_FINAL.length > 0 || bySide.GRAND_FINAL_RESET.length > 0) && (
            <div className="flex flex-col justify-center">
              {bySide.GRAND_FINAL.length > 0 && <BracketSideSection side="GRAND_FINAL" matches={bySide.GRAND_FINAL} canManage={canManage} registerRef={registerRef} boxColor={resolvedBoxColor} fontColor={resolvedFontColor} />}
              {bySide.GRAND_FINAL_RESET.length > 0 && <BracketSideSection side="GRAND_FINAL_RESET" matches={bySide.GRAND_FINAL_RESET} canManage={canManage} registerRef={registerRef} boxColor={resolvedBoxColor} fontColor={resolvedFontColor} />}
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
