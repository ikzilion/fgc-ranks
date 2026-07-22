// lib/bracket.ts
// Double-elimination bracket generation + progression logic.
// Kept separate from graphql/resolvers/index.ts per the "keep resolvers
// thin" convention — this is the bracket "service" layer.
//
// ── How a double-elimination bracket is built ──────────────────────────────
// 1. Pad the entrant count N up to the next power of two, S. The S-N gap is
//    filled with "byes" — phantom slots that auto-advance their real
//    opponent without a match being played.
// 2. Place seeds 1..N (plus byes for N+1..S) into the S bracket slots using
//    the standard recursive seeding placement (seedSlotOrder), which spreads
//    top seeds apart and guarantees no two byes ever land in the same
//    Winners-Round-1 pairing (proof in seedSlotOrder's comment).
// 3. Simulate the Winners bracket (WB) round by round. Each WB match's
//    winner feeds the next WB round; each WB match's loser feeds into the
//    Losers bracket (LB).
// 4. Simulate the LB. It alternates between "consolidation" rounds (LB
//    survivors play each other) and "drop-in" rounds (LB survivors play the
//    incoming wave of that round's WB losers). Because of byes, a LB pairing
//    can have zero, one, or two real occupants — a "Slot" abstraction
//    (BYE / PLAYER / PENDING) models this uniformly for both brackets so the
//    same buildMatch() function handles every case, including cascading
//    byes deep into the LB.
// 5. WB champion vs LB champion play the Grand Final. By convention player1
//    is always the WB (winners-side) finalist and player2 the LB
//    (losers-side) finalist — reportResult relies on this ordering to detect
//    a bracket reset (LB finalist wins game 1 → decider match).
//
// Everything here through buildDoubleEliminationBracket() is pure/sync and
// touches no database — it only produces plain draft objects (with
// pre-generated _ids) for the resolver to insertMany(). advanceBracketMatch()
// and resolveSeedOrder() are the two pieces that do need DB access.

import { Types } from "mongoose";
import { Match } from "@/models/Match";
import { Entrant } from "@/models/Entrant";
import { Bracket } from "@/models/Bracket";
import { computeRankingPointsForPlayers } from "@/lib/ranking";

// ─── Small utilities ─────────────────────────────────────────────────────

export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

// Standard bracket seeding placement — returns seed numbers (1-indexed) in
// bracket-slot order, e.g. seedSlotOrder(8) = [1,8,4,5,2,7,3,6]. Recursively
// pairs seed k with seed (size+1-k) at every level, which is what guarantees
// top seeds can only meet in later rounds. It also guarantees byes (seed
// numbers beyond the real entrant count) never double up in one pairing: for
// a bye/bye pair you'd need two seeds k and (size+1-k) both > N, which needs
// N <= (size-1)/2 — but size is the SMALLEST power of two >= N, so N is
// always > size/2, a contradiction. So Winners Round 1 never has a
// bye-vs-bye pairing.
export function seedSlotOrder(size: number): number[] {
  if (size === 1) return [1];
  const prev = seedSlotOrder(size / 2);
  const out: number[] = [];
  for (const s of prev) out.push(s, size + 1 - s);
  return out;
}

// ─── Seeding method resolution ───────────────────────────────────────────

export type SeedingMethod = "RANDOM" | "RANDOM_WITHIN_TIERS" | "MANUAL";

// Standard FGC "pools" tiering: sort by points descending, chunk into groups
// of 4, shuffle within each group, concatenate. Documented simplification —
// a fixed tier size rather than a dynamically computed one.
const TIER_SIZE = 4;

export async function resolveSeedOrder(
  seedingMethod: SeedingMethod,
  entrants: { playerId: any }[],
  manualSeedOrder?: string[] | null
): Promise<string[]> {
  const entrantPlayerIds = entrants.map(e => e.playerId.toString());

  if (seedingMethod === "MANUAL") {
    if (!manualSeedOrder || manualSeedOrder.length !== entrantPlayerIds.length) {
      throw new Error("Manual seeding requires an ordered list of every entrant's player ID");
    }
    const entrantSet = new Set(entrantPlayerIds);
    const providedIds = manualSeedOrder.map(String);
    const providedSet = new Set(providedIds);
    if (providedSet.size !== providedIds.length || providedIds.some(id => !entrantSet.has(id))) {
      throw new Error("Manual seed order must include each entrant's player ID exactly once");
    }
    return providedIds;
  }

  if (seedingMethod === "RANDOM_WITHIN_TIERS") {
    const pointsById = await computeRankingPointsForPlayers(entrantPlayerIds);
    const sorted = [...entrantPlayerIds].sort(
      (a, b) => (pointsById.get(b) ?? 0) - (pointsById.get(a) ?? 0)
    );
    const result: string[] = [];
    for (let i = 0; i < sorted.length; i += TIER_SIZE) {
      result.push(...shuffle(sorted.slice(i, i + TIER_SIZE)));
    }
    return result;
  }

  // RANDOM
  return shuffle([...entrantPlayerIds]);
}

// ─── Pool play + top-cut: main-bracket seeding ──────────────────────────
//
// Once every pool's Grand Final has completed, exactly 2 entrants advance
// per pool: the pool's own winners-finalist (Grand Final player1) and
// losers-finalist (Grand Final player2 — see buildDoubleEliminationBracket's
// Grand Final convention). This computes the seed order for the fresh main
// bracket built from all those advancers.
//
// "RANDOM": every advancer shuffled together, no regard for which pool they
// came from.
// "AVOID_SAME_POOL": EVO-style — winners-finalists get the low seeds
// (1..poolCount) and losers-finalists get the high seeds (poolCount+1..2x),
// each group shuffled independently. seedSlotOrder already guarantees low
// seeds only meet in later rounds, so pairing every pool's winners-finalist
// against a DIFFERENT pool's losers-finalist this way naturally keeps
// pool-mates apart until deep into the bracket, with no custom
// constraint-satisfaction pass needed.
export function computeMainBracketSeedOrder(
  winnersFinalistIds: string[],
  losersFinalistIds: string[],
  method: "RANDOM" | "AVOID_SAME_POOL"
): string[] {
  if (method === "AVOID_SAME_POOL") {
    return [...shuffle([...winnersFinalistIds]), ...shuffle([...losersFinalistIds])];
  }
  return shuffle([...winnersFinalistIds, ...losersFinalistIds]);
}

// ─── Bracket generation ──────────────────────────────────────────────────

export type BracketSide = "WINNERS" | "LOSERS" | "GRAND_FINAL" | "GRAND_FINAL_RESET";

export interface BracketMatchDraft {
  _id: Types.ObjectId;
  tournamentId: any;
  bracketId: Types.ObjectId;
  bracketSide: BracketSide;
  bracketRound: number;
  bracketPosition: number;
  player1Id: Types.ObjectId | null;
  player2Id: Types.ObjectId | null;
  round: string;
  status: "PENDING";
  nextMatchId?: Types.ObjectId;
  nextMatchSlot?: 1 | 2;
  nextLoserMatchId?: Types.ObjectId;
  nextLoserMatchSlot?: 1 | 2;
}

type Slot =
  | { kind: "BYE" }
  | { kind: "PLAYER"; playerId: Types.ObjectId }
  | { kind: "PENDING"; draft: BracketMatchDraft; which: "winner" | "loser" };

function wireFeeder(slot: Slot, targetDraft: BracketMatchDraft, targetSlotNum: 1 | 2) {
  if (slot.kind !== "PENDING") return;
  if (slot.which === "winner") {
    slot.draft.nextMatchId = targetDraft._id;
    slot.draft.nextMatchSlot = targetSlotNum;
  } else {
    slot.draft.nextLoserMatchId = targetDraft._id;
    slot.draft.nextLoserMatchSlot = targetSlotNum;
  }
}

interface MatchCtx {
  tournamentId: any;
  bracketId: Types.ObjectId;
  side: BracketSide;
  round: number;
  position: number;
  label: string;
}

// Builds a real match from two slots, or resolves a bye pass-through if one
// (or both) side is empty. Returns the winner-slot (feeds the next round)
// and loser-slot (BYE if no real match was created here).
function buildMatch(slotA: Slot, slotB: Slot, ctx: MatchCtx, drafts: BracketMatchDraft[]): { winner: Slot; loser: Slot } {
  if (slotA.kind === "BYE" && slotB.kind === "BYE") return { winner: { kind: "BYE" }, loser: { kind: "BYE" } };
  if (slotA.kind === "BYE") return { winner: slotB, loser: { kind: "BYE" } };
  if (slotB.kind === "BYE") return { winner: slotA, loser: { kind: "BYE" } };

  const draft: BracketMatchDraft = {
    _id: new Types.ObjectId(),
    tournamentId: ctx.tournamentId,
    bracketId: ctx.bracketId,
    bracketSide: ctx.side,
    bracketRound: ctx.round,
    bracketPosition: ctx.position,
    player1Id: slotA.kind === "PLAYER" ? slotA.playerId : null,
    player2Id: slotB.kind === "PLAYER" ? slotB.playerId : null,
    round: ctx.label,
    status: "PENDING",
  };
  drafts.push(draft);

  wireFeeder(slotA, draft, 1);
  wireFeeder(slotB, draft, 2);

  return {
    winner: { kind: "PENDING", draft, which: "winner" },
    loser: { kind: "PENDING", draft, which: "loser" },
  };
}

// Consolidation round: pairs ADJACENT slots within one array (halves size).
function buildConsolidationRound(
  input: Slot[],
  ctx: Omit<MatchCtx, "position">,
  drafts: BracketMatchDraft[]
): Slot[] {
  const output: Slot[] = [];
  for (let i = 0; i < input.length; i += 2) {
    const { winner } = buildMatch(input[i], input[i + 1], { ...ctx, position: i / 2 }, drafts);
    output.push(winner);
  }
  return output;
}

// Drop-in round: pairs two equal-length arrays element-wise (no halving —
// one match per element, since it's matching LB survivors 1:1 against the
// incoming wave of WB losers).
function buildDropInRound(
  a: Slot[],
  b: Slot[],
  ctx: Omit<MatchCtx, "position">,
  drafts: BracketMatchDraft[]
): Slot[] {
  const output: Slot[] = [];
  for (let i = 0; i < a.length; i++) {
    const { winner } = buildMatch(a[i], b[i], { ...ctx, position: i }, drafts);
    output.push(winner);
  }
  return output;
}

export function buildDoubleEliminationBracket(params: {
  tournamentId: any;
  bracketId: Types.ObjectId;
  orderedPlayerIds: string[]; // seed 1..N in order, position 0 = seed 1
}): { matches: BracketMatchDraft[] } {
  const { tournamentId, bracketId, orderedPlayerIds } = params;
  const n = orderedPlayerIds.length;
  const size = nextPowerOfTwo(n);
  const m = Math.log2(size); // number of Winners-bracket rounds

  const seedToSlot = (seed: number): Slot =>
    seed <= n ? { kind: "PLAYER", playerId: new Types.ObjectId(orderedPlayerIds[seed - 1]) } : { kind: "BYE" };

  const slots = seedSlotOrder(size).map(seedToSlot);
  const drafts: BracketMatchDraft[] = [];

  // ── Winners bracket ──────────────────────────────────────────────
  let wbCurrent = slots;
  const wbLoserOutputsByRound: Slot[][] = []; // [0] = WB round 1 losers, [1] = round 2, ...
  for (let r = 1; r <= m; r++) {
    const label = r === m ? "Winners Finals" : `Winners Round ${r}`;
    const roundWinners: Slot[] = [];
    const roundLosers: Slot[] = [];
    for (let i = 0; i < wbCurrent.length; i += 2) {
      const { winner, loser } = buildMatch(
        wbCurrent[i],
        wbCurrent[i + 1],
        { tournamentId, bracketId, side: "WINNERS", round: r, position: i / 2, label },
        drafts
      );
      roundWinners.push(winner);
      roundLosers.push(loser);
    }
    wbLoserOutputsByRound.push(roundLosers);
    wbCurrent = roundWinners;
  }
  const wbChampionSlot = wbCurrent[0];

  // ── Losers bracket ───────────────────────────────────────────────
  let lbChampionSlot: Slot;
  if (m === 1) {
    // Only one WB round (2 entrants) — no losers bracket needed. Its lone
    // loser goes straight to the Grand Final as the losers-side finalist.
    lbChampionSlot = wbLoserOutputsByRound[0][0];
  } else {
    let lbCurrent = buildConsolidationRound(
      wbLoserOutputsByRound[0],
      { tournamentId, bracketId, side: "LOSERS", round: 1, label: "Losers Round 1" },
      drafts
    );
    let roundNum = 2;
    for (let j = 1; j <= m - 1; j++) {
      const isLastDropIn = j === m - 1;
      lbCurrent = buildDropInRound(
        lbCurrent,
        wbLoserOutputsByRound[j],
        { tournamentId, bracketId, side: "LOSERS", round: roundNum, label: isLastDropIn ? "Losers Finals" : `Losers Round ${roundNum}` },
        drafts
      );
      roundNum++;
      if (!isLastDropIn) {
        lbCurrent = buildConsolidationRound(
          lbCurrent,
          { tournamentId, bracketId, side: "LOSERS", round: roundNum, label: `Losers Round ${roundNum}` },
          drafts
        );
        roundNum++;
      }
    }
    lbChampionSlot = lbCurrent[0];
  }

  // ── Grand Final ───────────────────────────────────────────────────
  // Convention: player1 = winners-side finalist, player2 = losers-side
  // finalist. advanceBracketMatch relies on this order to detect a reset.
  buildMatch(
    wbChampionSlot,
    lbChampionSlot,
    { tournamentId, bracketId, side: "GRAND_FINAL", round: 1, position: 0, label: "Grand Finals" },
    drafts
  );

  return { matches: drafts };
}

// ─── Progression on match report ─────────────────────────────────────────

// Called after reportResult/editMatchResult resolves a bracket match's
// winner/loser. Advances the winner into its next Winners/Losers slot, drops
// the loser into its next Losers-bracket slot (Winners-side matches only),
// and handles the Grand Final bracket-reset case.
//
// `isCorrection` (true only from editMatchResult) disables reset-creation:
// without it, correcting an already-decided Grand Final's winner to the
// losers-side finalist would be misread as "they just won game 1 of a new
// set," spuriously creating a reset match instead of just finalizing the
// corrected result. editMatchResult can only ever run on a Grand Final that
// has no reset yet (assertBracketMatchEditable blocks it once one exists),
// so a correction's result is always the final answer for that match.
export async function advanceBracketMatch(match: any, winnerId: any, loserId: any, options: { isCorrection?: boolean } = {}) {
  if (match.nextMatchId) {
    const field = match.nextMatchSlot === 1 ? "player1Id" : "player2Id";
    await Match.findByIdAndUpdate(match.nextMatchId, { [field]: winnerId });
  }
  if (match.nextLoserMatchId) {
    const field = match.nextLoserMatchSlot === 1 ? "player1Id" : "player2Id";
    await Match.findByIdAndUpdate(match.nextLoserMatchId, { [field]: loserId });
  }

  if (!options.isCorrection && match.bracketSide === "GRAND_FINAL" && winnerId.toString() === match.player2Id?.toString()) {
    // The losers-side finalist won game 1 — this is their first loss of the
    // set (they already had exactly one loss coming in), so the winners-side
    // finalist now also has one loss. Neither is eliminated yet: a bracket
    // reset (decider match) is required.
    const existingReset = await Match.findOne({ bracketId: match.bracketId, bracketSide: "GRAND_FINAL_RESET" });
    if (!existingReset) {
      await Match.create({
        tournamentId: match.tournamentId,
        bracketId: match.bracketId,
        bracketSide: "GRAND_FINAL_RESET",
        bracketRound: 2,
        bracketPosition: 0,
        player1Id: match.player1Id,
        player2Id: match.player2Id,
        round: "Grand Finals (Reset)",
        status: "PENDING",
      });
    }
    return; // not decided yet -- waiting on the reset match
  }

  // The bracket is fully decided once the Grand Final (no reset needed) or
  // the Grand Final Reset (decider) reaches COMPLETED.
  if (match.bracketSide === "GRAND_FINAL" || match.bracketSide === "GRAND_FINAL_RESET") {
    // Pool play + top-cut: a POOL's own Grand Final completing must NOT
    // touch tournament-wide Entrant.placement — computeAndApplyBracketPlacements
    // writes absolute placements (1st, 2nd, 3rd-4th, ...) that are only
    // meaningful within a single bracket's own entrant set. A pool is just a
    // subset of the tournament, so its internal standings aren't the
    // tournament's real placements once multiple pools exist (e.g. "3rd in
    // an 8-person pool" isn't "3rd overall" in a 40-entrant tournament).
    // Only the top-level bracket — a standard tournament's only bracket, or
    // a "Pools + Bracket" tournament's main/2nd-stage bracket — ever applies
    // placements automatically; see the Pool play Implementation Plan for
    // why entrants eliminated during pools don't get an automatic
    // placement (setPlacement remains available as a manual override).
    const bracket = await Bracket.findById(match.bracketId).select("poolId");
    if (!bracket?.poolId) {
      await computeAndApplyBracketPlacements(match.tournamentId, match.bracketId);
    }
  }
}

// ─── Automatic bracket placement ─────────────────────────────────────────
//
// Once the bracket is fully decided (Grand Final, or Grand Final Reset if
// one was played, reaches COMPLETED), placements are derivable entirely from
// existing bracket data:
//   1st = Grand Final (or Reset) winner
//   2nd = Grand Final (or Reset) loser
//   3rd = Losers Bracket Final loser
//   4th+ = grouped by which Losers-bracket round an entrant was eliminated
//     in, mapped onto the SAME coarse buckets the ranking system already
//     uses (3rd-4th, 5th-8th, 9th-16th — see lib/ranking.ts's
//     pointsForPlacement), not the finer-grained tie sizes a real
//     double-elimination bracket produces round-by-round. The ranking
//     table doesn't distinguish within a bucket anyway, so there's nothing
//     to gain from finer precision here.
//
// A manual override via setPlacement (Entrant.placementSetManually) is never
// overwritten by this function, even on a re-run (e.g. editMatchResult
// correcting the Grand Final result re-triggers this).
function placementForEliminationDepth(depth: number): number | null {
  if (depth === 0) return 3; // Losers Bracket Final loser
  if (depth === 1) return 5; // one Losers round earlier
  if (depth === 2) return 9; // two Losers rounds earlier
  return null; // deeper than that maps to the "no placement" 1-point floor
}

// Only ever called from advanceBracketMatch, and only once it has already
// determined the bracket is truly decided (see the isCorrection reasoning
// above) -- no "is this actually the reset-needed case" check is needed
// here, since that decision has already been made by the caller.
export async function computeAndApplyBracketPlacements(tournamentId: any, bracketId: any) {
  const matches = await Match.find({ bracketId });

  // Prefer the reset match if one was played -- it's the true decider.
  const terminal =
    matches.find(m => m.bracketSide === "GRAND_FINAL_RESET" && m.status === "COMPLETED") ??
    matches.find(m => m.bracketSide === "GRAND_FINAL" && m.status === "COMPLETED");
  if (!terminal || !terminal.winnerId) return; // bracket not decided yet

  const placementByPlayerId = new Map<string, number>();
  const winnerId = terminal.winnerId.toString();
  const loserId = (
    terminal.winnerId.toString() === terminal.player1Id.toString() ? terminal.player2Id : terminal.player1Id
  ).toString();
  placementByPlayerId.set(winnerId, 1);
  placementByPlayerId.set(loserId, 2);

  const loserSideMatches = matches.filter(m => m.bracketSide === "LOSERS" && m.status === "COMPLETED" && m.winnerId);
  const totalLBRounds = loserSideMatches.reduce((max, m) => Math.max(max, m.bracketRound), 0);

  for (const m of loserSideMatches) {
    const eliminationDepth = totalLBRounds - m.bracketRound; // 0 = last Losers round (Losers Finals)
    const placement = placementForEliminationDepth(eliminationDepth);
    if (placement === null) continue;
    const loser = (m.winnerId.toString() === m.player1Id.toString() ? m.player2Id : m.player1Id).toString();
    placementByPlayerId.set(loser, placement);
  }

  for (const [playerId, placement] of placementByPlayerId) {
    await Entrant.findOneAndUpdate(
      { tournamentId, playerId, placementSetManually: { $ne: true } },
      { placement }
    );
  }
}
