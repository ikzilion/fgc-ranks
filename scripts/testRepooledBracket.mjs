// scripts/testRepooledBracket.mjs
//
// Functional verification for Pool format Model B, Phases 1, 2, and 2.5:
// buildRepooledBracket, computeNextRepooledRound, and
// buildFinalsCutoffBracket in lib/bracket.ts. All are pure/sync logic with
// no DB access (same as buildDoubleEliminationBracket), so unlike
// scripts/testPoolsFeature.mjs and friends, this test needs no MongoDB
// connection at all -- it just calls the real functions and inspects the
// plain objects they return.
//
// Primary case (TEST 1) is the real confirmed EVO Round 1->2 shape from the
// FGC Ranks Notion context page: 4 pools' Winners-champions (undefeated)
// enter the next round's pool at Winners Semi-Final, while 4 pools' Winners-
// Final losers + Losers-bracket champions (8 total) enter fresh at Losers
// Round 1 -- exactly "4 into Winners Semi-Final + 8 into Losers Round 1".
//
// TEST 2 exercises a bye in the Winners-survivors list (odd count under a
// power-of-two entry size), confirming buildRepooledBracket genuinely reuses
// buildMatch's existing bye pass-through rather than reimplementing it.
//
// TEST 3 checks buildRepooledBracket's input-validation guards.
//
// TEST 4 (Phase 2) replays the full real EVO Japan 2026 SF6 reference table
// (7,683 entrants: 512->128->32->8 pools, then final consolidation to a
// single 24-entrant Semifinals pool that DOES split into Finals) through
// computeNextRepooledRound, round by round, asserting pool counts and the
// final entrant/split-decision numbers match exactly.
//
// TEST 5 is a smaller synthetic case that lands below the 16-entrant
// Finals-split threshold, confirming the dynamic split decision correctly
// does NOT force a second stage.
//
// TEST 6 (Phase 2.5) is the real confirmed 24-entrant Semifinals-phase
// shape: winnersEntrySize 8 (8 winners-survivors) + 16 losers-survivors,
// through buildFinalsCutoffBracket, asserting the early-cutoff structure
// matches exactly -- 1 Winners round ("Winners Quarter-Final", 4 winners),
// 3 Losers rounds (4 winners), 8 total finalist slots, no Grand Final.
//
// TEST 7 generalizes to winnersEntrySize 16 (a size Phase 2 doesn't
// currently produce, but the function should still handle correctly since
// it's derived from entrant count, not hardcoded to 24) -- checked against
// hand-derived exact numbers (deterministic math, not real-world data) plus
// the invariant that it always produces exactly 8 finalists.
//
// TEST 8 confirms the flagged extrapolation gap (winnersEntrySize < 4)
// throws a clear, documented error instead of guessing, plus
// buildFinalsCutoffBracket's other input-validation guards.
//
// Run: npx tsx scripts/testRepooledBracket.mjs

import { Types } from "mongoose";
const { buildRepooledBracket, computeNextRepooledRound, buildFinalsCutoffBracket, generateModelBTournament, MODEL_B_MIN_ENTRANTS } = await import("../lib/bracket");

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  OK   ${label}`);
  } else {
    console.log(`  FAIL ${label}`);
    failures++;
  }
}

function idList(prefix, n) {
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(new Types.ObjectId().toString());
  return ids;
}

function findMatch(matches, side, round, position) {
  return matches.find(m => m.bracketSide === side && m.bracketRound === round && m.bracketPosition === position);
}

function main() {
  const tournamentId = new Types.ObjectId();
  const bracketId = new Types.ObjectId();

  // ═══════════════════════════════════════════════════════════════════
  // TEST 1: confirmed real shape -- 4 winners-survivors into Winners
  // Semi-Final, 8 losers-survivors into Losers Round 1, no byes.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n=== TEST 1: 4 into Winners Semi-Final + 8 into Losers Round 1 ===");

  const W = idList("W", 4); // W[0]=seed1 .. W[3]=seed4
  const L = idList("L", 8); // L[0]=seed1 .. L[7]=seed8

  const { matches } = buildRepooledBracket({
    tournamentId,
    bracketId,
    winnersSurvivorIds: W,
    winnersEntrySize: 4,
    losersSurvivorIds: L,
  });

  assert(matches.length === 14, `14 total matches (2 WSF + 1 WF + 4+2+2+1+1 LB + 1 GF) -- got ${matches.length}`);

  // ── Winners bracket ──────────────────────────────────────────────
  const wsf0 = findMatch(matches, "WINNERS", 1, 0);
  const wsf1 = findMatch(matches, "WINNERS", 1, 1);
  assert(!!wsf0 && !!wsf1, "Winners Round 1 has 2 matches (positions 0, 1)");
  assert(wsf0.round === "Winners Semi-Final" && wsf1.round === "Winners Semi-Final", "Winners Round 1 is labeled 'Winners Semi-Final' (entering 1 round before Finals)");
  // seedSlotOrder(4) = [1,4,2,3] -> pairs (seed1,seed4) at pos0, (seed2,seed3) at pos1
  assert(wsf0.player1Id.toString() === W[0] && wsf0.player2Id.toString() === W[3], "Winners Semi-Final pos 0 pairs seed 1 vs seed 4");
  assert(wsf1.player1Id.toString() === W[1] && wsf1.player2Id.toString() === W[2], "Winners Semi-Final pos 1 pairs seed 2 vs seed 3");

  const wf = findMatch(matches, "WINNERS", 2, 0);
  assert(!!wf, "Winners Round 2 has 1 match");
  assert(wf.round === "Winners Finals", "Winners Round 2 is labeled 'Winners Finals'");
  assert(wf.player1Id === null && wf.player2Id === null, "Winners Finals starts with both slots TBD (fed by Semi-Final winners)");
  assert(wsf0.nextMatchId?.toString() === wf._id.toString() && wsf0.nextMatchSlot === 1, "Winners Semi-Final pos 0's winner feeds Winners Finals slot 1");
  assert(wsf1.nextMatchId?.toString() === wf._id.toString() && wsf1.nextMatchSlot === 2, "Winners Semi-Final pos 1's winner feeds Winners Finals slot 2");

  // ── Losers bracket: Round 1 (losers-survivors, no WB losers yet) ──
  const lr1 = [0, 1, 2, 3].map(pos => findMatch(matches, "LOSERS", 1, pos));
  assert(lr1.every(m => !!m), "Losers Round 1 has 4 matches (positions 0-3)");
  assert(lr1.every(m => m.round === "Losers Round 1"), "Losers Round 1 matches are all labeled 'Losers Round 1'");
  // seedSlotOrder(8) = [1,8,4,5,2,7,3,6] -> adjacent pairs (1,8) (4,5) (2,7) (3,6)
  assert(lr1[0].player1Id.toString() === L[0] && lr1[0].player2Id.toString() === L[7], "Losers Round 1 pos 0 pairs seed 1 vs seed 8");
  assert(lr1[1].player1Id.toString() === L[3] && lr1[1].player2Id.toString() === L[4], "Losers Round 1 pos 1 pairs seed 4 vs seed 5");
  assert(lr1[2].player1Id.toString() === L[1] && lr1[2].player2Id.toString() === L[6], "Losers Round 1 pos 2 pairs seed 2 vs seed 7");
  assert(lr1[3].player1Id.toString() === L[2] && lr1[3].player2Id.toString() === L[5], "Losers Round 1 pos 3 pairs seed 3 vs seed 6");

  // ── Losers Round 2: pure self-consolidation (8 -> 4 not yet caught down
  // to the WB's first wave of 2, so this round consolidates losers-survivors
  // on their own again rather than merging with the Winners bracket yet) ──
  const lr2 = [0, 1].map(pos => findMatch(matches, "LOSERS", 2, pos));
  assert(lr2.every(m => !!m), "Losers Round 2 has 2 matches (positions 0-1)");
  assert(lr2.every(m => m.round === "Losers Round 2"), "Losers Round 2 matches are labeled 'Losers Round 2'");
  assert(lr2.every(m => m.player1Id === null && m.player2Id === null), "Losers Round 2 slots are TBD (fed by Losers Round 1 winners)");
  assert(lr1[0].nextMatchId?.toString() === lr2[0]._id.toString() && lr1[0].nextMatchSlot === 1, "Losers Round 1 pos 0's winner feeds Losers Round 2 pos 0 slot 1");
  assert(lr1[1].nextMatchId?.toString() === lr2[0]._id.toString() && lr1[1].nextMatchSlot === 2, "Losers Round 1 pos 1's winner feeds Losers Round 2 pos 0 slot 2");
  assert(lr1[2].nextMatchId?.toString() === lr2[1]._id.toString() && lr1[2].nextMatchSlot === 1, "Losers Round 1 pos 2's winner feeds Losers Round 2 pos 1 slot 1");
  assert(lr1[3].nextMatchId?.toString() === lr2[1]._id.toString() && lr1[3].nextMatchSlot === 2, "Losers Round 1 pos 3's winner feeds Losers Round 2 pos 1 slot 2");

  // ── Losers Round 3: FIRST drop-in against the Winners Semi-Final's
  // losers (the WB's first loser wave, size 2 -- now matches LB's size) ──
  const lr3 = [0, 1].map(pos => findMatch(matches, "LOSERS", 3, pos));
  assert(lr3.every(m => !!m), "Losers Round 3 has 2 matches (positions 0-1)");
  assert(lr3.every(m => m.round === "Losers Round 3"), "Losers Round 3 matches are labeled 'Losers Round 3' (not yet Losers Finals -- WB Finals loser hasn't dropped in yet)");
  assert(lr2[0].nextMatchId?.toString() === lr3[0]._id.toString() && lr2[0].nextMatchSlot === 1, "Losers Round 2 pos 0's winner feeds Losers Round 3 pos 0 slot 1");
  assert(lr2[1].nextMatchId?.toString() === lr3[1]._id.toString() && lr2[1].nextMatchSlot === 1, "Losers Round 2 pos 1's winner feeds Losers Round 3 pos 1 slot 1");
  assert(wsf0.nextLoserMatchId?.toString() === lr3[0]._id.toString() && wsf0.nextLoserMatchSlot === 2, "Winners Semi-Final pos 0's loser drops into Losers Round 3 pos 0 slot 2");
  assert(wsf1.nextLoserMatchId?.toString() === lr3[1]._id.toString() && wsf1.nextLoserMatchSlot === 2, "Winners Semi-Final pos 1's loser drops into Losers Round 3 pos 1 slot 2");

  // ── Losers Round 4: consolidation of the 2 Round-3 winners ─────────
  const lr4 = findMatch(matches, "LOSERS", 4, 0);
  assert(!!lr4, "Losers Round 4 has 1 match");
  assert(lr4.round === "Losers Round 4", "Losers Round 4 is labeled 'Losers Round 4'");
  assert(lr3[0].nextMatchId?.toString() === lr4._id.toString() && lr3[0].nextMatchSlot === 1, "Losers Round 3 pos 0's winner feeds Losers Round 4 slot 1");
  assert(lr3[1].nextMatchId?.toString() === lr4._id.toString() && lr3[1].nextMatchSlot === 2, "Losers Round 3 pos 1's winner feeds Losers Round 4 slot 2");

  // ── Losers Finals: the WB Finals loser finally drops in ────────────
  const lfin = findMatch(matches, "LOSERS", 5, 0);
  assert(!!lfin, "Losers Round 5 has 1 match");
  assert(lfin.round === "Losers Finals", "Losers Round 5 is labeled 'Losers Finals'");
  assert(lr4.nextMatchId?.toString() === lfin._id.toString() && lr4.nextMatchSlot === 1, "Losers Round 4's winner feeds Losers Finals slot 1");
  assert(wf.nextLoserMatchId?.toString() === lfin._id.toString() && wf.nextLoserMatchSlot === 2, "Winners Finals' loser drops into Losers Finals slot 2");

  // ── Grand Final ──────────────────────────────────────────────────
  const gf = findMatch(matches, "GRAND_FINAL", 1, 0);
  assert(!!gf, "Grand Final exists");
  assert(gf.round === "Grand Finals", "Grand Final is labeled 'Grand Finals'");
  assert(wf.nextMatchId?.toString() === gf._id.toString() && wf.nextMatchSlot === 1, "Winners Finals' winner feeds Grand Final slot 1 (winners-side convention)");
  assert(lfin.nextMatchId?.toString() === gf._id.toString() && lfin.nextMatchSlot === 2, "Losers Finals' winner feeds Grand Final slot 2 (losers-side convention)");

  // ═══════════════════════════════════════════════════════════════════
  // TEST 2: a bye in the Winners-survivors list -- confirms
  // buildRepooledBracket reuses buildMatch's existing bye pass-through
  // rather than reimplementing bye handling.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n=== TEST 2: 3 winners-survivors into a 4-slot Winners Semi-Final (1 bye) ===");

  const W3 = idList("W3", 3); // seed4 is a bye
  const { matches: matches2 } = buildRepooledBracket({
    tournamentId,
    bracketId,
    winnersSurvivorIds: W3,
    winnersEntrySize: 4,
    losersSurvivorIds: idList("L2", 8),
  });

  // (seed1, seed4=BYE) auto-advances seed1 with no match played.
  const byeMatch = findMatch(matches2, "WINNERS", 1, 0);
  assert(!byeMatch, "Winners Semi-Final pos 0 (seed 1 vs bye) creates NO match -- pure bye pass-through");
  const realMatch = findMatch(matches2, "WINNERS", 1, 1);
  assert(!!realMatch && realMatch.player1Id.toString() === W3[1] && realMatch.player2Id.toString() === W3[2], "Winners Semi-Final pos 1 (seed 2 vs seed 3) is a real match");
  const wf2 = findMatch(matches2, "WINNERS", 2, 0);
  assert(wf2.player1Id.toString() === W3[0], "Winners Finals slot 1 is filled immediately with the bye-advanced seed 1 (not left TBD)");
  assert(wf2.player2Id === null, "Winners Finals slot 2 stays TBD, fed by the real Semi-Final match");
  assert(realMatch.nextMatchId?.toString() === wf2._id.toString() && realMatch.nextMatchSlot === 2, "The real Semi-Final match's winner feeds Winners Finals slot 2");

  // ═══════════════════════════════════════════════════════════════════
  // TEST 3: input validation guards.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n=== TEST 3: input validation ===");

  const throws = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };

  assert(
    throws(() => buildRepooledBracket({ tournamentId, bracketId, winnersSurvivorIds: idList("x", 3), winnersEntrySize: 3, losersSurvivorIds: idList("y", 4) })),
    "Rejects a non-power-of-two winnersEntrySize"
  );
  assert(
    throws(() => buildRepooledBracket({ tournamentId, bracketId, winnersSurvivorIds: idList("x", 5), winnersEntrySize: 4, losersSurvivorIds: idList("y", 4) })),
    "Rejects winnersSurvivorIds longer than winnersEntrySize"
  );
  assert(
    throws(() => buildRepooledBracket({ tournamentId, bracketId, winnersSurvivorIds: idList("x", 4), winnersEntrySize: 4, losersSurvivorIds: idList("y", 2) })),
    "Rejects losersSurvivorIds too small to reach the Winners bracket's first loser wave (2 survivors, Round 1 consolidation alone drops it to 1, below the wave's 2)"
  );

  // ═══════════════════════════════════════════════════════════════════
  // TEST 4 (Phase 2): full real EVO Japan 2026 SF6 reference simulation --
  // 7,683 entrants: 512 -> 128 -> 32 -> 8 pools (each a merge-4:1 step),
  // then final consolidation of those 8 pools into a single 24-entrant
  // Semifinals pool, which (>=16) DOES split into a further Finals stage.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n=== TEST 4: full EVO SF6 reference simulation (512->128->32->8->Semifinals) ===");

  function makeSourcePool(entrantCount, losersSurplus = 2) {
    return {
      entrantCount,
      winnersChampionId: new Types.ObjectId().toString(),
      losersSurvivorIds: idList("sf6", losersSurplus),
    };
  }

  // Round 1's own entrantCount is never consulted (merge-stage grouping
  // only cares about pool_count, not entrantCount) -- 15 just documents the
  // real ~7,683/512 average.
  let round = Array.from({ length: 512 }, () => makeSourcePool(15));
  const poolCountsPerStep = [];
  const stagesPerStep = [];
  let finalResult = null;

  for (let step = 0; step < 10; step++) {
    const result = computeNextRepooledRound({ tournamentId, pools: round });
    poolCountsPerStep.push(result.newPools.length);
    stagesPerStep.push(result.stage);
    if (result.stage === "FINAL_CONSOLIDATION") {
      finalResult = result;
      break;
    }
    // Simulate this round's pools each completing with the flat 3/pool
    // rule (1 winners-champion + 2 losers) to feed the next iteration.
    round = result.newPools.map(np => ({
      entrantCount: np.entrantCount,
      winnersChampionId: new Types.ObjectId().toString(),
      losersSurvivorIds: idList("sf6b", 2),
    }));
  }

  assert(
    JSON.stringify(poolCountsPerStep) === JSON.stringify([128, 32, 8, 1]),
    `Pool counts per round match real SF6 data (Round2=128, Round3=32, Round4=8, Semifinals=1) -- got ${JSON.stringify(poolCountsPerStep)}`
  );
  assert(
    JSON.stringify(stagesPerStep) === JSON.stringify(["MERGE", "MERGE", "MERGE", "FINAL_CONSOLIDATION"]),
    `Stage sequence is 3 merges then final consolidation -- got ${JSON.stringify(stagesPerStep)}`
  );
  assert(!!finalResult, "Simulation reached FINAL_CONSOLIDATION within 10 steps");
  assert(finalResult.newPools.length === 1, "Final consolidation produces exactly 1 new pool");
  assert(finalResult.newPools[0].entrantCount === 24, `Consolidated Semifinals pool has 24 entrants (real SF6 data) -- got ${finalResult.newPools[0].entrantCount}`);
  assert(finalResult.newPools[0].winnersEntrySize === 8, `Semifinals pool's Winners bracket enters at size 8 (1 champion x 8 source pools) -- got ${finalResult.newPools[0].winnersEntrySize}`);
  assert(finalResult.splitsIntoFinals === true, "24-entrant Semifinals pool (>=16) reports splitsIntoFinals = true, matching real EVO data's further Finals stage");

  // ═══════════════════════════════════════════════════════════════════
  // TEST 5 (Phase 2): a small synthetic case landing below the 16-entrant
  // Finals-split threshold -- confirms the dynamic split decision does NOT
  // force an artificial second stage when the field is too small for one.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n=== TEST 5: below the 16-entrant Finals-split threshold ===");

  const smallPools = [1, 2, 3].map(() => ({
    entrantCount: 4,
    winnersChampionId: new Types.ObjectId().toString(),
    losersSurvivorIds: idList("small", 10), // generous surplus -- computeNextRepooledRound trims to whatever it actually needs
  }));

  const smallResult = computeNextRepooledRound({ tournamentId, pools: smallPools });
  assert(smallResult.stage === "FINAL_CONSOLIDATION", "3 pools (<=8) goes straight to final consolidation, no merge-4:1 step");
  assert(smallResult.newPools.length === 1, "Final consolidation produces exactly 1 new pool");
  assert(smallResult.newPools[0].entrantCount === 12, `Target capped at this round's actual entrant total (3 pools x 4 = 12, below the 24 target) -- got ${smallResult.newPools[0].entrantCount}`);
  assert(smallResult.newPools[0].winnersEntrySize === 4, `Consolidated pool's Winners bracket enters at size 4 (1 champion x 3 source pools, padded up) -- got ${smallResult.newPools[0].winnersEntrySize}`);
  assert(smallResult.splitsIntoFinals === false, "12-entrant consolidated pool (<16) reports splitsIntoFinals = false -- no artificial second stage forced");

  const throwsRepool = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  assert(
    throwsRepool(() => computeNextRepooledRound({ tournamentId, pools: [smallPools[0]] })),
    "computeNextRepooledRound rejects fewer than 2 completed pools"
  );

  // ═══════════════════════════════════════════════════════════════════
  // TEST 6 (Phase 2.5): the one confirmed real shape -- a 24-entrant
  // Semifinals-phase pool (winnersEntrySize 8, 16 losers-survivors) cuts
  // off after exactly 1 Winners round ("Winners Quarter-Final") and 3
  // Losers rounds, producing 4 + 4 = 8 finalist slots. No Grand Final.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n=== TEST 6: 24-entrant Semifinals-phase early cutoff (real EVO shape) ===");

  const W8 = idList("W8", 8); // seed1..seed8
  const L16 = idList("L16", 16); // seed1..seed16

  const cutoff = buildFinalsCutoffBracket({
    tournamentId,
    bracketId,
    winnersSurvivorIds: W8,
    winnersEntrySize: 8,
    losersSurvivorIds: L16,
  });

  assert(cutoff.matches.length === 20, `20 total matches (4 WQF + 8+4+4 LB) -- got ${cutoff.matches.length}`);
  assert(cutoff.winnersRoundsPlayed === 1, `winnersRoundsPlayed === 1 -- got ${cutoff.winnersRoundsPlayed}`);
  assert(cutoff.losersRoundsPlayed === 3, `losersRoundsPlayed === 3 -- got ${cutoff.losersRoundsPlayed}`);
  assert(!findMatch(cutoff.matches, "GRAND_FINAL", 1, 0), "No Grand Final is played within this pool -- its qualifiers go to a separate Finals bracket");

  // ── Winners side: 1 round, "Winners Quarter-Final", 4 matches ──────
  const wqf = [0, 1, 2, 3].map(pos => findMatch(cutoff.matches, "WINNERS", 1, pos));
  assert(wqf.every(m => !!m), "Winners Round 1 has 4 matches (positions 0-3)");
  assert(wqf.every(m => m.round === "Winners Quarter-Final"), "Winners Round 1 is labeled 'Winners Quarter-Final' -- matches the real EVO label exactly");
  assert(!findMatch(cutoff.matches, "WINNERS", 2, 0), "No Winners Round 2 is played -- the cutoff stops after Quarter-Final");
  // seedSlotOrder(8) = [1,8,4,5,2,7,3,6]
  assert(wqf[0].player1Id.toString() === W8[0] && wqf[0].player2Id.toString() === W8[7], "Winners Quarter-Final pos 0 pairs seed 1 vs seed 8");
  assert(wqf[1].player1Id.toString() === W8[3] && wqf[1].player2Id.toString() === W8[4], "Winners Quarter-Final pos 1 pairs seed 4 vs seed 5");
  assert(wqf[2].player1Id.toString() === W8[1] && wqf[2].player2Id.toString() === W8[6], "Winners Quarter-Final pos 2 pairs seed 2 vs seed 7");
  assert(wqf[3].player1Id.toString() === W8[2] && wqf[3].player2Id.toString() === W8[5], "Winners Quarter-Final pos 3 pairs seed 3 vs seed 6");

  // ── Losers side: 3 rounds ────────────────────────────────────────
  const lr1b = [0, 1, 2, 3, 4, 5, 6, 7].map(pos => findMatch(cutoff.matches, "LOSERS", 1, pos));
  assert(lr1b.every(m => !!m), "Losers Round 1 has 8 matches (positions 0-7)");
  assert(lr1b.every(m => m.round === "Losers Round 1"), "Losers Round 1 matches are labeled 'Losers Round 1'");

  const lr2b = [0, 1, 2, 3].map(pos => findMatch(cutoff.matches, "LOSERS", 2, pos));
  assert(lr2b.every(m => !!m), "Losers Round 2 has 4 matches (positions 0-3)");
  assert(lr2b.every(m => m.round === "Losers Round 2"), "Losers Round 2 matches are labeled 'Losers Round 2'");
  assert(lr2b.every(m => m.player1Id === null && m.player2Id === null), "Losers Round 2 slots are TBD (fed by Losers Round 1 winners)");
  for (let i = 0; i < 4; i++) {
    assert(lr1b[2 * i].nextMatchId?.toString() === lr2b[i]._id.toString() && lr1b[2 * i].nextMatchSlot === 1, `Losers Round 1 pos ${2 * i}'s winner feeds Losers Round 2 pos ${i} slot 1`);
    assert(lr1b[2 * i + 1].nextMatchId?.toString() === lr2b[i]._id.toString() && lr1b[2 * i + 1].nextMatchSlot === 2, `Losers Round 1 pos ${2 * i + 1}'s winner feeds Losers Round 2 pos ${i} slot 2`);
  }

  const lr3b = [0, 1, 2, 3].map(pos => findMatch(cutoff.matches, "LOSERS", 3, pos));
  assert(lr3b.every(m => !!m), "Losers Round 3 has 4 matches (positions 0-3)");
  assert(lr3b.every(m => m.round === "Losers Round 3"), "Losers Round 3 matches are labeled 'Losers Round 3' (not 'Losers Finals' -- this pool never reaches its own Losers Finals)");
  assert(!findMatch(cutoff.matches, "LOSERS", 4, 0), "No Losers Round 4 is played -- the cutoff stops after Round 3");
  for (let i = 0; i < 4; i++) {
    assert(lr2b[i].nextMatchId?.toString() === lr3b[i]._id.toString() && lr2b[i].nextMatchSlot === 1, `Losers Round 2 pos ${i}'s winner feeds Losers Round 3 pos ${i} slot 1`);
    assert(wqf[i].nextLoserMatchId?.toString() === lr3b[i]._id.toString() && wqf[i].nextLoserMatchSlot === 2, `Winners Quarter-Final pos ${i}'s loser drops into Losers Round 3 pos ${i} slot 2`);
  }

  // ── Finalist slots: 4 Winners-side qualifiers then 4 Losers-side ───
  assert(cutoff.finalistSlots.length === 8, `finalistSlots has exactly 8 entries -- got ${cutoff.finalistSlots.length}`);
  assert(cutoff.finalistSlots.every(s => s.kind === "PENDING" && s.which === "winner"), "Every finalist slot is a PENDING reference to a played match's winner (no byes in this all-real-players case)");
  assert(
    cutoff.finalistSlots.slice(0, 4).every((s, i) => s.draft._id.toString() === wqf[i]._id.toString()),
    "First 4 finalist slots are the Winners Quarter-Final matches' winners, in position order"
  );
  assert(
    cutoff.finalistSlots.slice(4, 8).every((s, i) => s.draft._id.toString() === lr3b[i]._id.toString()),
    "Last 4 finalist slots are the Losers Round 3 matches' winners, in position order"
  );

  // ═══════════════════════════════════════════════════════════════════
  // TEST 7 (Phase 2.5): generalization to winnersEntrySize 16 -- a size
  // Phase 2 doesn't currently produce, but the function should still get
  // right since it derives round counts from entrant count. Checked
  // against hand-derived exact numbers (deterministic math), not real-world
  // data this size doesn't have.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n=== TEST 7: generalization to winnersEntrySize 16 ===");

  const cutoff16 = buildFinalsCutoffBracket({
    tournamentId,
    bracketId,
    winnersSurvivorIds: idList("W16", 16),
    winnersEntrySize: 16,
    losersSurvivorIds: idList("L32", 32),
  });

  assert(cutoff16.winnersRoundsPlayed === 2, `winnersRoundsPlayed === 2 (log2(16/4)) -- got ${cutoff16.winnersRoundsPlayed}`);
  assert(cutoff16.losersRoundsPlayed === 5, `losersRoundsPlayed === 5 (2 pre-consolidation + 2x2 waves - 1) -- got ${cutoff16.losersRoundsPlayed}`);
  assert(cutoff16.matches.length === 52, `52 total matches (8+4 WB, 16+8+8+4+4 LB) -- got ${cutoff16.matches.length}`);
  assert(cutoff16.finalistSlots.length === 8, `finalistSlots is always exactly 8 regardless of winnersEntrySize -- got ${cutoff16.finalistSlots.length}`);
  assert(!!findMatch(cutoff16.matches, "WINNERS", 1, 0) && findMatch(cutoff16.matches, "WINNERS", 1, 0).round === "Winners Round 1", "Winners Round 1 (3 rounds before this bracket's own never-played Finals) uses the generic label");
  assert(!!findMatch(cutoff16.matches, "WINNERS", 2, 0) && findMatch(cutoff16.matches, "WINNERS", 2, 0).round === "Winners Quarter-Final", "Winners Round 2 (2 rounds before Finals) is labeled 'Winners Quarter-Final'");
  assert(!findMatch(cutoff16.matches, "WINNERS", 3, 0), "No Winners Round 3 is played -- cutoff stops after Round 2");
  assert(!findMatch(cutoff16.matches, "LOSERS", 6, 0), "No Losers Round 6 is played -- cutoff stops after Round 5");

  // ═══════════════════════════════════════════════════════════════════
  // TEST 8 (Phase 2.5): the flagged extrapolation gap + other guards.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n=== TEST 8: buildFinalsCutoffBracket input validation ===");

  const throwsCutoff = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };

  assert(
    throwsCutoff(() => buildFinalsCutoffBracket({ tournamentId, bracketId, winnersSurvivorIds: idList("g", 2), winnersEntrySize: 2, losersSurvivorIds: idList("h", 6) })),
    "Rejects winnersEntrySize below FINALS_HALF (2 < 4) -- the flagged, undocumented extrapolation gap"
  );
  assert(
    throwsCutoff(() => buildFinalsCutoffBracket({ tournamentId, bracketId, winnersSurvivorIds: idList("g", 3), winnersEntrySize: 3, losersSurvivorIds: idList("h", 4) })),
    "Rejects a non-power-of-two winnersEntrySize"
  );
  assert(
    throwsCutoff(() => buildFinalsCutoffBracket({ tournamentId, bracketId, winnersSurvivorIds: idList("g", 5), winnersEntrySize: 4, losersSurvivorIds: idList("h", 4) })),
    "Rejects winnersSurvivorIds longer than winnersEntrySize"
  );
  assert(
    throwsCutoff(() => buildFinalsCutoffBracket({ tournamentId, bracketId, winnersSurvivorIds: idList("g", 4), winnersEntrySize: 4, losersSurvivorIds: [] })),
    "Rejects an empty losersSurvivorIds list"
  );

  // ═══════════════════════════════════════════════════════════════════
  // TEST 9 (Phase 3): full end-to-end generateModelBTournament run against
  // a synthetic entrant list the size of the real EVO Japan 2026 SF6
  // reference dataset (7,683 entrants). Real player names/seeds aren't
  // essential -- only the shape (round sizes, hand-offs, Finals) matters,
  // per the task's own framing.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n=== TEST 9: generateModelBTournament end-to-end (SF6-scale, 7,683 entrants) ===");

  const sf6Entrants = idList("sf6full", 7683);
  const sf6Result = generateModelBTournament({ tournamentId, entrantPlayerIds: sf6Entrants });

  assert(sf6Result.entrantCount === 7683, `entrantCount echoes the input (7683) -- got ${sf6Result.entrantCount}`);
  assert(sf6Result.initialPoolCount === 512, `Initial pool count is 512 (power-of-2, ~15/pool target on 7683 entrants) -- got ${sf6Result.initialPoolCount}`);
  assert(sf6Result.rounds.length === 5, `5 rounds recorded (Round 1, 2, 3, 4, Semifinals) -- got ${sf6Result.rounds.length}`);

  const roundPoolCounts = sf6Result.rounds.map(r => r.pools.length);
  assert(
    JSON.stringify(roundPoolCounts) === JSON.stringify([512, 128, 32, 8, 1]),
    `Round sizes are 512 -> 128 -> 32 -> 8 pools, then the 24-entrant Semifinal pool -- got ${JSON.stringify(roundPoolCounts)}`
  );

  const roundStages = sf6Result.rounds.map(r => r.stage);
  assert(
    JSON.stringify(roundStages) === JSON.stringify(["INITIAL", "MERGE", "MERGE", "MERGE", "FINAL_CONSOLIDATION"]),
    `Stage sequence is INITIAL, then 3 merges, then final consolidation -- got ${JSON.stringify(roundStages)}`
  );

  const round1EntrantTotal = sf6Result.rounds[0].pools.reduce((sum, p) => sum + p.entrantCount, 0);
  assert(round1EntrantTotal === 7683, `Round 1's pools collectively hold all 7683 entrants -- got ${round1EntrantTotal}`);
  assert(sf6Result.rounds[0].pools.every(p => p.matches.length > 0), "Every Round 1 pool has real matches (a standard double-elim bracket)");

  // Hand-off correctness: each merge round is exactly a 4:1 reduction of
  // the previous round's pool count, and every merged pool ends up with the
  // fixed 12 entrants (4 source pools x 3 advancers/pool) computeNextRepooledRound's
  // MERGE stage always produces.
  for (let i = 1; i <= 3; i++) {
    assert(
      sf6Result.rounds[i - 1].pools.length === sf6Result.rounds[i].pools.length * 4,
      `Round ${i + 1}'s pool count is exactly 1/4 of Round ${i}'s (4:1 merge) -- ${sf6Result.rounds[i - 1].pools.length} -> ${sf6Result.rounds[i].pools.length}`
    );
    assert(
      sf6Result.rounds[i].pools.every(p => p.entrantCount === 12),
      `Round ${i + 1}'s pools each hold exactly 12 entrants (4 source pools x 3 survivors) -- got ${JSON.stringify(sf6Result.rounds[i].pools.map(p => p.entrantCount))}`
    );
  }

  const semifinalPool = sf6Result.rounds[4].pools[0];
  assert(semifinalPool.entrantCount === 24, `Semifinal pool has 24 entrants (8 source pools x 3 survivors) -- got ${semifinalPool.entrantCount}`);
  assert(semifinalPool.winnersEntrySize === 8, `Semifinal pool's Winners bracket enters at size 8 -- got ${semifinalPool.winnersEntrySize}`);
  assert(semifinalPool.matches.length === 20, `Semifinal pool's matches are the truncated Finals-cutoff shape (20 matches, no Grand Final) -- got ${semifinalPool.matches.length}`);
  assert(!semifinalPool.matches.some(m => m.bracketSide === "GRAND_FINAL"), "Semifinal pool never plays its own Grand Final -- its qualifiers feed a separate Finals bracket");

  assert(sf6Result.splitsIntoFinals === true, "24-entrant Semifinal pool (>=16) splits into a separate Finals stage");
  assert(!!sf6Result.finalsCutoff, "finalsCutoff is present when splitsIntoFinals is true");
  assert(sf6Result.finalsCutoff.finalistSlots.length === 8, `finalsCutoff produces exactly 8 finalist slots -- got ${sf6Result.finalsCutoff.finalistSlots.length}`);
  assert(!!sf6Result.finalsBracketId, "finalsBracketId is present when splitsIntoFinals is true");
  assert(Array.isArray(sf6Result.finalsMatches) && sf6Result.finalsMatches.length > 0, "finalsMatches is a non-empty array of match drafts");

  const sf6GrandFinal = sf6Result.finalsMatches.find(m => m.bracketSide === "GRAND_FINAL");
  assert(!!sf6GrandFinal, "The real Finals bracket has a Grand Final");
  const sf6FinalsR1 = sf6Result.finalsMatches.filter(m => m.bracketSide === "WINNERS" && m.bracketRound === 1);
  assert(sf6FinalsR1.length === 4, `The real Finals bracket's Winners Round 1 has exactly 4 matches (8 finalists, no byes) -- got ${sf6FinalsR1.length}`);
  const sf6FinalsEntrantIds = new Set();
  sf6FinalsR1.forEach(m => {
    sf6FinalsEntrantIds.add(m.player1Id.toString());
    sf6FinalsEntrantIds.add(m.player2Id.toString());
  });
  assert(sf6FinalsEntrantIds.size === 8, `The real Finals bracket's Winners Round 1 references exactly 8 distinct entrants -- got ${sf6FinalsEntrantIds.size}`);

  // ═══════════════════════════════════════════════════════════════════
  // TEST 10 (Phase 3): the below-128 guard.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n=== TEST 10: generateModelBTournament below-128 guard ===");

  assert(MODEL_B_MIN_ENTRANTS === 128, `MODEL_B_MIN_ENTRANTS is 128 -- got ${MODEL_B_MIN_ENTRANTS}`);
  assert(
    throwsCutoff(() => generateModelBTournament({ tournamentId, entrantPlayerIds: idList("small", 127) })),
    "Rejects 127 entrants (just below the 128 minimum)"
  );
  assert(
    throwsCutoff(() => generateModelBTournament({ tournamentId, entrantPlayerIds: idList("tiny", 20) })),
    "Rejects a small (20-entrant) field with a clear error rather than silently running Model B on it"
  );

  // ═══════════════════════════════════════════════════════════════════
  // TEST 11 (Phase 3): end-to-end against the real Tekken 8 reference scale
  // (882 entrants). Our own initial pool sizing doesn't need to replicate
  // EVO's own per-event intermediate numbers (settled design, no single
  // universal formula exists across real events) -- only the two genuinely
  // universal invariants (funnel to ~24, then Top 8) are checked here.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n=== TEST 11: generateModelBTournament end-to-end (Tekken 8 scale, 882 entrants) ===");

  const tekken8Entrants = idList("tk8", 882);
  const tekken8Result = generateModelBTournament({ tournamentId, entrantPlayerIds: tekken8Entrants });

  assert(tekken8Result.rounds[0].pools.reduce((sum, p) => sum + p.entrantCount, 0) === 882, "Round 1's pools collectively hold all 882 entrants");
  assert(tekken8Result.rounds[tekken8Result.rounds.length - 1].stage === "FINAL_CONSOLIDATION", "Last recorded round is the final consolidation stage");
  assert(tekken8Result.rounds[tekken8Result.rounds.length - 1].pools.length === 1, "Final consolidation produces exactly 1 Semifinal pool");
  assert(tekken8Result.splitsIntoFinals === true, "Tekken 8-scale field splits into a separate Finals stage");
  assert(tekken8Result.finalsCutoff.finalistSlots.length === 8, "Tekken 8-scale Finals cutoff produces exactly 8 finalist slots");
  assert(tekken8Result.finalsMatches.some(m => m.bracketSide === "GRAND_FINAL"), "Tekken 8-scale real Finals bracket has a Grand Final");

  // ═══════════════════════════════════════════════════════════════════
  // TEST 12 (Phase 3): end-to-end against the real Fist of the North Star
  // reference scale (154 entrants) -- the smallest confirmed real Model B
  // dataset, just above the 128 minimum.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n=== TEST 12: generateModelBTournament end-to-end (Fist of the North Star scale, 154 entrants) ===");

  const fotnsEntrants = idList("fotns", 154);
  const fotnsResult = generateModelBTournament({ tournamentId, entrantPlayerIds: fotnsEntrants });

  assert(fotnsResult.rounds[0].pools.reduce((sum, p) => sum + p.entrantCount, 0) === 154, "Round 1's pools collectively hold all 154 entrants");
  assert(fotnsResult.rounds[fotnsResult.rounds.length - 1].stage === "FINAL_CONSOLIDATION", "Last recorded round is the final consolidation stage");
  assert(fotnsResult.rounds[fotnsResult.rounds.length - 1].pools.length === 1, "Final consolidation produces exactly 1 Semifinal pool");
  assert(fotnsResult.splitsIntoFinals === true, "Fist of the North Star-scale field splits into a separate Finals stage");
  assert(fotnsResult.finalsCutoff.finalistSlots.length === 8, "Fist of the North Star-scale Finals cutoff produces exactly 8 finalist slots");
  assert(fotnsResult.finalsMatches.some(m => m.bracketSide === "GRAND_FINAL"), "Fist of the North Star-scale real Finals bracket has a Grand Final");

  console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
