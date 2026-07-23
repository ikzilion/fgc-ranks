// scripts/testMatchDeleteCascade.mjs
//
// Functional verification for individual bracket-match deletion with
// cascade-reset (deleteMatch + lib/bracket.ts's deleteMatchWithCascade).
// Calls the REAL GraphQL resolver functions against real data in the actual
// database, mirroring scripts/testPoolsFeature.mjs's pattern — the same
// code path the GraphQL API itself runs.
//
// Two brackets are driven with a fully DETERMINISTIC winner rule ("player1
// always wins") specifically so every match's outcome, and therefore every
// downstream consequence of deleting a given match, can be hand-derived and
// asserted exactly, not just checked for "didn't crash."
//
// Run: npx tsx scripts/testMatchDeleteCascade.mjs

import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";

function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvLocal();
if (!process.env.MONGODB_URI) throw new Error("Missing MONGODB_URI (checked .env.local)");

const { connectToDatabase } = await import("../lib/db");
const { User } = await import("../models/User");
const { Player } = await import("../models/Player");
const { Tournament } = await import("../models/Tournament");
const { Entrant } = await import("../models/Entrant");
const { Match } = await import("../models/Match");
const { Bracket } = await import("../models/Bracket");
const { Pool } = await import("../models/Pool");
const { resolvers } = await import("../graphql/resolvers/index");

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  OK   ${label}`);
  } else {
    console.log(`  FAIL ${label}`);
    failures++;
  }
}

const PASSWORD_HASH_PROMISE = bcrypt.hash("TestPass123!", 10);

async function makeTestPlayer(tag) {
  const passwordHash = await PASSWORD_HASH_PROMISE;
  const email = `${tag.toLowerCase()}@example.com`;
  const user = await User.create({ email, passwordHash });
  const player = await Player.create({ userId: user._id, tag });
  await User.findByIdAndUpdate(user._id, { playerId: player._id });
  return player;
}

// ─── Generic invariants, reusable across every scenario below ────────────

// No match anywhere in this tournament should point at a match ID that no
// longer exists.
async function assertNoDanglingReferences(tournamentId, label) {
  const matches = await Match.find({ tournamentId });
  const liveIds = new Set(matches.map(m => m._id.toString()));
  let dangling = 0;
  for (const m of matches) {
    if (m.nextMatchId && !liveIds.has(m.nextMatchId.toString())) dangling++;
    if (m.nextLoserMatchId && !liveIds.has(m.nextLoserMatchId.toString())) dangling++;
  }
  assert(dangling === 0, `${label}: no match references a deleted match's ID (found ${dangling})`);
}

// A player's stored wins/losses must always equal a fresh recount straight
// from the match table -- independent of any hand-derivation, this alone
// proves the cascade neither double-reversed nor under-reversed any stat.
async function assertStatsConsistent(playerIds, label) {
  let mismatches = 0;
  for (const playerId of playerIds) {
    const pid = playerId.toString();
    const player = await Player.findById(pid);
    const wins = await Match.countDocuments({ status: "COMPLETED", winnerId: pid });
    const decided = await Match.find({ status: "COMPLETED", winnerId: { $ne: null }, $or: [{ player1Id: pid }, { player2Id: pid }] });
    const losses = decided.filter(m => m.winnerId.toString() !== pid).length;
    if (player.wins !== wins || player.losses !== losses) {
      mismatches++;
      console.log(`    mismatch ${player.tag}: stored wins=${player.wins} losses=${player.losses}, recounted wins=${wins} losses=${losses}`);
    }
  }
  assert(mismatches === 0, `${label}: every player's stored wins/losses match a fresh recount from the match table`);
}

async function m(bracketId, side, round, position) {
  return Match.findOne({ bracketId, bracketSide: side, bracketRound: round, bracketPosition: position });
}

// player1 always wins, 2-0 -- makes every downstream consequence hand-traceable.
async function playRoundP1Wins(organizerCtx, bracketId, bracketSide, bracketRound) {
  const ready = await Match.find({
    bracketId, bracketSide, bracketRound, status: "PENDING",
    player1Id: { $ne: null }, player2Id: { $ne: null },
  });
  for (const match of ready) {
    await resolvers.Mutation.reportResult(null, { matchId: match._id.toString(), player1Score: 2, player2Score: 0 }, organizerCtx);
  }
  return ready.length;
}

async function playBracketP1Wins(organizerCtx, bracketId, { includeGrandFinal = true } = {}) {
  for (let round = 1; round <= 10; round++) {
    const wb = await playRoundP1Wins(organizerCtx, bracketId, "WINNERS", round);
    const lb = await playRoundP1Wins(organizerCtx, bracketId, "LOSERS", round);
    if (wb === 0 && lb === 0) break;
  }
  if (includeGrandFinal) {
    const gf = await Match.findOne({ bracketId, bracketSide: "GRAND_FINAL" });
    if (gf && gf.status === "PENDING" && gf.player1Id && gf.player2Id) {
      await resolvers.Mutation.reportResult(null, { matchId: gf._id.toString(), player1Score: 2, player2Score: 0 }, organizerCtx);
    }
  }
}

async function main() {
  const mongooseInstance = await connectToDatabase();
  const createdTournamentIds = [];
  const createdPlayerTags = [];

  try {
    // ═══════════════════════════════════════════════════════════════════
    // TEST A: 8-entrant standard bracket, deep multi-round cascade
    //
    // MANUAL seeding [P1..P8] makes seedSlotOrder(8) = [1,8,4,5,2,7,3,6]
    // fully deterministic, and "player1 always wins" makes every match's
    // outcome hand-traceable. Deleting Winners Round 1's P1-vs-P8 match
    // invalidates BOTH finalist paths at once (P1 -> WR2 -> WB Finals -> GF
    // as the winners finalist; P8 -> LB R1 -> LB R2 -> LB R3 -> LB Finals ->
    // GF as the losers finalist), including two real convergence points
    // (LB Round 2 and Grand Final are each reached via two independent
    // cascade paths) -- a strong test of both "many rounds deep" and
    // "cascade doesn't double-process a match reached twice."
    // ═══════════════════════════════════════════════════════════════════
    console.log("\n=== TEST A: 8-entrant standard bracket, deep cascade ===");

    const organizerA = await makeTestPlayer("CascadeTestTOA");
    const organizerCtxA = { playerId: organizerA._id.toString(), role: "USER" };
    createdPlayerTags.push("CascadeTestTOA");

    const pTags = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"].map(t => `Cascade${t}`);
    const players = {};
    for (const tag of pTags) {
      players[tag] = await makeTestPlayer(tag);
      createdPlayerTags.push(tag);
    }
    const P = tag => players[`Cascade${tag}`];

    const tournamentA = await Tournament.create({
      name: "Cascade Delete Test A", game: "Test Game", format: "Standard Bracket",
      organizers: [organizerA._id], startDate: new Date(), entrantCount: 8,
    });
    createdTournamentIds.push(tournamentA._id);
    await Entrant.insertMany(pTags.map(tag => ({ playerId: players[tag]._id, tournamentId: tournamentA._id })));

    const bracketA = await resolvers.Mutation.generateBracket(
      null,
      { tournamentId: tournamentA._id.toString(), seedingMethod: "MANUAL", manualSeedOrder: pTags.map(tag => players[tag]._id.toString()) },
      organizerCtxA
    );

    await playBracketP1Wins(organizerCtxA, bracketA._id, { includeGrandFinal: true });

    // Sanity check the hand-derived bracket shape BEFORE touching anything,
    // so a mismatch here means my trace is wrong, not the deletion code.
    const gfA = await Match.findOne({ bracketId: bracketA._id, bracketSide: "GRAND_FINAL" });
    assert(gfA.status === "COMPLETED" && gfA.winnerId.toString() === P("P1")._id.toString(), "Setup: Grand Final completed, P1 (winners finalist) won normally, no reset");
    const entrantsA = await Entrant.find({ tournamentId: tournamentA._id });
    const placementByTag = {};
    for (const tag of pTags) {
      const e = entrantsA.find(e => e.playerId.toString() === players[tag]._id.toString());
      placementByTag[tag] = e.placement ?? null;
    }
    assert(
      placementByTag.CascadeP1 === 1 && placementByTag.CascadeP8 === 2 && placementByTag.CascadeP2 === 3 &&
      placementByTag.CascadeP7 === 5 && placementByTag.CascadeP4 === 9 && placementByTag.CascadeP3 === 9 &&
      placementByTag.CascadeP5 == null && placementByTag.CascadeP6 == null,
      `Setup: hand-derived placements match (got ${JSON.stringify(placementByTag)})`
    );
    await assertStatsConsistent(pTags.map(t => players[t]._id), "Setup");

    // Manual override on P7 (auto-placement 5) -- must survive the cascade
    // untouched, unlike every OTHER affected entrant's auto placement.
    const p7Entrant = entrantsA.find(e => e.playerId.toString() === P("P7")._id.toString());
    await resolvers.Mutation.setPlacement(null, { entrantId: p7Entrant._id.toString(), placement: 2 }, organizerCtxA);

    const wr1pos0 = await m(bracketA._id, "WINNERS", 1, 0); // P1 vs P8
    const wr2pos0Id = wr1pos0.nextMatchId; // "TBD vs P4" expected after
    const wbFinalsId = (await Match.findById(wr2pos0Id)).nextMatchId;
    const gfId = gfA._id;
    const lbR1pos0Id = wr1pos0.nextLoserMatchId; // "TBD vs P5" expected after
    const lbR2pos0Id = (await Match.findById(lbR1pos0Id)).nextMatchId;
    const lbR3pos0Id = (await Match.findById(lbR2pos0Id)).nextMatchId;
    const lbFinalsId = (await Match.findById(lbR3pos0Id)).nextMatchId;

    const deletedId = wr1pos0._id.toString();
    const result = await resolvers.Mutation.deleteMatch(null, { id: deletedId }, organizerCtxA);
    assert(result === true, "deleteMatch returned true");
    assert((await Match.findById(deletedId)) === null, "The deleted match's own document is gone");

    // Exact hand-derived downstream state.
    const wr2pos0 = await Match.findById(wr2pos0Id);
    assert(wr2pos0.player1Id === null && wr2pos0.player2Id.toString() === P("P4")._id.toString() && wr2pos0.status === "PENDING" && wr2pos0.winnerId === null, "WR2pos0 -> TBD vs P4, reset to PENDING");

    const wbFinals = await Match.findById(wbFinalsId);
    assert(wbFinals.player1Id === null && wbFinals.player2Id.toString() === P("P2")._id.toString() && wbFinals.status === "PENDING", "WB Finals -> TBD vs P2, reset to PENDING (P2's own WB Finals seat survives, only the opponent is invalidated)");

    const gfAfter = await Match.findById(gfId);
    assert(gfAfter.player1Id === null && gfAfter.player2Id === null && gfAfter.status === "PENDING" && gfAfter.winnerId === null, "Grand Final -> TBD vs TBD (both finalists trace back to the deleted match) -- reached via TWO cascade paths, only invalidated once");

    const lbR1pos0 = await Match.findById(lbR1pos0Id);
    assert(lbR1pos0.player1Id === null && lbR1pos0.player2Id.toString() === P("P5")._id.toString() && lbR1pos0.status === "PENDING", "Losers Round 1 pos0 -> TBD vs P5");

    const lbR2pos0 = await Match.findById(lbR2pos0Id);
    assert(lbR2pos0.player1Id === null && lbR2pos0.player2Id === null && lbR2pos0.status === "PENDING", "Losers Round 2 pos0 -> TBD vs TBD (convergence point: reached via both P8's LB path and P4's WB-loser path)");

    const lbR3pos0 = await Match.findById(lbR3pos0Id);
    assert(lbR3pos0.player1Id === null && lbR3pos0.player2Id.toString() === P("P7")._id.toString() && lbR3pos0.status === "PENDING", "Losers Round 3 pos0 -> TBD vs P7 (P7's own unrelated LB Round 2 win survives)");

    const lbFinals = await Match.findById(lbFinalsId);
    assert(lbFinals.player1Id === null && lbFinals.player2Id === null && lbFinals.status === "PENDING", "Losers Finals -> TBD vs TBD (second convergence: P8's LB path and P2's WB-Finals-loser path)");

    // Placements: everyone auto-placed goes back to null; P7's manual
    // override survives untouched.
    const entrantsAfter = await Entrant.find({ tournamentId: tournamentA._id });
    const afterByTag = {};
    for (const tag of pTags) {
      const e = entrantsAfter.find(e => e.playerId.toString() === players[tag]._id.toString());
      afterByTag[tag] = e.placement ?? null;
    }
    assert(
      afterByTag.CascadeP1 == null && afterByTag.CascadeP8 == null && afterByTag.CascadeP2 == null && afterByTag.CascadeP4 == null && afterByTag.CascadeP3 == null,
      `Auto placements un-applied after the Grand Final was invalidated (got ${JSON.stringify(afterByTag)})`
    );
    assert(afterByTag.CascadeP7 === 2, "P7's MANUAL placement override survived the cascade untouched");

    await assertNoDanglingReferences(tournamentA._id, "Test A");
    await assertStatsConsistent(pTags.map(t => players[t]._id), "Test A (post-delete)");

    // ═══════════════════════════════════════════════════════════════════
    // TEST B: Grand Finals Reset -- the simplest case (no downstream) --
    // deleted directly. 2-entrant bracket: no Losers bracket at all, so
    // Winners Round 1's loser feeds Grand Final directly as player2.
    // ═══════════════════════════════════════════════════════════════════
    console.log("\n=== TEST B: delete a Grand Finals Reset match directly ===");

    const organizerB = await makeTestPlayer("CascadeTestTOB");
    const organizerCtxB = { playerId: organizerB._id.toString(), role: "USER" };
    createdPlayerTags.push("CascadeTestTOB");
    const q1 = await makeTestPlayer("CascadeQ1");
    const q2 = await makeTestPlayer("CascadeQ2");
    createdPlayerTags.push("CascadeQ1", "CascadeQ2");

    const tournamentB = await Tournament.create({
      name: "Cascade Delete Test B", game: "Test Game", format: "Standard Bracket",
      organizers: [organizerB._id], startDate: new Date(), entrantCount: 2,
    });
    createdTournamentIds.push(tournamentB._id);
    await Entrant.insertMany([q1, q2].map(p => ({ playerId: p._id, tournamentId: tournamentB._id })));

    const bracketB = await resolvers.Mutation.generateBracket(
      null,
      { tournamentId: tournamentB._id.toString(), seedingMethod: "MANUAL", manualSeedOrder: [q1._id.toString(), q2._id.toString()] },
      organizerCtxB
    );

    const wr1B = await Match.findOne({ bracketId: bracketB._id, bracketSide: "WINNERS" });
    await resolvers.Mutation.reportResult(null, { matchId: wr1B._id.toString(), player1Score: 2, player2Score: 0 }, organizerCtxB); // Q1 wins
    const gfB = await Match.findOne({ bracketId: bracketB._id, bracketSide: "GRAND_FINAL" });
    assert(gfB.player1Id.toString() === q1._id.toString() && gfB.player2Id.toString() === q2._id.toString(), "Setup: Grand Final is Q1 (WB) vs Q2 (LB, straight through -- no LB matches in a 2-entrant bracket)");

    // Losers-side finalist (Q2/player2) wins game 1 -> triggers a reset.
    await resolvers.Mutation.reportResult(null, { matchId: gfB._id.toString(), player1Score: 0, player2Score: 2 }, organizerCtxB);
    const resetB = await Match.findOne({ bracketId: bracketB._id, bracketSide: "GRAND_FINAL_RESET" });
    assert(!!resetB, "Setup: Grand Finals Reset was created");
    await resolvers.Mutation.reportResult(null, { matchId: resetB._id.toString(), player1Score: 2, player2Score: 1 }, organizerCtxB); // Q1 takes the decider

    const entrantsBBefore = await Entrant.find({ tournamentId: tournamentB._id });
    const q1PlacementBefore = entrantsBBefore.find(e => e.playerId.toString() === q1._id.toString()).placement;
    assert(q1PlacementBefore === 1, "Setup: placements applied from the RESET (the true decider), Q1 = 1st");

    const resetId = resetB._id.toString();
    await resolvers.Mutation.deleteMatch(null, { id: resetId }, organizerCtxB);
    assert((await Match.findById(resetId)) === null, "The Reset match's own document is gone");

    const gfBAfter = await Match.findById(gfB._id);
    assert(
      gfBAfter.status === "COMPLETED" && gfBAfter.winnerId.toString() === q2._id.toString() &&
      gfBAfter.player1Id.toString() === q1._id.toString() && gfBAfter.player2Id.toString() === q2._id.toString(),
      "No downstream to cascade: Grand Final itself is completely untouched (still shows Q2's game-1 upset)"
    );

    const entrantsBAfter = await Entrant.find({ tournamentId: tournamentB._id });
    const stillPlaced = entrantsBAfter.filter(e => e.placement != null);
    assert(stillPlaced.length === 0, "Both placements un-applied -- bracket reverted to 'awaiting a decider' (no way to infer a winner from Grand Final alone once a reset existed)");

    await assertNoDanglingReferences(tournamentB._id, "Test B");
    await assertStatsConsistent([q1._id, q2._id], "Test B (post-delete)");

    // Recovery check: the bracket is still genuinely functional afterward --
    // editMatchResult is available again (assertBracketMatchEditable no
    // longer sees a reset blocking it) and finalizing Grand Final's own
    // result correctly reaches a fully decided state with fresh placements.
    await resolvers.Mutation.editMatchResult(null, { matchId: gfB._id.toString(), player1Score: 0, player2Score: 2 }, organizerCtxB);
    const entrantsBFinal = await Entrant.find({ tournamentId: tournamentB._id });
    const q2Final = entrantsBFinal.find(e => e.playerId.toString() === q2._id.toString());
    assert(q2Final.placement === 1, "Recovery: correcting Grand Final's result (no reset this time) re-decides the bracket cleanly, Q2 = 1st");

    // ═══════════════════════════════════════════════════════════════════
    // TEST C: pool bracket (no placement side effects) + pools main
    // bracket (placement reset DOES apply) -- covers both bracket kinds
    // sharing this system, per the task's item 6.
    // ═══════════════════════════════════════════════════════════════════
    console.log("\n=== TEST C: Pools + Bracket tournament -- pool bracket and main bracket ===");

    const organizerC = await makeTestPlayer("CascadeTestTOC");
    const organizerCtxC = { playerId: organizerC._id.toString(), role: "USER" };
    createdPlayerTags.push("CascadeTestTOC");
    const cTags = Array.from({ length: 8 }, (_, i) => `CascadePool${i + 1}`);
    const cPlayers = {};
    for (const tag of cTags) {
      cPlayers[tag] = await makeTestPlayer(tag);
      createdPlayerTags.push(tag);
    }

    const tournamentC = await Tournament.create({
      name: "Cascade Delete Test C", game: "Test Game", format: "Pools + Bracket",
      organizers: [organizerC._id], startDate: new Date(), entrantCount: 8,
    });
    createdTournamentIds.push(tournamentC._id);
    await Entrant.insertMany(cTags.map(tag => ({ playerId: cPlayers[tag]._id, tournamentId: tournamentC._id })));

    const pools = await resolvers.Mutation.generatePools(null, { tournamentId: tournamentC._id.toString(), poolCount: 2 }, organizerCtxC);
    assert(pools.length === 2, "Setup: 2 pools of 4 generated");

    const pool1Bracket = await Bracket.findOne({ poolId: pools[0]._id });
    await playBracketP1Wins(organizerCtxC, pool1Bracket._id, { includeGrandFinal: true });

    const pool1EntrantsBefore = await Entrant.find({ _id: { $in: pools[0].entrantIds } });
    assert(pool1EntrantsBefore.every(e => e.placement == null), "Setup: a pool's own Grand Final completing does NOT set tournament-level placement (existing gating, unaffected by this feature)");

    // Delete a completed match inside the POOL bracket -- confirm the
    // cascade works (stats reverse, downstream resets) but still never
    // touches placement, matching the pool-bracket poolId gate.
    const poolWR1 = await Match.findOne({ bracketId: pool1Bracket._id, bracketSide: "WINNERS", bracketRound: 1 });
    const poolWR1Id = poolWR1._id.toString();
    await resolvers.Mutation.deleteMatch(null, { id: poolWR1Id }, organizerCtxC);
    assert((await Match.findById(poolWR1Id)) === null, "Pool bracket: deleted match's document is gone");
    const pool1EntrantsAfter = await Entrant.find({ _id: { $in: pools[0].entrantIds } });
    assert(pool1EntrantsAfter.every(e => e.placement == null), "Pool bracket cascade: still no placement touched for any pool entrant (poolId gate respected)");
    await assertNoDanglingReferences(tournamentC._id, "Test C (pool bracket)");
    await assertStatsConsistent(cTags.map(t => cPlayers[t]._id), "Test C (pool bracket, post-delete)");

    // Finish pool 1 (it's now missing a match, same permanent-hole tradeoff
    // as Test A) and pool 2, then generate the MAIN bracket -- this one DOES
    // apply placements, since it's not pool-scoped.
    const pool2Bracket = await Bracket.findOne({ poolId: pools[1]._id });
    await playBracketP1Wins(organizerCtxC, pool2Bracket._id, { includeGrandFinal: true });

    // Pool 1 can't reach its own Grand Final anymore (permanent hole from
    // the deletion above) -- generateMainBracket requires every pool
    // complete, so this test stops at proving the pool-bracket-delete
    // itself is safe, and separately builds a FRESH pools setup for the
    // main-bracket placement-reset check below.
    console.log("  (Pool 1 intentionally left incomplete post-deletion -- same accepted tradeoff as Test A's mid-bracket hole.)");

    const organizerC2 = await makeTestPlayer("CascadeTestTOC2");
    const organizerCtxC2 = { playerId: organizerC2._id.toString(), role: "USER" };
    createdPlayerTags.push("CascadeTestTOC2");
    const dTags = Array.from({ length: 8 }, (_, i) => `CascadeMain${i + 1}`);
    const dPlayers = {};
    for (const tag of dTags) {
      dPlayers[tag] = await makeTestPlayer(tag);
      createdPlayerTags.push(tag);
    }
    const tournamentD = await Tournament.create({
      name: "Cascade Delete Test C2 (main bracket)", game: "Test Game", format: "Pools + Bracket",
      organizers: [organizerC2._id], startDate: new Date(), entrantCount: 8,
    });
    createdTournamentIds.push(tournamentD._id);
    await Entrant.insertMany(dTags.map(tag => ({ playerId: dPlayers[tag]._id, tournamentId: tournamentD._id })));
    const poolsD = await resolvers.Mutation.generatePools(null, { tournamentId: tournamentD._id.toString(), poolCount: 2 }, organizerCtxC2);
    for (const pool of poolsD) {
      const bracket = await Bracket.findOne({ poolId: pool._id });
      await playBracketP1Wins(organizerCtxC2, bracket._id, { includeGrandFinal: true });
    }
    const mainBracketD = await resolvers.Mutation.generateMainBracket(null, { tournamentId: tournamentD._id.toString(), seedingMethod: "RANDOM" }, organizerCtxC2);
    await playBracketP1Wins(organizerCtxC2, mainBracketD._id, { includeGrandFinal: true });

    const mainGF = await Match.findOne({ bracketId: mainBracketD._id, bracketSide: "GRAND_FINAL" });
    assert(mainGF.status === "COMPLETED", "Setup: main bracket's own Grand Final completed");
    const seedOrderEntrantsBefore = await Entrant.find({ tournamentId: tournamentD._id, playerId: { $in: mainBracketD.seedOrder } });
    assert(seedOrderEntrantsBefore.some(e => e.placement != null), "Setup: main bracket Grand Final DID set placements (unlike a pool's own bracket)");

    const mainWR1 = await Match.findOne({ bracketId: mainBracketD._id, bracketSide: "WINNERS", bracketRound: 1 });
    await resolvers.Mutation.deleteMatch(null, { id: mainWR1._id.toString() }, organizerCtxC2);

    const seedOrderEntrantsAfter = await Entrant.find({ tournamentId: tournamentD._id, playerId: { $in: mainBracketD.seedOrder } });
    assert(seedOrderEntrantsAfter.every(e => e.placement == null), "Main bracket cascade: placements un-applied once its own Grand Final was invalidated (poolId: null gate correctly distinguishes it from a pool's own bracket)");
    await assertNoDanglingReferences(tournamentD._id, "Test C2 (main bracket)");
    await assertStatsConsistent(dTags.map(t => dPlayers[t]._id), "Test C2 (main bracket, post-delete)");

    console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURE(S)`}`);
  } finally {
    console.log("\nCleaning up test data...");
    for (const tournamentId of createdTournamentIds) {
      const pools = await Pool.find({ tournamentId });
      const brackets = await Bracket.find({ tournamentId });
      for (const b of brackets) await Match.deleteMany({ bracketId: b._id });
      await Bracket.deleteMany({ tournamentId });
      await Pool.deleteMany({ tournamentId });
      const entrants = await Entrant.find({ tournamentId });
      const playerIds = entrants.map(e => e.playerId);
      await Entrant.deleteMany({ tournamentId });
      await Tournament.findByIdAndDelete(tournamentId);
      const players = await Player.find({ _id: { $in: playerIds } });
      const userIds = players.map(p => p.userId).filter(Boolean);
      await Player.deleteMany({ _id: { $in: playerIds } });
      await User.deleteMany({ _id: { $in: userIds } });
    }
    const orgPlayers = await Player.find({ tag: { $in: createdPlayerTags } });
    const orgUserIds = orgPlayers.map(p => p.userId).filter(Boolean);
    await Player.deleteMany({ tag: { $in: createdPlayerTags } });
    await User.deleteMany({ _id: { $in: orgUserIds } });
    console.log("Cleanup done.");
  }

  await mongooseInstance.disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
