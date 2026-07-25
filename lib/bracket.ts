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
import { Player } from "@/models/Player";
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

export type Slot =
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

// ─── Pool format Model B: repooled bracket generator (Phase 1) ──────────
//
// Model B (massive-scale continuous double-elimination pools, reverse-
// engineered from real EVO Japan 2026 bracket data) regenerates a fresh,
// small double-elimination bracket every round from that round's survivors.
// Unlike buildDoubleEliminationBracket (ONE flat seed list, always starting
// at Winners Round 1), a repooled round has TWO separate input lists that
// enter at two different points:
//   - "Winners-survivors": the previous round's undefeated players. They
//     enter partway UP the Winners bracket (e.g. straight into the Winners
//     Semi-Final), skipping the rounds their pool already played out.
//   - "Losers-survivors": the previous round's Winners-Final losers AND
//     Losers-bracket champions, pooled together. They always enter at a
//     fresh Losers Round 1.
//
// This is NOT new bracket topology -- it reuses the exact same primitives
// (buildMatch/buildConsolidationRound/buildDropInRound, the same
// bracketSide/bracketRound/bracketPosition + nextMatchId/nextLoserMatchId
// graph) as buildDoubleEliminationBracket above. The only new idea is WHERE
// each input list is grafted in:
//   - Winners-survivors seed a Winners bracket sized to winnersEntrySize
//     (a power of two) instead of the full field -- so it's a short bracket
//     with round labels counted backward from Winners Finals (Semi-Final,
//     Quarter-Final, ...) rather than forward from Round 1.
//   - Losers-survivors seed a fresh Losers Round 1 consolidation round, same
//     as any Losers Round 1. But since the Winners-survivors bracket is
//     short, its first-round loser count is usually smaller than the
//     losers-survivors list -- so before the normal WB-loser-drop-in
//     alternation can start, the losers-survivors side consolidates itself
//     down (same consolidation primitive, just repeated) until its size
//     matches that first incoming WB-loser wave.
//
// Re-pooling/grouping logic between rounds, per-pool UI, and scale-testing
// are separate later phases -- this function only builds ONE round's fresh
// bracket from its two already-decided input lists.
export function buildRepooledBracket(params: {
  tournamentId: any;
  bracketId: Types.ObjectId;
  winnersSurvivorIds: string[]; // seed 1..W in order -- enter partway up the Winners bracket
  winnersEntrySize: number; // power-of-two slot count of the Winners round they enter (e.g. 4 = Winners Semi-Final); must be >= winnersSurvivorIds.length
  losersSurvivorIds: string[]; // seed 1..L in order -- enter at a fresh Losers Round 1
}): { matches: BracketMatchDraft[] } {
  const { tournamentId, bracketId, winnersSurvivorIds, winnersEntrySize, losersSurvivorIds } = params;

  if (winnersEntrySize < 2 || nextPowerOfTwo(winnersEntrySize) !== winnersEntrySize) {
    throw new Error("winnersEntrySize must be a power of two >= 2");
  }
  if (winnersSurvivorIds.length > winnersEntrySize) {
    throw new Error("winnersSurvivorIds does not fit within winnersEntrySize");
  }
  if (losersSurvivorIds.length < 1) {
    throw new Error("losersSurvivorIds must have at least 1 entrant");
  }

  const drafts: BracketMatchDraft[] = [];
  const wN = winnersSurvivorIds.length;
  const mW = Math.log2(winnersEntrySize); // number of Winners rounds in this fresh bracket

  // ── Winners bracket (starts partway up, not Round 1) ────────────────
  const seedToWinnersSlot = (seed: number): Slot =>
    seed <= wN ? { kind: "PLAYER", playerId: new Types.ObjectId(winnersSurvivorIds[seed - 1]) } : { kind: "BYE" };

  // Round labels count backward from Winners Finals, since this bracket
  // starts partway up a notional full Winners bracket rather than at Round 1.
  const winnersRoundLabel = (roundNum: number): string => {
    const roundsFromFinal = mW - roundNum;
    if (roundsFromFinal === 0) return "Winners Finals";
    if (roundsFromFinal === 1) return "Winners Semi-Final";
    if (roundsFromFinal === 2) return "Winners Quarter-Final";
    return `Winners Round ${roundNum}`;
  };

  let wbCurrent: Slot[] = seedSlotOrder(winnersEntrySize).map(seedToWinnersSlot);
  const wbLoserOutputsByRound: Slot[][] = [];
  for (let r = 1; r <= mW; r++) {
    const label = winnersRoundLabel(r);
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

  // ── Losers bracket (starts fresh at Losers Round 1) ─────────────────
  const lN = losersSurvivorIds.length;
  const lSize = nextPowerOfTwo(lN);
  const seedToLosersSlot = (seed: number): Slot =>
    seed <= lN ? { kind: "PLAYER", playerId: new Types.ObjectId(losersSurvivorIds[seed - 1]) } : { kind: "BYE" };

  let lbCurrent: Slot[] = seedSlotOrder(lSize).map(seedToLosersSlot);
  let roundNum = 1;
  lbCurrent = buildConsolidationRound(
    lbCurrent,
    { tournamentId, bracketId, side: "LOSERS", round: roundNum, label: "Losers Round 1" },
    drafts
  );
  roundNum++;

  // The losers-survivors pool is usually much bigger than the Winners
  // bracket's first-round loser count (it entered partway up, so its first
  // round produces relatively few losers). Keep consolidating the
  // losers-survivors side on its own -- same primitive as Losers Round 1
  // above, just repeated -- until its size catches down to match that first
  // incoming wave, so the normal drop-in alternation below can pair 1:1.
  while (lbCurrent.length > wbLoserOutputsByRound[0].length) {
    lbCurrent = buildConsolidationRound(
      lbCurrent,
      { tournamentId, bracketId, side: "LOSERS", round: roundNum, label: `Losers Round ${roundNum}` },
      drafts
    );
    roundNum++;
  }
  if (lbCurrent.length !== wbLoserOutputsByRound[0].length) {
    throw new Error(
      "losersSurvivorIds cannot be consolidated down to exactly match the Winners bracket's first loser wave"
    );
  }

  // Standard alternating drop-in/consolidation merge, identical in shape to
  // buildDoubleEliminationBracket's own Losers-bracket loop.
  for (let j = 0; j <= mW - 1; j++) {
    const isLastDropIn = j === mW - 1;
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
  const lbChampionSlot = lbCurrent[0];

  // ── Grand Final ───────────────────────────────────────────────────
  // Same convention as buildDoubleEliminationBracket: player1 = winners-side
  // finalist, player2 = losers-side finalist.
  buildMatch(
    wbChampionSlot,
    lbChampionSlot,
    { tournamentId, bracketId, side: "GRAND_FINAL", round: 1, position: 0, label: "Grand Finals" },
    drafts
  );

  return { matches: drafts };
}

// ─── Pool format Model B: round-to-round re-pooling orchestration (Phase 2) ─
//
// Takes one round's completed pools (each already reduced to its own
// survivors, in Phase 1's two categories) and produces the next round's
// pools -- deciding how many new pools to form, which survivors group into
// which one, and what winnersEntrySize each needs, then actually calling
// buildRepooledBracket per group. This is the FINAL validated algorithm from
// the Notion "Pool format Model B" writeup, stress-tested there across
// ~15,000 entrant counts with zero broken cases:
//   1. While pool_count > 8: merge 4:1 -- every 4 source pools' survivors
//      combine into 1 new pool, 3 advancers per source pool, unconditionally
//      (1 Winners-side champion + 2 Losers-side survivors).
//   2. Once pool_count <= 8: consolidate ALL remaining pools into exactly 1
//      pool, targeting a fixed ~24-entrant size (capped at this round's
//      actual entrant count if smaller) -- split as evenly as possible
//      across however many pools remain, which can mean MORE than 3
//      advancers per pool (e.g. 6/pool when only 4 pools remain -- confirmed
//      against a 2nd real EVO dataset, see the Notion writeup).
//   3. The Finals split is dynamic: this only reports whether the resulting
//      ~24-entrant pool should later split into a separate Top-8 Finals
//      stage (entrantCount >= 16) or stand as the tournament's own real
//      final as-is (< 16) -- see the FINALS SPLIT note below for why
//      actually generating that Finals bracket is a later phase's job.
//
// Deliberately NOT solved here (out of Phase 2's scope):
//   - How a completed pool's raw match results get reduced down to its
//     PoolSurvivors entry (winnersChampionId + a ranked losersSurvivorIds
//     list). That's real placement extraction against real Match documents
//     -- a later, DB-touching phase's job. This function trusts whatever
//     ranked candidate list each pool provides and trims it to however many
//     are actually needed for the current regrouping decision.
//   - FINALS SPLIT mechanics: the real EVO data shows the Finals split isn't
//     another buildRepooledBracket call at all -- the ~24-entrant pool's own
//     Winners/Losers sides are truncated part-way (e.g. "Winners
//     Quarter-Final: 8 in, 4 out, straight to Finals" instead of continuing
//     to that pool's own Winners Finals), and their qualifiers feed a
//     completely standard fresh Top-8 bracket. That's a genuinely different
//     bracket-generation primitive (an early-cutoff bracket) that neither
//     buildRepooledBracket nor buildDoubleEliminationBracket support yet, so
//     this function only reports the splitsIntoFinals decision -- the part
//     Phase 2's scope actually asks for -- and leaves generating that
//     truncated bracket to a later phase.
export const REPOOL_FINAL_TARGET_SIZE = 24;
export const REPOOL_FINALS_SPLIT_THRESHOLD = 16;

export interface PoolSurvivors {
  entrantCount: number; // total entrants who competed in this pool this round -- only consulted once pool_count <= 8, for the ~24 cap
  winnersChampionId: string; // this pool's undefeated Grand-Final winner -- enters the new pool's Winners bracket partway up
  losersSurvivorIds: string[]; // ranked candidate list of this pool's other advancers (Winners-Final loser first, then Losers-bracket champion, then further placements if a later round needs more than 2) -- enters the new pool's Losers Round 1
}

export interface RepooledNewPool {
  bracketId: Types.ObjectId;
  matches: BracketMatchDraft[];
  winnersEntrySize: number;
  entrantCount: number;
  sourcePoolCount: number;
  // The exact real (or, pre-Phase-5, synthetic-placeholder) survivor IDs
  // this pool was built from -- i.e. buildRepooledBracket's own
  // winnersSurvivorIds/losersSurvivorIds inputs, already trimmed to whatever
  // this round actually used. Exposed so a caller (generateModelBTournament's
  // FINAL_CONSOLIDATION branch, or Phase 5's real-DB advancement) can reuse
  // them directly -- e.g. to route a splits-into-Finals pool through
  // buildFinalsCutoffBracket instead, or to know exactly which real players
  // belong in this new Pool document -- without re-deriving the same
  // distributeEvenly/takeExactly grouping a second time.
  winnersSurvivorIds: string[];
  losersSurvivorIds: string[];
}

export type RepoolStage = "MERGE" | "FINAL_CONSOLIDATION";

export interface RepoolRoundResult {
  stage: RepoolStage;
  newPools: RepooledNewPool[];
  // Only present once stage === "FINAL_CONSOLIDATION" -- see the FINALS
  // SPLIT note above for why generating that stage is deferred.
  splitsIntoFinals?: boolean;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

// Splits `total` as evenly as possible across `buckets` buckets -- any
// remainder goes one-at-a-time to the first few buckets, so the returned
// counts always sum to exactly `total`.
function distributeEvenly(total: number, buckets: number): number[] {
  const base = Math.floor(total / buckets);
  const remainder = total - base * buckets;
  return Array.from({ length: buckets }, (_, i) => base + (i < remainder ? 1 : 0));
}

function takeExactly(ids: string[], count: number, context: string): string[] {
  if (ids.length < count) {
    throw new Error(`Not enough losers-survivor candidates for ${context} -- need ${count}, got ${ids.length}`);
  }
  return ids.slice(0, count);
}

function buildNewPoolFromGroup(tournamentId: any, group: PoolSurvivors[]): RepooledNewPool {
  const winnersSurvivorIds = group.map(p => p.winnersChampionId);
  const losersSurvivorIds = group.flatMap(p => p.losersSurvivorIds);
  const winnersEntrySize = Math.max(2, nextPowerOfTwo(winnersSurvivorIds.length));
  const bracketId = new Types.ObjectId();

  const { matches } = buildRepooledBracket({
    tournamentId,
    bracketId,
    winnersSurvivorIds,
    winnersEntrySize,
    losersSurvivorIds,
  });

  return {
    bracketId,
    matches,
    winnersEntrySize,
    entrantCount: winnersSurvivorIds.length + losersSurvivorIds.length,
    sourcePoolCount: group.length,
    winnersSurvivorIds,
    losersSurvivorIds,
  };
}

export function computeNextRepooledRound(params: {
  tournamentId: any;
  pools: PoolSurvivors[]; // this round's completed pools
}): RepoolRoundResult {
  const { tournamentId, pools } = params;
  const poolCount = pools.length;
  if (poolCount < 2) {
    throw new Error("computeNextRepooledRound requires at least 2 completed pools to regroup");
  }

  if (poolCount > 8) {
    // Stage 1: merge 4:1, always exactly 2 losers-survivors per pool.
    const groups = chunkArray(pools, 4).map(group =>
      group.map(p => ({ ...p, losersSurvivorIds: takeExactly(p.losersSurvivorIds, 2, "the merge-4:1 stage's fixed 2 losers-survivors per pool") }))
    );
    const newPools = groups.map(group => buildNewPoolFromGroup(tournamentId, group));
    return { stage: "MERGE", newPools };
  }

  // Stage 2: consolidate ALL remaining pools into exactly 1 pool, targeting
  // ~24 entrants (capped at this round's actual entrant count if smaller),
  // split as evenly as possible across however many pools remain.
  const totalEntrantsThisRound = pools.reduce((sum, p) => sum + p.entrantCount, 0);
  const target = Math.min(REPOOL_FINAL_TARGET_SIZE, totalEntrantsThisRound);
  const advancersPerPool = distributeEvenly(target, poolCount);

  const trimmedGroup = pools.map((p, i) => {
    const losersCount = advancersPerPool[i] - 1; // 1 slot always reserved for the winners-champion
    if (losersCount < 1) {
      throw new Error(`Pool ${i} would only get ${advancersPerPool[i]} advancer(s) at the final consolidation stage -- need at least 1 winners-survivor + 1 losers-survivor`);
    }
    return { ...p, losersSurvivorIds: takeExactly(p.losersSurvivorIds, losersCount, `the final consolidation stage's computed ${losersCount} losers-survivors for pool ${i}`) };
  });

  const newPool = buildNewPoolFromGroup(tournamentId, trimmedGroup);
  return {
    stage: "FINAL_CONSOLIDATION",
    newPools: [newPool],
    splitsIntoFinals: newPool.entrantCount >= REPOOL_FINALS_SPLIT_THRESHOLD,
  };
}

// ─── Pool format Model B: Finals-cutoff bracket (Phase 2.5) ─────────────
//
// Fills the gap Phase 2 explicitly left open: when computeNextRepooledRound
// reports splitsIntoFinals === true, the final ~24-entrant consolidated pool
// doesn't play out to its own Grand Final -- per the one confirmed real EVO
// data point (a 24-entrant Semifinals-phase pool), its Winners side plays
// exactly ONE round ("Winners Quarter-Final": 8 entrants in, 4 winners out)
// and then STOPS, and its Losers side plays exactly THREE rounds (R1->R2->R3)
// and also stops -- both sides' final-round winners (4 + 4 = 8) go straight
// to a completely separate, standard Top-8 bracket instead of continuing to
// this pool's own Winners/Losers Finals. That separate bracket is itself
// nothing new -- existing buildDoubleEliminationBracket already handles a
// flat 8-entrant double-elim fine, once fed real playerIds (Phase 3's job,
// once these cutoff rounds have real results). This function only builds
// the TRUNCATED early rounds and produces the 8 finalist slots to feed it.
//
// ── Deriving the general rule from the one confirmed data point ──────────
// FINALS_SIZE is fixed at 8 (the settled design's Top-8 cutoff). Call
// FINALS_HALF = FINALS_SIZE / 2 = 4 -- how many qualifiers EACH side
// contributes in the confirmed case (4 Winners + 4 Losers = 8).
//
// Winners side: winnersEntrySize entrants, halving every round played.
// Reaching exactly FINALS_HALF survivors takes
//   winnersRounds = log2(winnersEntrySize / FINALS_HALF)
// rounds (both are powers of two whenever winnersEntrySize >= FINALS_HALF,
// so this is always a clean non-negative integer). For the confirmed case,
// winnersEntrySize = 8 -> winnersRounds = log2(8/4) = 1, landing on the
// label "Winners Quarter-Final" -- which falls out for free by reusing
// buildRepooledBracket's OWN round-counted-backward-from-Finals labeling
// (computed from the bracket's full notional round count
// mW = log2(winnersEntrySize), not from winnersRounds): round 1 of an
// 8-entrant bracket is 2 rounds before its own (never-played) Finals, i.e.
// "Winners Quarter-Final" -- exactly matching the real label, not a guess.
//
// Losers side: the SAME pre-consolidation + alternating drop-in/
// consolidation shape buildRepooledBracket already uses, just stopped after
// merging exactly `winnersRounds` waves of Winners-bracket losers (one wave
// per Winners round actually played) instead of continuing to a real Losers
// Finals. Reusing that same machinery and stopping at the right wave count
// is provably self-consistent: each wave's size is winnersEntrySize / 2^k,
// so the LAST wave (k = winnersRounds - 1) has exactly
// winnersEntrySize / 2^winnersRounds = FINALS_HALF entrants -- and since a
// drop-in round's output length always equals its input length, the Losers
// side lands on exactly FINALS_HALF survivors too, automatically, with no
// separate uneven-trim step needed. For the confirmed case this works out
// to pre-consolidating losersSurvivorIds (16) down to the first wave's size
// (4, taking 2 rounds: 16->8->4) plus 1 drop-in round merging that wave =
// 3 total Losers rounds -- exactly matching the real "R1->R2->R3" data.
//
// ── Where this is a confirmed-generalization vs. a genuine extrapolation ──
// The above is a clean, principled generalization for any winnersEntrySize
// >= FINALS_HALF (4) -- it reduces to the exact confirmed shape at
// winnersEntrySize = 8, and the same halving logic holds for any other
// power-of-two winnersEntrySize >= 4 (verified in this file's test script
// with winnersEntrySize = 16, a size Phase 2 doesn't currently produce but
// which this function should still handle correctly since it's a function
// of entrant count, not hardcoded to 24).
//
// FLAGGED EXTRAPOLATION GAP: when winnersEntrySize < FINALS_HALF (only
// possible in practice when Phase 2's final consolidation merges just 2
// source pools, giving winnersEntrySize = 2), FINALS_SIZE's fixed 8 can't
// be split evenly through pure power-of-two halving on both sides (the
// Losers side would need to land on a non-power-of-two 6 survivors, which
// this bracket-halving approach can never produce). There's no real data
// point covering this case, and inventing an uneven-trim rule with zero
// grounding felt worse than being explicit about the gap -- so this
// function throws a clear, documented error there instead of guessing.
export const FINALS_SIZE = 8;
const FINALS_HALF = FINALS_SIZE / 2;

export interface FinalsCutoffResult {
  matches: BracketMatchDraft[]; // the played early-cutoff rounds only -- no Grand Final, no Losers Finals; this pool's story ends here
  winnersRoundsPlayed: number;
  losersRoundsPlayed: number;
  // Exactly FINALS_SIZE (8) entries, Winners-side qualifiers first then
  // Losers-side, in seed order. Each is either an already-known PLAYER (a
  // bye advanced them with no match) or a PENDING reference to one of
  // `matches`' winners -- feed these (as real playerIds, once each match's
  // result is known) into buildDoubleEliminationBracket for the actual
  // Finals bracket. Wiring that up is left to a later phase.
  finalistSlots: Slot[];
}

export function buildFinalsCutoffBracket(params: {
  tournamentId: any;
  bracketId: Types.ObjectId;
  winnersSurvivorIds: string[];
  winnersEntrySize: number;
  losersSurvivorIds: string[];
}): FinalsCutoffResult {
  const { tournamentId, bracketId, winnersSurvivorIds, winnersEntrySize, losersSurvivorIds } = params;

  if (winnersEntrySize < 2 || nextPowerOfTwo(winnersEntrySize) !== winnersEntrySize) {
    throw new Error("winnersEntrySize must be a power of two >= 2");
  }
  if (winnersSurvivorIds.length > winnersEntrySize) {
    throw new Error("winnersSurvivorIds does not fit within winnersEntrySize");
  }
  if (losersSurvivorIds.length < 1) {
    throw new Error("losersSurvivorIds must have at least 1 entrant");
  }
  if (winnersEntrySize < FINALS_HALF) {
    throw new Error(
      `buildFinalsCutoffBracket doesn't support winnersEntrySize (${winnersEntrySize}) below ${FINALS_HALF} -- ` +
        `this is a genuine extrapolation gap beyond the one confirmed real EVO data point (see the comment above ` +
        `this function). Splitting FINALS_SIZE (${FINALS_SIZE}) unevenly between the two sides can't be reached ` +
        `through pure power-of-two bracket halving, and there's no real data to derive a principled uneven-trim ` +
        `rule from. Only reachable in practice when Model B's final consolidation merges just 2 source pools.`
    );
  }

  const drafts: BracketMatchDraft[] = [];
  const winnersRounds = Math.log2(winnersEntrySize / FINALS_HALF);
  const mW = Math.log2(winnersEntrySize); // this bracket's full notional round count, purely for label continuity with buildRepooledBracket -- Winners Finals (round mW) is never actually played here

  // ── Winners side: play exactly `winnersRounds` rounds, then stop ────
  const seedToWinnersSlot = (seed: number): Slot =>
    seed <= winnersSurvivorIds.length ? { kind: "PLAYER", playerId: new Types.ObjectId(winnersSurvivorIds[seed - 1]) } : { kind: "BYE" };

  const fullWinnersRoundLabel = (roundNum: number): string => {
    const roundsFromFinal = mW - roundNum;
    if (roundsFromFinal === 0) return "Winners Finals"; // never actually reached when winnersRounds < mW
    if (roundsFromFinal === 1) return "Winners Semi-Final";
    if (roundsFromFinal === 2) return "Winners Quarter-Final";
    return `Winners Round ${roundNum}`;
  };

  let wbCurrent: Slot[] = seedSlotOrder(winnersEntrySize).map(seedToWinnersSlot);
  const wbLoserOutputsByRound: Slot[][] = [];
  for (let r = 1; r <= winnersRounds; r++) {
    const label = fullWinnersRoundLabel(r);
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
  const winnersFinalistSlots = wbCurrent; // length === FINALS_HALF by construction -- these go straight to Finals, no internal Winners Finals here

  // ── Losers side: pre-consolidate, then merge exactly `winnersRounds`
  // waves, stopping right after the last one instead of continuing ────
  const lN = losersSurvivorIds.length;
  const lSize = nextPowerOfTwo(lN);
  const seedToLosersSlot = (seed: number): Slot =>
    seed <= lN ? { kind: "PLAYER", playerId: new Types.ObjectId(losersSurvivorIds[seed - 1]) } : { kind: "BYE" };

  let lbCurrent: Slot[] = seedSlotOrder(lSize).map(seedToLosersSlot);
  let roundNum = 1;
  let losersFinalistSlots: Slot[];

  if (winnersRounds === 0) {
    // winnersEntrySize already == FINALS_HALF -- no Winners rounds played,
    // so there's no Winners-loser wave to merge in. Pure self-consolidation
    // down to the remaining Finals slots.
    const losersQualifierCount = FINALS_SIZE - FINALS_HALF; // == FINALS_HALF
    while (lbCurrent.length > losersQualifierCount) {
      lbCurrent = buildConsolidationRound(
        lbCurrent,
        { tournamentId, bracketId, side: "LOSERS", round: roundNum, label: `Losers Round ${roundNum}` },
        drafts
      );
      roundNum++;
    }
    if (lbCurrent.length !== losersQualifierCount) {
      throw new Error(`losersSurvivorIds cannot be consolidated down to exactly the ${losersQualifierCount} Finals slots this pool needs`);
    }
    losersFinalistSlots = lbCurrent;
  } else {
    while (lbCurrent.length > wbLoserOutputsByRound[0].length) {
      lbCurrent = buildConsolidationRound(
        lbCurrent,
        { tournamentId, bracketId, side: "LOSERS", round: roundNum, label: `Losers Round ${roundNum}` },
        drafts
      );
      roundNum++;
    }
    if (lbCurrent.length !== wbLoserOutputsByRound[0].length) {
      throw new Error("losersSurvivorIds cannot be consolidated down to exactly match the Winners bracket's first loser wave");
    }

    for (let j = 0; j < winnersRounds; j++) {
      const isLastWave = j === winnersRounds - 1;
      lbCurrent = buildDropInRound(
        lbCurrent,
        wbLoserOutputsByRound[j],
        { tournamentId, bracketId, side: "LOSERS", round: roundNum, label: `Losers Round ${roundNum}` },
        drafts
      );
      roundNum++;
      if (!isLastWave) {
        lbCurrent = buildConsolidationRound(
          lbCurrent,
          { tournamentId, bracketId, side: "LOSERS", round: roundNum, label: `Losers Round ${roundNum}` },
          drafts
        );
        roundNum++;
      }
    }
    losersFinalistSlots = lbCurrent;
  }

  const finalistSlots = [...winnersFinalistSlots, ...losersFinalistSlots];
  if (finalistSlots.length !== FINALS_SIZE) {
    throw new Error(`Internal error: produced ${finalistSlots.length} finalist slots, expected exactly ${FINALS_SIZE}`);
  }

  return {
    matches: drafts,
    winnersRoundsPlayed: winnersRounds,
    losersRoundsPlayed: roundNum - 1,
    finalistSlots,
  };
}

// ─── Pool format Model B: full tournament orchestration (Phase 3) ───────
//
// Runs the ENTIRE Model B pipeline end-to-end, in memory, from a flat list
// of a real tournament's registered entrants all the way down to the real
// Top-8 Finals bracket -- no DB access, same as every function above it in
// this file. It exists to prove the whole pipeline's plumbing is correct at
// real scale (round sizes, hand-offs between stages) before any of it is
// wired into a resolver.
//
// ── Why every survivor past Round 1 is a synthetic placeholder ID ─────────
// No match has actually been played yet -- this function builds the SHAPE
// of every round's brackets before a single result exists, so which real
// player advances out of any given pool genuinely isn't knowable here. Each
// pool always contributes a fixed count of advancers (1 winners-champion +
// however many losers-survivors that round's rule calls for -- see
// computeNextRepooledRound above), so this function generates that many
// fresh placeholder IDs per pool and threads THOSE through
// computeNextRepooledRound, checking that the right NUMBER of survivors
// flow correctly from one round's output into the next round's input at
// every scale. Resolving these placeholders into real playerIds, one round
// at a time as real results actually come in, is Phase 4's job -- exactly
// the same real-vs-placeholder split Phase 2's own doc comment already
// draws for computeNextRepooledRound itself.
//
// ── Why the final consolidated pool is rebuilt instead of reused ──────────
// computeNextRepooledRound's FINAL_CONSOLIDATION stage always builds a full
// bracket (via buildRepooledBracket) all the way to its own Grand Final --
// correct when splitsIntoFinals is false (that Grand Final IS the real
// final), but wrong when it's true, since the real EVO data shows that pool
// never actually plays out that far: its Winners/Losers sides cut off early
// (buildFinalsCutoffBracket) and hand 8 qualifiers to a separate standard
// bracket instead. So when splitsIntoFinals is true, this function discards
// that full bracket and rebuilds the exact same survivor group -- same
// REPOOL_FINAL_TARGET_SIZE constant, same distributeEvenly/takeExactly
// helpers computeNextRepooledRound itself uses internally -- routed through
// buildFinalsCutoffBracket instead.
//
// Minimum entrant guard: below MODEL_B_MIN_ENTRANTS, Model B's own math
// collapses to a single consolidation round no matter what (see the Notion
// "Pool format Model B" writeup's simulation results) -- no different from
// Model C's simpler "one pool round -> fresh bracket" flow, so Model B's
// extra complexity buys nothing there. Model C already handles that range.
export const MODEL_B_MIN_ENTRANTS = 128;
const MODEL_B_TARGET_ENTRANTS_PER_POOL = 15;

// Initial pool count for Model B's Round 1 -- a power of two targeting ~15
// entrants/pool. Exported so Phase 4's DB-writing resolver can compute the
// exact same Round 1 shape this function does, without duplicating the
// formula.
export function computeModelBInitialPoolCount(entrantCount: number): number {
  return nextPowerOfTwo(Math.max(1, Math.round(entrantCount / MODEL_B_TARGET_ENTRANTS_PER_POOL)));
}

// Generous surplus so a synthesized pool's placeholder losers-survivors
// list is always long enough for whatever the NEXT computeNextRepooledRound
// call actually needs from it -- exactly 2 for an ordinary merge round, or
// up to distributeEvenly(REPOOL_FINAL_TARGET_SIZE, poolCount) - 1 for the
// final consolidation round. takeExactly only ever trims a surplus down, so
// sizing this at REPOOL_FINAL_TARGET_SIZE itself is always more than any
// round could ever need per pool.
const SYNTHETIC_LOSERS_SURPLUS = REPOOL_FINAL_TARGET_SIZE;

function syntheticPoolSurvivors(entrantCount: number): PoolSurvivors {
  return {
    entrantCount,
    winnersChampionId: new Types.ObjectId().toString(),
    losersSurvivorIds: Array.from({ length: SYNTHETIC_LOSERS_SURPLUS }, () => new Types.ObjectId().toString()),
  };
}

export interface ModelBRoundPool {
  bracketId: Types.ObjectId;
  matches: BracketMatchDraft[];
  entrantCount: number;
  winnersEntrySize?: number; // absent for Round 1's standard flat pools
  sourcePoolCount?: number; // absent for Round 1's standard flat pools
}

export type ModelBRoundStage = "INITIAL" | RepoolStage;

export interface ModelBRound {
  roundNumber: number;
  label: string;
  stage: ModelBRoundStage;
  pools: ModelBRoundPool[];
}

export interface ModelBTournamentResult {
  entrantCount: number;
  initialPoolCount: number;
  rounds: ModelBRound[]; // every pool/round generated, Round 1 through the final consolidated pool
  splitsIntoFinals: boolean;
  // Only present when splitsIntoFinals is true -- otherwise the last
  // `rounds` entry's own Grand Final already IS the tournament's real final.
  finalsCutoff?: FinalsCutoffResult;
  finalsBracketId?: Types.ObjectId;
  finalsMatches?: BracketMatchDraft[];
}

export function generateModelBTournament(params: {
  tournamentId: any;
  entrantPlayerIds: string[]; // a real tournament's full flat list of registered entrants
}): ModelBTournamentResult {
  const { tournamentId, entrantPlayerIds } = params;
  const entrantCount = entrantPlayerIds.length;

  if (entrantCount < MODEL_B_MIN_ENTRANTS) {
    throw new Error(
      `Model B needs at least ${MODEL_B_MIN_ENTRANTS} entrants (got ${entrantCount}) -- below that it collapses ` +
        `to behavior equivalent to Model C's simpler pooling flow. Use Model C for smaller fields.`
    );
  }

  // ── Round 1: standard flat pools -- same shape Model A/C's own
  // generatePools already produces for a single pool, just applied
  // tournament-wide. Shuffle every real entrant, split evenly across a
  // power-of-two pool count targeting ~15 entrants/pool, and build each
  // pool as its own ordinary double-elimination bracket. ──
  const initialPoolCount = computeModelBInitialPoolCount(entrantCount);
  const shuffledEntrants = shuffle([...entrantPlayerIds]);
  const poolGroups: string[][] = Array.from({ length: initialPoolCount }, () => []);
  shuffledEntrants.forEach((id, i) => poolGroups[i % initialPoolCount].push(id));

  const initialPools: ModelBRoundPool[] = poolGroups
    .filter(group => group.length > 0)
    .map(group => {
      const bracketId = new Types.ObjectId();
      const { matches } = buildDoubleEliminationBracket({ tournamentId, bracketId, orderedPlayerIds: group });
      return { bracketId, matches, entrantCount: group.length };
    });

  const rounds: ModelBRound[] = [{ roundNumber: 1, label: "Round 1", stage: "INITIAL", pools: initialPools }];

  // ── Rounds 2+: regroup survivors round by round via
  // computeNextRepooledRound until it reports the final ~24-entrant
  // consolidated pool (see the placeholder-ID reasoning above). ──
  let currentPools: PoolSurvivors[] = initialPools.map(p => syntheticPoolSurvivors(p.entrantCount));
  let roundNumber = 2;
  let result: RepoolRoundResult;

  while (true) {
    result = computeNextRepooledRound({ tournamentId, pools: currentPools });
    if (result.stage === "FINAL_CONSOLIDATION") break;

    rounds.push({
      roundNumber,
      label: `Round ${roundNumber}`,
      stage: result.stage,
      pools: result.newPools.map(np => ({
        bracketId: np.bracketId,
        matches: np.matches,
        entrantCount: np.entrantCount,
        winnersEntrySize: np.winnersEntrySize,
        sourcePoolCount: np.sourcePoolCount,
      })),
    });
    currentPools = result.newPools.map(np => syntheticPoolSurvivors(np.entrantCount));
    roundNumber++;
  }

  const finalPool = result.newPools[0];
  const splitsIntoFinals = result.splitsIntoFinals === true;

  if (!splitsIntoFinals) {
    // The consolidated pool is small enough that its OWN Grand Final simply
    // IS the tournament's real final -- no separate Finals bracket needed.
    rounds.push({
      roundNumber,
      label: "Finals",
      stage: "FINAL_CONSOLIDATION",
      pools: [{
        bracketId: finalPool.bracketId,
        matches: finalPool.matches,
        entrantCount: finalPool.entrantCount,
        winnersEntrySize: finalPool.winnersEntrySize,
        sourcePoolCount: finalPool.sourcePoolCount,
      }],
    });
    return { entrantCount, initialPoolCount, rounds, splitsIntoFinals: false };
  }

  // ── Finals split: reuse the exact same survivor group finalPool was
  // already built from (RepooledNewPool now exposes it directly) and route
  // it through the cutoff primitive instead of the full bracket already
  // discarded above -- see this function's own doc comment for why. ──
  const { winnersSurvivorIds, losersSurvivorIds, winnersEntrySize } = finalPool;

  const semifinalsBracketId = new Types.ObjectId();
  const finalsCutoff = buildFinalsCutoffBracket({
    tournamentId,
    bracketId: semifinalsBracketId,
    winnersSurvivorIds,
    winnersEntrySize,
    losersSurvivorIds,
  });

  rounds.push({
    roundNumber,
    label: "Semifinals",
    stage: "FINAL_CONSOLIDATION",
    pools: [{
      bracketId: semifinalsBracketId,
      matches: finalsCutoff.matches,
      entrantCount: winnersSurvivorIds.length + losersSurvivorIds.length,
      winnersEntrySize,
      sourcePoolCount: finalPool.sourcePoolCount,
    }],
  });

  // ── Finals: the 8 finalist slots feed a completely standard fresh
  // double-elimination bracket -- same generator every non-pool tournament
  // and every Model A/C pool already uses. Same placeholder-ID reasoning as
  // every round above: a PENDING slot's real occupant isn't knowable
  // without an actual played result. seedSlotOrder's own no-double-bye
  // guarantee (see its comment above) means a finalist slot here can never
  // itself be a bye for a real Model B field. ──
  const finalistPlayerIds = finalsCutoff.finalistSlots.map(slot => {
    if (slot.kind === "PLAYER") return slot.playerId.toString();
    if (slot.kind === "PENDING") return new Types.ObjectId().toString();
    throw new Error("Internal error: a Model B Finals-cutoff finalist slot was an unresolved bye");
  });

  const finalsBracketId = new Types.ObjectId();
  const { matches: finalsMatches } = buildDoubleEliminationBracket({
    tournamentId,
    bracketId: finalsBracketId,
    orderedPlayerIds: finalistPlayerIds,
  });

  return {
    entrantCount,
    initialPoolCount,
    rounds,
    splitsIntoFinals: true,
    finalsCutoff,
    finalsBracketId,
    finalsMatches,
  };
}

// ─── Pool format Model B: real-result survivor extraction (Phase 5) ─────
//
// generateModelBTournament (Phase 3) had to invent synthetic placeholder IDs
// for every round past Round 1, since no match had actually been played.
// Phase 5 is the opposite: a real Model B round's pools HAVE really been
// played, so this reads their REAL results and produces the same
// PoolSurvivors shape computeNextRepooledRound already expects -- reusing
// the exact bracket-result-reading approach computeAndApplyBracketPlacements
// above already established (read the decided Grand Final/Reset, walk the
// Losers side by elimination depth), just returning an ORDERED per-player
// list instead of tier-bucketed placements.
//
// Per the settled real EVO mechanic (see buildRepooledBracket's own doc
// comment), all 3 roles are derived purely from bracket STRUCTURE, never
// from the Grand Final's own outcome:
//   - winnersChampionId = this pool's Winners-side finalist (0 losses
//     entering the Grand Final) = the Grand Final's player1Id, by
//     buildDoubleEliminationBracket/buildRepooledBracket's own documented
//     convention. This is well-defined and stable regardless of whether
//     they go on to win, lose, or need a reset in the Grand Final itself --
//     "undefeated" specifically means undefeated THROUGH THE WINNERS
//     BRACKET, a fact settled the moment the pool's own Winners Finals match
//     completes, not the moment the whole pool is decided.
//   - losersSurvivorIds[0] = this pool's Winners-Final LOSER (their
//     first-ever loss) -- the loser of whichever WINNERS-side match fed the
//     Grand Final (found via nextMatchId, not by round-counting, so it works
//     regardless of bracket depth).
//   - losersSurvivorIds[1] = this pool's Losers-bracket champion = the Grand
//     Final's player2Id, same convention as above.
//   - losersSurvivorIds[2+] = further real placements, ranked by Losers-
//     bracket elimination depth (deepest/best first, same depth grouping
//     computeAndApplyBracketPlacements uses) -- only ever consulted by
//     computeNextRepooledRound's FINAL_CONSOLIDATION stage, which can need
//     more than 2 losers-survivors per pool; an ordinary MERGE-stage round
//     never looks past index 1.
//
// Assumes the pool's bracket has strictly more than 2 entrants (guaranteed
// by Model B's own sizing at every stage -- see generateModelBTournament's
// MODEL_B_MIN_ENTRANTS/computeModelBInitialPoolCount) -- with exactly 2, the
// Winners-Final loser and Losers-bracket champion collapse into the same
// person (buildDoubleEliminationBracket's own m===1 special case, no real
// Losers bracket at all), which this function doesn't special-case.
export async function extractPoolSurvivors(bracket: { _id: any }): Promise<Pick<PoolSurvivors, "winnersChampionId" | "losersSurvivorIds">> {
  const matches = await Match.find({ bracketId: bracket._id });

  const grandFinal = matches.find(m => m.bracketSide === "GRAND_FINAL");
  if (!grandFinal?.player1Id || !grandFinal?.player2Id) {
    throw new Error("Can't extract survivors -- this pool's bracket has no decided Grand Final yet");
  }
  const winnersChampionId = grandFinal.player1Id.toString();
  const lbChampionId = grandFinal.player2Id.toString();

  const wbFinalsMatch = matches.find(m => m.bracketSide === "WINNERS" && m.nextMatchId?.toString() === grandFinal._id.toString());
  if (!wbFinalsMatch?.winnerId) {
    throw new Error("Can't extract survivors -- this pool's Winners Finals match has no recorded winner");
  }
  const wbFinalsLoserId = (
    wbFinalsMatch.winnerId.toString() === wbFinalsMatch.player1Id.toString() ? wbFinalsMatch.player2Id : wbFinalsMatch.player1Id
  ).toString();

  const loserSideMatches = matches.filter(m => m.bracketSide === "LOSERS" && m.status === "COMPLETED" && m.winnerId);
  const totalLBRounds = loserSideMatches.reduce((max, m) => Math.max(max, m.bracketRound), 0);
  const rankedFurtherLosers = [...loserSideMatches]
    .sort((a, b) => {
      const depthA = totalLBRounds - a.bracketRound;
      const depthB = totalLBRounds - b.bracketRound;
      return depthA !== depthB ? depthA - depthB : a.bracketPosition - b.bracketPosition;
    })
    .map(m => (m.winnerId.toString() === m.player1Id.toString() ? m.player2Id : m.player1Id).toString());

  // The Winners-Final loser drops into THIS pool's own Losers bracket like
  // anyone else, so they can perfectly normally go on to win it (a very
  // common real double-elim outcome) -- making them BOTH the
  // Winners-Final-loser AND the Losers-bracket champion. Deduped, keeping
  // wbFinalsLoserId's higher-priority position (matches the documented
  // "Winners-Final loser first" rank), so the next real distinct person
  // (already present somewhere in rankedFurtherLosers, since it covers
  // every real elimination in this pool) naturally backfills instead of a
  // duplicate identity ever reaching the next round's bracket twice.
  const seen = new Set<string>();
  const losersSurvivorIds = [wbFinalsLoserId, lbChampionId, ...rankedFurtherLosers].filter(id => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  return { winnersChampionId, losersSurvivorIds };
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

// ─── Individual bracket match deletion, with cascade-reset ──────────────
//
// Deleting a single bracket match (rather than the whole bracket, via
// deleteBracket/deleteMainBracket/deletePools) has to undo everything that
// match's result caused, transitively: whichever downstream match(es) it
// fed (nextMatchId for the winner, nextLoserMatchId for the loser) may
// themselves have already been played using that now-invalid player, whose
// own downstream may have been played too — however many rounds deep that
// goes — and if any of that chain reached a Grand Final/Grand Final Reset,
// it may have triggered computeAndApplyBracketPlacements above. All of that
// has to unwind, without ever touching a manually-set placement
// (Entrant.placementSetManually) — same scoping (bracket.seedOrder,
// non-pool brackets only) and the same respect for manual overrides as
// deleteMainBracket's own placement-reset precedent.
//
// A deleted match's own position is simply left empty afterward — the
// renderer already has to handle a round position with no Match document
// (a bye never gets one either; see BracketView.tsx's getRoundPositionCounts),
// so this doesn't need any new rendering support.

// Reverses one COMPLETED match's win/loss stat effects and, if it was a
// Grand Final or Grand Final Reset, un-applies whatever automatic placement
// it triggered. No-ops for a match that was never actually decided (and, by
// extension, for a freeform pre-bracket-era match with no bracketSide at
// all — the placement branch below just never matches).
async function undoMatchEffects(match: any) {
  if (match.status !== "COMPLETED" || !match.winnerId) return;

  const loserId = match.winnerId.toString() === match.player1Id.toString() ? match.player2Id : match.player1Id;
  await Player.findByIdAndUpdate(match.winnerId, { $inc: { wins: -1 } });
  await Player.findByIdAndUpdate(loserId, { $inc: { losses: -1 } });

  if (match.bracketSide === "GRAND_FINAL" || match.bracketSide === "GRAND_FINAL_RESET") {
    const bracket = await Bracket.findById(match.bracketId).select("poolId seedOrder");
    // Same gate advanceBracketMatch itself uses -- a pool's own bracket
    // never applies placements automatically, so there's never anything to
    // undo here for one.
    if (bracket && !bracket.poolId) {
      await Entrant.updateMany(
        { tournamentId: match.tournamentId, playerId: { $in: bracket.seedOrder }, placementSetManually: { $ne: true } },
        { placement: null }
      );
    }
  }
}

// A completed Grand Final can spawn a Grand Final Reset (see
// advanceBracketMatch above) -- that match is never wired into any other
// match's nextMatchId chain, so it has to be cleaned up as a special case
// whenever the Grand Final it depends on is deleted or cascade-invalidated.
// Reverses its own effects first if it had already been played.
async function removeGrandFinalReset(bracketId: any) {
  const reset = await Match.findOne({ bracketId, bracketSide: "GRAND_FINAL_RESET" });
  if (!reset) return;
  await undoMatchEffects(reset);
  await Match.findByIdAndDelete(reset._id);
}

// Recursively invalidates one player slot on a downstream match reached via
// an upstream deletion/reset. If that match had already been played using
// the now-invalid player, its own result is undone (stats, placement) and
// the exact same treatment cascades into whatever ITS winner/loser had
// already advanced to. If it hadn't been played yet, clearing the slot is
// all there is to do -- the recursion simply stops.
async function cascadeResetSlot(matchId: any, slotField: "player1Id" | "player2Id") {
  const match = await Match.findById(matchId);
  if (!match) return; // a dangling pointer here isn't fatal, just nothing to do

  const wasDecided = match.status === "COMPLETED" && !!match.winnerId;

  if (wasDecided) {
    await undoMatchEffects(match);

    if (match.nextMatchId) {
      const field = match.nextMatchSlot === 1 ? "player1Id" : "player2Id";
      await cascadeResetSlot(match.nextMatchId, field);
    }
    if (match.nextLoserMatchId) {
      const field = match.nextLoserMatchSlot === 1 ? "player1Id" : "player2Id";
      await cascadeResetSlot(match.nextLoserMatchId, field);
    }
    if (match.bracketSide === "GRAND_FINAL") {
      await removeGrandFinalReset(match.bracketId);
    }
  }

  await Match.findByIdAndUpdate(matchId, {
    [slotField]: null,
    winnerId: null,
    isForfeit: false,
    player1Score: 0,
    player2Score: 0,
    status: "PENDING",
  });
}

// Deletes one match and cascades every consequence of that: undoes its own
// result (if it had one), invalidates whatever it had already fed
// downstream (however deep that chain goes), cleans up a Grand Final Reset
// it may have spawned, and clears any OTHER match's now-dangling pointer at
// this one -- so the bracket is left structurally valid, just with this
// match's own position left empty. Works unchanged for a freeform (no
// bracketId) match too -- every branch below is naturally a no-op when the
// relevant field is unset, so it just falls through to a plain delete.
export async function deleteMatchWithCascade(match: any) {
  await undoMatchEffects(match);

  if (match.nextMatchId) {
    const field = match.nextMatchSlot === 1 ? "player1Id" : "player2Id";
    await cascadeResetSlot(match.nextMatchId, field);
  }
  if (match.nextLoserMatchId) {
    const field = match.nextLoserMatchSlot === 1 ? "player1Id" : "player2Id";
    await cascadeResetSlot(match.nextLoserMatchId, field);
  }
  if (match.bracketSide === "GRAND_FINAL") {
    await removeGrandFinalReset(match.bracketId);
  }

  // No other match should end up pointing at an ID that no longer exists.
  await Match.updateMany({ nextMatchId: match._id }, { nextMatchId: null, nextMatchSlot: null });
  await Match.updateMany({ nextLoserMatchId: match._id }, { nextLoserMatchId: null, nextLoserMatchSlot: null });

  await Match.findByIdAndDelete(match._id);
}
