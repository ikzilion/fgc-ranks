// components/BracketView.tsx
"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  // Pool play + top-cut main-bracket seeding only (see lib/bracket.ts's
  // computeMainBracketSeedOrder) — was missing here, so a pools-format
  // main bracket seeded this way fell through to the `?? bracket.seedingMethod`
  // fallback below and showed the raw enum value instead of a friendly label.
  AVOID_SAME_POOL: "Avoid same-pool matchups",
};

const SIDE_LABELS: Record<string, string> = {
  WINNERS: "Winners Bracket",
  LOSERS: "Losers Bracket",
  GRAND_FINAL: "Grand Finals",
  GRAND_FINAL_RESET: "Bracket Reset",
};

// Design system default when a tournament hasn't set a custom line color.
const DEFAULT_LINE_COLOR = "var(--border-strong)";

// Bracket "pyramid" spacing constants. CARD_GAP is the desired vertical gap
// between two stacked cards (measured against the rendered gap-10/marginTop
// layout, not the nominal 1.5rem, since the project's root font-size isn't
// the 16px default) — this doesn't depend on who's viewing the bracket, so
// it stays a fixed constant.
//
// Card HEIGHT, on the other hand, is deliberately NOT a constant below —
// MatchCard's header row only renders ReportMatchButton's "Report/Edit
// result" + "Delete" pills for a canManage viewer (organizer/admin); a
// public/non-privileged viewer's card is missing that row content and
// renders noticeably shorter (measured: 110px public vs 137-140px as an
// organizer). A single hardcoded height can only ever be correct for
// whichever view it was tuned against — this used to be 110 (tuned against
// a public view) and silently mispositioned every card for organizer
// viewers, who saw the pyramid taper drift further off from the real
// feeder graph the deeper into a round column they looked, without ever
// producing an outright overlap (so it passed every previous overlap-only
// verification pass). BracketView now measures the ACTUALLY rendered card
// height live (see its measuredCardHeight state) and passes it down here
// as `cardHeight`, so both view types position correctly.
const CARD_GAP = 21;
const DEFAULT_CARD_HEIGHT = 110; // only an initial guess for the very first paint, before measurement runs

// A bye slot (an entrant advancing with no opponent) never gets a Match
// document created for it at all — see lib/bracket.ts's buildMatch, which
// returns a pass-through winner instead of pushing a draft whenever either
// side of a pairing is BYE. That means a bye shows up here only as an
// absent bracketPosition, not as a match with a missing player. To render a
// placeholder in that gap we need to know how many positions a round is
// SUPPOSED to have, independent of how many of them actually got a match —
// this mirrors buildDoubleEliminationBracket's round-shape math exactly
// (WB round r always has size/2^r positions; LB alternates consolidation
// (halves) and drop-in (unchanged) rounds), since those array lengths are
// fixed by `size` alone and never change based on which specific positions
// are byes.
function getRoundPositionCounts(size: number, side: string): number[] {
  const m = Math.log2(size);
  if (side === "WINNERS") {
    const counts: number[] = [];
    for (let r = 1; r <= m; r++) counts.push(size / 2 ** r);
    return counts;
  }
  if (side === "LOSERS") {
    if (m === 1) return []; // 2-entrant bracket has no Losers bracket at all
    const counts: number[] = [];
    let current = size / 4;
    counts.push(current); // Losers Round 1 (consolidation)
    for (let j = 1; j <= m - 1; j++) {
      const isLastDropIn = j === m - 1;
      counts.push(current); // drop-in round — length unchanged
      if (!isLastDropIn) {
        current = current / 2;
        counts.push(current); // consolidation round — length halves
      }
    }
    return counts;
  }
  return []; // GRAND_FINAL / GRAND_FINAL_RESET are single matches, never byed
}

// A bye gap has no Match document of its own, so "who took the bye" and
// "where do they land" can only be recovered by tracing forward one round:
// WINNERS always pairs adjacent slots (buildMatch(wbCurrent[i], wbCurrent[i+1]))
// so a round-r position p feeds round r+1's position floor(p/2), slot 1 (p
// even) or slot 2 (p odd) — see lib/bracket.ts's main WB loop. LOSERS
// alternates the same halving rule on odd ("consolidation") rounds with a
// "drop-in" rule on even rounds, where the previous round's output feeds
// forward 1:1 as slot 1 (the survivors side) against that round's incoming
// WB-loser wave (buildDropInRound(lbCurrent, wbLoserOutputsByRound[j])) — see
// lib/bracket.ts's buildConsolidationRound/buildDropInRound.
//
// This only traces ONE hop forward, which is sufficient for every bye this
// bracket structure can actually produce: a WB bye's target round (r+1) is
// guaranteed to be a real match (WB round 1 never pairs two byes together —
// see seedSlotOrder's proof — so WB round 2+ never itself has a gap), and an
// LB round's bye gap is the WINNER of a real player passing through (not a
// literal BYE slot), which can only combine with a real WB-loser wave entry
// next round (WB round 2+ never produces a bye-side loser either) — so it
// always resolves into a real match too. A gap whose target round doesn't
// exist (e.g. a bye at a bracket's very last round) is the one case this
// can't resolve — targetMatchId/player stay null and the card just shows a
// generic placeholder with no connector line rather than guessing.
interface ByeSlot {
  id: string; // synthetic — never collides with a real match id
  side: string;
  bracketRound: number;
  bracketPosition: number;
  targetMatchId: string | null;
  player: { id: string; tag: string } | null;
}

function computeByeSlots(matches: BracketMatch[], size: number): ByeSlot[] {
  const result: ByeSlot[] = [];
  for (const side of ["WINNERS", "LOSERS"]) {
    const counts = getRoundPositionCounts(size, side);
    if (counts.length === 0) continue;
    const byRoundPos = new Map<string, BracketMatch>();
    for (const m of matches) {
      if (m.bracketSide === side) byRoundPos.set(`${m.bracketRound}-${m.bracketPosition}`, m);
    }
    for (let r = 1; r <= counts.length; r++) {
      const expected = counts[r - 1];
      for (let p = 0; p < expected; p++) {
        if (byRoundPos.has(`${r}-${p}`)) continue; // real match exists — not a bye gap
        const isDropInRound = side === "LOSERS" && r % 2 === 0;
        const targetRound = r + 1;
        const targetPosition = isDropInRound ? p : Math.floor(p / 2);
        const targetSlot: 1 | 2 = isDropInRound ? 1 : p % 2 === 0 ? 1 : 2;
        const target = targetRound <= counts.length ? byRoundPos.get(`${targetRound}-${targetPosition}`) : undefined;
        const player = target ? (targetSlot === 1 ? target.player1 : target.player2) ?? null : null;
        result.push({
          id: `bye-${side}-${r}-${p}`,
          side,
          bracketRound: r,
          bracketPosition: p,
          targetMatchId: target?.id ?? null,
          player,
        });
      }
    }
  }
  return result;
}

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
      <span className="font-rajdhani text-[17px] font-bold" style={{ color: isWinner ? "var(--green)" : "var(--text-primary)" }}>
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
      {/* Round label on its own full-width row, action buttons (canManage
          only) on a second row below — was previously squeezed onto one
          line together (label truncate/min-w-0 + button flex-shrink-0),
          which held up fine for a short label but a longer one (e.g.
          "Winners Round 1"/"Winners Round 2") combined with Edit result +
          Delete's two pills left almost no room, truncating to "WINNE…"/
          "WIN…" — reproducible even on a standard tournament's bracket, not
          specific to the Pool play tabs work. Same fix shape as the entrant
          list's two-line row: give the cramped content its own row instead
          of squeezing everything onto one line. Only rendered for
          canManage — a public/non-managing viewer never sees these buttons
          (ReportMatchButton returns null for !canManage) and its card
          height must stay exactly as before, so the wrapper itself is
          gated on canManage, not just ready, to avoid adding empty
          vertical space there. */}
      <p className="text-[10px] uppercase tracking-widest truncate w-full mb-1" style={{ color: fontColor || "var(--text-muted)" }}>{match.round}</p>
      {canManage && ready && (
        <div className="mb-2">
          <ReportMatchButton match={match as any} canManage={canManage} />
        </div>
      )}

      <PlayerRow player={match.player1} score={match.player1Score} status={match.status} isForfeit={match.isForfeit} isWinner={!!match.winner && match.winner.id === match.player1?.id} fontColor={fontColor} />
      <PlayerRow player={match.player2} score={match.player2Score} status={match.status} isForfeit={match.isForfeit} isWinner={!!match.winner && match.winner.id === match.player2?.id} fontColor={fontColor} />
    </div>
  );
}

// Placeholder for a bye slot — a bracketPosition with no Match document at
// all (see getRoundPositionCounts above). Its height is pinned to the
// shared `cardHeight` (not just intrinsic content) so the pyramid marginTop
// math — which assumes every column item is exactly `cardHeight` tall —
// stays correct for whatever renders after it in the same column.
// Uses the same `.fgc-card` class + boxColor/fontColor props as MatchCard
// (per user follow-up request, July 22, 2026) so its background/text ride
// the same theme variables (and future Color theme system) MatchCard does,
// instead of the old separate dashed/greyed treatment a theme switch
// wouldn't have touched. It still reads as "not a real match" purely
// through its content/label ("Bye player skipping round"), not color.
//
// Registered via `registerByeRef` — a SEPARATE ref map from MatchCard's
// registerRef, on purpose. This card now needs a real DOM position for the
// connector line to its Round 2 destination, but its height is force-pinned
// (not intrinsic) — if it were added to registerRef's cardEls instead, it
// would also enter BracketView's card-height MODE calculation, and on a
// bye-heavy bracket where byes approach or exceed the real-card count, a
// self-referential pinned height could tip the mode away from the true
// rendered card height, reintroducing the exact per-viewer drift bug
// `5fcaeb3` fixed. registerByeRef's byeEls map is read only for connector
// positions, never for height measurement.
function ByeCard({
  cardHeight,
  marginTop,
  byeId,
  registerByeRef,
  player,
  boxColor,
  fontColor,
}: {
  cardHeight: number;
  marginTop?: number;
  byeId: string;
  registerByeRef: (id: string, el: HTMLDivElement | null) => void;
  // The actual bye recipient, resolved from their real next-round match's
  // slot (see computeByeSlots) — null only when that match itself couldn't
  // be resolved (see computeByeSlots's comment on the rare last-round case).
  player: { id: string; tag: string } | null;
  // Same TO-configurable card background/text colors MatchCard receives —
  // a bye card now shares in a TO's color customization exactly like a real
  // match card would, rather than being exempted from it.
  boxColor?: string;
  fontColor?: string;
}) {
  return (
    <div
      ref={el => registerByeRef(byeId, el)}
      className="fgc-card w-56 flex-shrink-0 flex flex-col items-center justify-center gap-1 px-3"
      style={{
        height: cardHeight,
        // Smooths the one real, unavoidable transition every bracket goes
        // through: measuredCardHeight starts at DEFAULT_CARD_HEIGHT (a
        // guess, before any card has actually been measured) and corrects
        // to the true value shortly after mount. Every OTHER card
        // (MatchCard) sizes itself from its own intrinsic content, so that
        // correction is invisible there — but ByeCard pins its height AND
        // vertically centers its content, so the centered "Bye player
        // skipping round" label/name visibly pops to a new position the
        // instant cardHeight corrects (confirmed via frame-by-frame
        // measurement: the label's offset from its own card's top jumped
        // 34.5px -> 49px in a single frame, in perfect lockstep with
        // cardHeight jumping 110 -> 139, while the card's own on-screen
        // position never moved) — reads exactly like "the label shifts
        // independently while the rest of the card stays in place." A
        // transition on height alone is enough: the browser recomputes the
        // flex-centered position every intermediate frame automatically, so
        // the label eases into its corrected spot instead of jumping.
        transition: "height 150ms ease",
        ...(boxColor ? { background: boxColor } : undefined),
        ...(marginTop ? { marginTop } : undefined),
      }}
    >
      <p
        className="font-rajdhani text-[10px] font-semibold uppercase tracking-widest text-center truncate w-full"
        style={{ color: fontColor || "var(--text-muted)" }}
      >
        Bye player skipping round
      </p>
      {/* Same fontColor/fallback + TBD-italic convention as PlayerRow's tag
          text — a resolved bye recipient reads as a normal player name, not
          a dimmed one, matching how MatchCard treats a real advancing
          player. */}
      <p
        className="font-rajdhani text-[15px] font-semibold truncate w-full text-center"
        style={{ color: player ? (fontColor || "var(--text-primary)") : "var(--text-muted)", fontStyle: player ? "normal" : "italic" }}
      >
        {player ? player.tag : "TBD"}
      </p>
    </div>
  );
}

// Wrapped in memo — BracketView's own scrollLeft state (updated on every
// scroll tick, including incidental horizontal jitter during an otherwise-
// vertical scroll gesture — see BracketView's onScroll) re-renders the whole
// component tree purely to keep the sticky range-slider's value in sync, but
// nothing about a side section's OWN props actually changes from that. Without
// memo, every one of those re-renders re-ran the full pyramid-centering
// computation and rebuilt JSX for every card in this section, real,
// measurable cost confirmed via profiling (~34ms per tick on a real bracket,
// via a Chrome CDP trace during a scroll session with realistic diagonal
// jitter) that's proportional to bracket size — not unique to Pools + Bracket
// tournaments, but the kind of large multi-round bracket the Pool play
// feature's main brackets and bigger entrant counts make more likely to
// actually trip. See BracketView's own bySide/byeSlots-per-side useMemo and
// registerRef/registerByeRef useCallback below — this only actually skips
// re-rendering because those props are now referentially stable across a
// scrollLeft-only re-render too; memo alone doesn't help if its own props
// are still freshly recreated every time.
const BracketSideSection = memo(function BracketSideSection({
  side,
  matches,
  bracketSize,
  byeSlots = [],
  canManage,
  registerRef,
  registerByeRef,
  cardHeight,
  emphasized,
  dividerAbove,
  accentColor,
  boxColor,
  fontColor,
}: {
  side: string;
  matches: BracketMatch[];
  // Top-level bracket.size — needed to compute each round's expected
  // position count (see getRoundPositionCounts) so a bye gap can be
  // detected and rendered even though no Match document exists for it.
  bracketSize: number;
  // Pre-computed by BracketView (computeByeSlots), already filtered to this
  // side — one entry per detected bye gap, carrying the resolved bye
  // recipient and their real next-round target match id. Optional/empty for
  // GRAND_FINAL/GRAND_FINAL_RESET sections, which never have byes.
  byeSlots?: ByeSlot[];
  canManage: boolean;
  registerRef: (id: string, el: HTMLDivElement | null) => void;
  // Only needed alongside byeSlots — registers each ByeCard's DOM node into
  // BracketView's separate byeEls map, purely for connector-line position
  // lookup (see ByeCard's comment on why this is NOT registerRef/cardEls).
  registerByeRef?: (id: string, el: HTMLDivElement | null) => void;
  // The ACTUALLY rendered height of a match card in this session's view —
  // see BracketView's measuredCardHeight. Differs between a canManage
  // (organizer/admin) viewer and a public viewer, since only canManage
  // viewers get the ReportMatchButton row inside the card header.
  cardHeight: number;
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
  const roundSpacing = cardHeight + CARD_GAP;
  const byeByRoundPos = new Map<string, ByeSlot>();
  for (const b of byeSlots) byeByRoundPos.set(`${b.bracketRound}-${b.bracketPosition}`, b);
  const rounds = new Map<number, BracketMatch[]>();
  for (const m of matches) {
    if (!rounds.has(m.bracketRound)) rounds.set(m.bracketRound, []);
    rounds.get(m.bracketRound)!.push(m);
  }
  // The expected position counts (index 0 = round 1) cover every round this
  // side is SUPPOSED to have, including one that's entirely bye-skipped and
  // so would otherwise have zero real matches and never appear at all —
  // this is the superset roundNumbers must iterate, not just `rounds.keys()`.
  const expectedCounts = getRoundPositionCounts(bracketSize, side);
  const roundNumbers =
    expectedCounts.length > 0 ? expectedCounts.map((_, i) => i + 1) : [...rounds.keys()].sort((a, b) => a - b);

  // Sorted once per round, reused for both the pyramid-position computation
  // below and rendering. A round with no real matches at all (fully bye-
  // skipped) is legitimately absent from `rounds`, hence the `?? []`.
  const sortedByRound = new Map<number, BracketMatch[]>();
  for (const r of roundNumbers) {
    sortedByRound.set(r, [...(rounds.get(r) ?? [])].sort((a, b) => a.bracketPosition - b.bracketPosition));
  }

  // Bracket "pyramid" positioning — a match's Y-center is derived STRICTLY
  // from its real same-side feeder(s) (nextMatchId), recursively outward
  // from round 0's fixed baseline. This is the one invariant that must never
  // be broken: a 1- or 2-feeder match's center is ALWAYS exactly equal to
  // (or the exact average of) its real feeder(s)' own centers, with nothing
  // ever adjusting it afterward. The connector lines below independently
  // draw from each feeder's actual rendered position to its real target's
  // actual rendered position — so if a target's center is ever nudged away
  // from what its feeders dictate (as a since-reverted attempt at this fix
  // did, sweeping cards apart to avoid collisions), the rendered card and
  // the line pointing to it silently drift apart, and a line can end up
  // visually passing near — or appearing to terminate at — a DIFFERENT
  // card than the one it actually connects to. That was a real, confirmed
  // bug (not just a spacing complaint): Losers Round 1's SimPlayer07 match
  // legitimately feeds Losers Round 2's SimPlayer07 match via nextMatchId,
  // but the previous sweep had pushed that Round 2 card away from its
  // feeder's position to dodge an unrelated orphan card sorted before it,
  // making the two look disconnected.
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
  //    exact midpoint of both feeders, and the tree visually narrows here.
  //  - 1 feeder (LB drop-in rounds — the other slot is a freshly-dropped WB
  //    loser, not a same-side match) — center = that lone feeder's exact
  //    center, unchanged. Match count didn't shrink this round, so there's
  //    no narrowing, matching how a real double-elim bracket actually looks.
  //  - 0 feeders — round 0 of this side (no same-side round precedes it),
  //    OR a later round where BOTH of a match's occupants arrived without a
  //    real same-side match feeding it — either both slots were byes (e.g.
  //    two Winners Round 1 byes landing adjacent to each other and both
  //    feeding the same Winners Round 2 match — confirmed to actually
  //    happen on a small, bye-heavy bracket: the Pool play feature's main
  //    bracket, 10 real entrants padded to 16, hits this exact case), or a
  //    Winners-bracket loser dropped straight into a Losers round that was
  //    itself entirely bye-skipped earlier.
  //
  //    BUG FIXED HERE (found on that same bye-heavy bracket): this branch
  //    used to multiply bracketPosition directly by roundSpacing regardless
  //    of round — correct ONLY for a side's own first round, where
  //    bracketPosition already sits on the finest per-slot grid. Any LATER
  //    round that has already halved (every Winners round past the first;
  //    a Losers consolidation round past its first) has a COARSER
  //    bracketPosition numbering — position 1 in Winners Round 2 does NOT
  //    sit at 1 * roundSpacing, it spans what were positions 2-3 in Round
  //    1. Using the raw multiply put two DIFFERENT Round 2 matches at the
  //    exact same computed center (confirmed via the real match/feeder data:
  //    Round 2 position 0's single real feeder sat at Round-1 position 1,
  //    center 201.75; Round 2 position 1 had zero real feeders and fell
  //    back to 1 * roundSpacing, ALSO 201.75) — two cards rendered
  //    perfectly on top of each other.
  //
  //    Fix: rescale bracketPosition by how many round-0 slots one position
  //    in THIS round actually spans (`scale`), derived from the real
  //    getRoundPositionCounts ratio rather than assumed — works for
  //    Winners' every-round halving AND Losers' alternating
  //    consolidation/drop-in pattern uniformly, and reduces to the exact
  //    original formula (scale === 1) for a side's own first round, so nothing
  //    about that already-correct baseline case changes. GRAND_FINAL/
  //    GRAND_FINAL_RESET have no expectedCounts (single match, never byed) —
  //    scale stays 1 there too, same as always.
  //
  //    Crucially, for every drop-in round chained forward from this
  //    baseline (1:1 position mapping — see buildDropInRound), a real
  //    feeder's exact center ALWAYS equals that same round's own rescaled
  //    bracketPosition formula by construction, so this never collides with
  //    (or duplicates) a real feeder-derived center — no separate collision
  //    pass is needed, and none should be added back.
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
    sortedByRound.get(r)!.forEach(m => {
      const feeders = feedersByTarget.get(m.id) ?? [];
      if (feeders.length === 2) {
        centerById.set(m.id, (centerById.get(feeders[0])! + centerById.get(feeders[1])!) / 2);
      } else if (feeders.length === 1) {
        centerById.set(m.id, centerById.get(feeders[0])!);
      } else {
        const scale = expectedCounts.length > 0 ? expectedCounts[0] / expectedCounts[r - 1] : 1;
        centerById.set(m.id, (m.bracketPosition * scale + (scale - 1) / 2) * roundSpacing + cardHeight / 2);
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
          const expectedCount = expectedCounts[r - 1];
          // Merge real matches with bye placeholders into one position-
          // ordered column. A bye position's center uses the exact same
          // 0-feeder formula as a real match with no traceable same-side
          // feeder (see centerById above) — a bye slot by definition has no
          // real same-side match feeding it either, so this stays
          // consistent with the one invariant that must never be broken.
          type ColumnItem = { kind: "match"; match: BracketMatch } | { kind: "bye"; byeSlot: ByeSlot };
          let columnItems: ColumnItem[];
          if (expectedCount !== undefined) {
            const byPosition = new Map(roundMatches.map(m => [m.bracketPosition, m]));
            columnItems = [];
            for (let p = 0; p < expectedCount; p++) {
              const m = byPosition.get(p);
              columnItems.push(m ? { kind: "match", match: m } : { kind: "bye", byeSlot: byeByRoundPos.get(`${r}-${p}`)! });
            }
          } else {
            columnItems = roundMatches.map(m => ({ kind: "match", match: m }));
          }
          const centerOf = (item: ColumnItem) =>
            item.kind === "match" ? centerById.get(item.match.id)! : item.byeSlot.bracketPosition * roundSpacing + cardHeight / 2;
          return (
            <div key={r} className="flex flex-col">
              {columnItems.map((item, idx) => {
                const center = centerOf(item);
                // First card in the column: offset from the column's own
                // top (y=0) to this card's top. Every card after: the gap
                // needed between the previous card's bottom and this one's
                // top so the two cards' centers land the right distance
                // apart — this is what lets the *rendered* margin actually
                // achieve the computed `center` values above, since flex
                // children stack from the previous child's bottom edge.
                const marginTop = idx === 0 ? center - cardHeight / 2 : center - centerOf(columnItems[idx - 1]) - cardHeight;
                if (item.kind === "bye") {
                  return (
                    <ByeCard
                      key={item.byeSlot.id}
                      byeId={item.byeSlot.id}
                      registerByeRef={registerByeRef ?? (() => {})}
                      player={item.byeSlot.player}
                      cardHeight={cardHeight}
                      marginTop={marginTop}
                      boxColor={boxColor}
                      fontColor={fontColor}
                    />
                  );
                }
                return (
                  <MatchCard
                    key={item.match.id}
                    match={item.match}
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
});

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
  // Separate from cardEls on purpose — see ByeCard's comment. Read only for
  // connector-line positions in measure() below, never for card-height
  // measurement.
  const byeEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const [overlay, setOverlay] = useState<{ width: number; height: number; clientWidth: number; paths: string[] }>({
    width: 0,
    height: 0,
    clientWidth: 0,
    paths: [],
  });
  // A match card's rendered height depends on canManage — only an organizer/
  // admin viewer's card includes ReportMatchButton's "Report/Edit result" +
  // "Delete" row (measured: ~110px for a public viewer vs ~137-140px for an
  // organizer/admin), so it can't be a hardcoded constant shared by every
  // viewer. DEFAULT_CARD_HEIGHT is only the initial guess for the very first
  // paint, before any card exists to measure — the effect below replaces it
  // with the real value as soon as one is rendered, and BracketSideSection's
  // whole pyramid layout is computed from whatever this currently holds.
  const [measuredCardHeight, setMeasuredCardHeight] = useState(DEFAULT_CARD_HEIGHT);
  // Mirrors containerRef's scrollLeft so the sticky range-slider scrollbar
  // below can show/drive the current scroll position without re-measuring
  // the whole bracket on every scroll tick.
  const [scrollLeft, setScrollLeft] = useState(0);

  const resolvedLineColor = lineColor && lineColor.trim() ? lineColor : DEFAULT_LINE_COLOR;
  const resolvedBoxColor = boxColor && boxColor.trim() ? boxColor : undefined;
  const resolvedFontColor = fontColor && fontColor.trim() ? fontColor : undefined;

  // useCallback (stable empty deps — these only ever write into refs, never
  // close over changing state) so BracketSideSection's memo actually holds
  // across a scrollLeft-only re-render; a plain function declaration here
  // would be a new reference every render, defeating the memo below despite
  // nothing about what these callbacks DO ever changing.
  const registerRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) cardEls.current.set(id, el);
    else cardEls.current.delete(id);
  }, []);

  const registerByeRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) byeEls.current.set(id, el);
    else byeEls.current.delete(id);
  }, []);

  // Memoized on bracket.matches/bracket.size so it's stable across renders
  // that don't actually change the bracket — lets the effect below list it
  // as a real dependency instead of silently reading a fresh-every-render
  // value out of closure.
  const byeSlots = useMemo(() => computeByeSlots(bracket.matches, bracket.size), [bracket.matches, bracket.size]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function measure() {
      const containerEl = containerRef.current;
      if (!containerEl) return;
      const containerRect = containerEl.getBoundingClientRect();

      // A card's own height is purely intrinsic (padding + content), never
      // affected by the marginTop this component computes for positioning —
      // every card in a given view is meant to share the same height (the
      // truncate/min-w-0 fix on the round label keeps it that way even for
      // an unusually long label like "Grand Finals (Reset)" combined with
      // canManage's button row). Taking the MODE (most common rounded
      // height) rather than the first-registered card or the max is a
      // deliberate belt-and-suspenders choice: it's correct in the normal
      // case where every card really is uniform, and it also can't be
      // thrown off by a single rare outlier the way MAX can — an earlier
      // version of this fix used MAX and that one card alone (a rarer,
      // always-solo match with no siblings to space against, so its own
      // slightly-different height was harmless in isolation) dragged the
      // SHARED height used by every OTHER round/side in the whole bracket
      // away from what those cards actually render at, reintroducing the
      // exact cumulative-drift bug this fix exists to close. Only updates
      // state when the value actually changed, so this settles after one
      // correction pass instead of looping (the corrected marginTop values
      // don't change any card's own height, so the next measure() call
      // reads back the same number and this is a no-op).
      // Bucketed by rounded-to-integer height (tolerates sub-pixel float
      // jitter between otherwise-identical cards), but the value stored per
      // bucket is the SUM of the real fractional heights seen — so the
      // winning bucket's average is the true rendered height (e.g. 120.5),
      // not the rounded integer key (121). Using the rounded key directly
      // here previously fed a slightly-wrong cardHeight into every card's
      // marginTop math, and since each round's marginTop subtracts the
      // previous card's cardHeight, a mere 0.5px per-card error compounded
      // deeper into the tree every round — the exact cumulative-drift
      // pattern this component's positioning math is designed to avoid.
      const heightBuckets = new Map<number, { count: number; sum: number }>();
      for (const el of cardEls.current.values()) {
        const raw = el.getBoundingClientRect().height;
        const key = Math.round(raw);
        const bucket = heightBuckets.get(key) ?? { count: 0, sum: 0 };
        bucket.count++;
        bucket.sum += raw;
        heightBuckets.set(key, bucket);
      }
      let modeHeight = 0;
      let modeCount = 0;
      for (const { count, sum } of heightBuckets.values()) {
        if (count > modeCount) {
          modeHeight = sum / count;
          modeCount = count;
        }
      }
      if (modeHeight > 0) {
        // Functional form so this is always compared against the latest
        // state, not whatever measuredCardHeight this closure captured when
        // the effect last ran (it isn't in the dependency array, since
        // re-running the whole effect on every height correction would
        // re-attach the ResizeObserver/scroll listener for no reason).
        setMeasuredCardHeight(prev => (Math.abs(modeHeight - prev) > 0.5 ? modeHeight : prev));
      }

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
      // Bye cards get a position entry too (from the separate byeEls map,
      // never cardEls — see ByeCard's comment), keyed by their synthetic id
      // alongside real match ids in the SAME posById map, so the feeder/
      // connector-drawing logic below can treat a bye exactly like any
      // other feeder without needing its own separate code path.
      for (const bye of byeSlots) {
        const el = byeEls.current.get(bye.id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const top = r.top - containerRect.top + containerEl.scrollTop;
        const left = r.left - containerRect.left + containerEl.scrollLeft;
        posById.set(bye.id, { top, bottom: top + r.height, left, right: left + r.width, midY: top + r.height / 2 });
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
      // A bye's connector — same treatment as a real feeder (see
      // computeByeSlots for how targetMatchId is resolved). This never adds
      // a feeder to a target that wasn't already going to have one drawn:
      // byeSlots only contains genuine gaps, so a fully-matched round's
      // targets are completely unaffected. A target with one real feeder
      // plus its bye feeder now has feeders.length === 2, landing on the
      // exact same shared-trunk elbow branch below as any ordinary
      // 2-feeder match — no changes needed to that drawing logic itself.
      for (const bye of byeSlots) {
        if (!bye.targetMatchId) continue;
        const from = posById.get(bye.id);
        if (!from || !posById.has(bye.targetMatchId)) continue;
        addFeeder(bye.targetMatchId, from.right, from.midY);
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
  }, [bracket.matches, byeSlots]);

  // Memoized against bracket.matches specifically (not recomputed on every
  // scrollLeft-only re-render) so the arrays passed to each memoized
  // BracketSideSection below stay referentially stable — a fresh array from
  // a plain per-render loop would look "changed" to memo's shallow prop
  // comparison even though the actual contents never did.
  const bySide = useMemo(() => {
    const grouped: Record<string, BracketMatch[]> = { WINNERS: [], LOSERS: [], GRAND_FINAL: [], GRAND_FINAL_RESET: [] };
    for (const m of bracket.matches) {
      if (grouped[m.bracketSide]) grouped[m.bracketSide].push(m);
    }
    return grouped;
  }, [bracket.matches]);
  // Same reasoning as bySide above — byeSlots.filter(...) inline in JSX
  // would also produce a fresh array every render.
  const winnersByeSlots = useMemo(() => byeSlots.filter(b => b.side === "WINNERS"), [byeSlots]);
  const losersByeSlots = useMemo(() => byeSlots.filter(b => b.side === "LOSERS"), [byeSlots]);

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
      {/* overflow-y-hidden is load-bearing, not decorative: setting only
          overflow-x (auto) leaves overflow-y at its default "visible", but
          per the CSS overflow spec a computed "visible" on one axis gets
          silently forced to "auto" when the OTHER axis isn't visible — so
          this container was ALSO a real vertical scroll container all
          along (confirmed: getComputedStyle showed overflowY: "auto", and
          scrollHeight was ~27px taller than clientHeight — a real, if
          small, internal vertical scroll capacity). That's what captured
          vertical wheel input here first, only chaining to the page scroll
          once exhausted — a genuine nested-scroll bug, not a rendering
          glitch (unrelated to the recent scroll-jank/ByeCard fixes).
          Explicitly setting overflow-y to "visible" would NOT fix this —
          the same spec rule re-forces it back to "auto". "hidden" isn't
          "visible", so the forcing rule doesn't apply: overflow-x stays
          auto (horizontal bracket panning keeps working) while overflow-y
          is genuinely hidden, not a scroll container, so vertical wheel
          input passes straight through to the page. The ~27px gap being
          clipped is empty measurement slack, not real bracket content —
          confirmed visually unaffected. */}
      <div ref={containerRef} className="relative overflow-x-auto overflow-y-hidden no-scrollbar pb-2" style={{ WebkitOverflowScrolling: "touch" }}>
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
            {bySide.WINNERS.length > 0 && <BracketSideSection side="WINNERS" matches={bySide.WINNERS} bracketSize={bracket.size} byeSlots={winnersByeSlots} registerByeRef={registerByeRef} canManage={canManage} registerRef={registerRef} cardHeight={measuredCardHeight} emphasized accentColor={resolvedLineColor} boxColor={resolvedBoxColor} fontColor={resolvedFontColor} />}
            {bySide.LOSERS.length > 0 && <BracketSideSection side="LOSERS" matches={bySide.LOSERS} bracketSize={bracket.size} byeSlots={losersByeSlots} registerByeRef={registerByeRef} canManage={canManage} registerRef={registerRef} cardHeight={measuredCardHeight} emphasized dividerAbove={bySide.WINNERS.length > 0} accentColor={resolvedLineColor} boxColor={resolvedBoxColor} fontColor={resolvedFontColor} />}
          </div>
          {/* Grand Finals is its own final column to the right of both
              brackets — not interleaved — vertically centered between them,
              matching where its two converging lines (WB Final + LB Final
              winners) actually land. */}
          {(bySide.GRAND_FINAL.length > 0 || bySide.GRAND_FINAL_RESET.length > 0) && (
            <div className="flex flex-col justify-center">
              {bySide.GRAND_FINAL.length > 0 && <BracketSideSection side="GRAND_FINAL" matches={bySide.GRAND_FINAL} bracketSize={bracket.size} canManage={canManage} registerRef={registerRef} cardHeight={measuredCardHeight} boxColor={resolvedBoxColor} fontColor={resolvedFontColor} />}
              {bySide.GRAND_FINAL_RESET.length > 0 && <BracketSideSection side="GRAND_FINAL_RESET" matches={bySide.GRAND_FINAL_RESET} bracketSize={bracket.size} canManage={canManage} registerRef={registerRef} cardHeight={measuredCardHeight} boxColor={resolvedBoxColor} fontColor={resolvedFontColor} />}
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
