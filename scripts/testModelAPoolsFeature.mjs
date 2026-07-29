// scripts/testModelAPoolsFeature.mjs
//
// Functional verification for Pool format Model A (round-robin pools, fresh
// bracket restart). Same approach as scripts/testPoolsFeature.mjs — calls
// the REAL GraphQL resolver functions against real test data in the actual
// database, not a reimplementation of the logic under test.
//
// Covers: uneven-size round-robin pool generation (5 + 4 entrants), a
// deterministic 3-way tie broken entirely by the games-won tiebreaker (pool
// 1), a genuine cyclic 3-way tie that only random can break (pool 2, the
// "head-to-head is itself tied" case), correct top-2 advancement per pool,
// a fresh 2nd-stage bracket generated from those advancers, and a final
// regression check that a default (Model C) Pools + Bracket tournament is
// completely unaffected by any of this.
//
// Run: npx tsx scripts/testModelAPoolsFeature.mjs

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
const { nextPowerOfTwo } = await import("../lib/bracket");
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

// pool.entrantIds preserves the exact order generatePools built it in (the
// same order buildRoundRobinMatches received as playerIds), so resolving
// each id to its Entrant (in that same array order) gives a stable
// "position within this pool" independent of the internal shuffle — the
// test's match plan is written against these positions, not real player
// identities, since which named player lands where is randomized.
async function poolPositionPlayerIds(pool) {
  const entrantDocs = await Promise.all(pool.entrantIds.map(id => Entrant.findById(id)));
  return entrantDocs.map(e => e.playerId.toString());
}

async function reportPoolMatch(organizerCtx, poolId, positionPlayerIds, posA, posB, scoreA, scoreB) {
  const pA = positionPlayerIds[posA];
  const pB = positionPlayerIds[posB];
  const match = await Match.findOne({
    poolId,
    $or: [
      { player1Id: pA, player2Id: pB },
      { player1Id: pB, player2Id: pA },
    ],
  });
  if (!match) throw new Error(`No pool match found between position ${posA} and ${posB}`);
  const player1IsA = match.player1Id.toString() === pA;
  const player1Score = player1IsA ? scoreA : scoreB;
  const player2Score = player1IsA ? scoreB : scoreA;
  return resolvers.Mutation.reportResult(null, { matchId: match._id.toString(), player1Score, player2Score }, organizerCtx);
}

async function main() {
  const mongooseInstance = await connectToDatabase();
  const createdTournamentIds = [];

  try {
    // ═══════════════════════════════════════════════════════════════════
    // TEST 1: 9-entrant Model A tournament, uneven pools (5 + 4).
    // ═══════════════════════════════════════════════════════════════════
    console.log("\n=== TEST 1: Model A, 9 entrants, uneven pools (5 + 4) ===");

    const organizer = await makeTestPlayer("ModelATestTO");
    const organizerCtx = { playerId: organizer._id.toString(), role: "USER" };

    const entrantPlayers = [];
    for (let i = 1; i <= 9; i++) entrantPlayers.push(await makeTestPlayer(`ModelAP${String(i).padStart(2, "0")}`));

    const tournament = await Tournament.create({
      name: "Model A Pools Test",
      game: "Test Game",
      format: "Pools + Bracket",
      poolModel: "A",
      organizers: [organizer._id],
      startDate: new Date(),
      entrantCount: entrantPlayers.length,
    });
    createdTournamentIds.push(tournament._id);
    await Entrant.insertMany(entrantPlayers.map(p => ({ playerId: p._id, tournamentId: tournament._id })));

    assert(
      resolvers.Tournament.poolModel({ poolModel: "A" }) === "A" && resolvers.Tournament.poolModel({}) === "C",
      "Tournament.poolModel resolver: explicit 'A' passes through, missing coalesces to 'C'"
    );

    const pools = await resolvers.Mutation.generatePools(null, { tournamentId: tournament._id.toString(), poolCount: 2 }, organizerCtx);
    assert(pools.length === 2, `generatePools created 2 pools (got ${pools.length})`);

    const sizes = pools.map(p => p.entrantIds.length).sort((a, b) => b - a);
    assert(sizes[0] === 5 && sizes[1] === 4, `Uneven split of 9 entrants into 5 + 4 (got ${sizes.join(",")})`);

    for (const pool of pools) {
      const bracket = await resolvers.Pool.bracket(pool);
      assert(!bracket, `Pool ${pool.poolNumber} has NO Bracket document (round-robin, not double-elim)`);
      const matches = await resolvers.Pool.matches(pool);
      const expectedMatchCount = (pool.entrantIds.length * (pool.entrantIds.length - 1)) / 2;
      assert(
        matches.length === expectedMatchCount,
        `Pool ${pool.poolNumber} (${pool.entrantIds.length} entrants) has ${expectedMatchCount} round-robin matches (got ${matches.length})`
      );
      // Round-robin: every match already has both players from the start —
      // nothing is TBD the way an early bracket round's later slots are.
      assert(matches.every(m => m.player1Id && m.player2Id), `Pool ${pool.poolNumber}'s matches all have both players assigned upfront`);
    }

    const pool5 = pools.find(p => p.entrantIds.length === 5);
    const pool4 = pools.find(p => p.entrantIds.length === 4);

    // ── Pool of 5: deterministic 3-way tie, broken entirely by games-won ──
    // Position 0 sweeps (4-0) — uncontested rank 1. Position 4 loses out
    // (0-4) — uncontested last. Positions 1/2/3 all finish 2-2 (a genuine
    // 3-way tie on match-wins), with games-won deliberately made distinct
    // (6/4/5) so the tiebreaker alone determines final order: 1 > 3 > 2.
    const p5 = await poolPositionPlayerIds(pool5);
    await reportPoolMatch(organizerCtx, pool5._id, p5, 0, 1, 2, 0);
    await reportPoolMatch(organizerCtx, pool5._id, p5, 0, 2, 2, 0);
    await reportPoolMatch(organizerCtx, pool5._id, p5, 0, 3, 2, 0);
    await reportPoolMatch(organizerCtx, pool5._id, p5, 0, 4, 2, 0);
    await reportPoolMatch(organizerCtx, pool5._id, p5, 1, 2, 2, 0);
    await reportPoolMatch(organizerCtx, pool5._id, p5, 3, 1, 2, 1);
    await reportPoolMatch(organizerCtx, pool5._id, p5, 1, 4, 3, 1);
    await reportPoolMatch(organizerCtx, pool5._id, p5, 2, 3, 2, 1);
    await reportPoolMatch(organizerCtx, pool5._id, p5, 2, 4, 2, 0);
    await reportPoolMatch(organizerCtx, pool5._id, p5, 3, 4, 2, 0);

    const standings5 = await resolvers.Pool.standings(pool5);
    const order5 = standings5.map(row => p5.indexOf(row.entrant.playerId.toString()));
    assert(
      JSON.stringify(order5) === JSON.stringify([0, 1, 3, 2, 4]),
      `Pool of 5 standings order is [1st, 2nd, 3rd-by-games, 4th-by-games, last] = positions [0,1,3,2,4] (got ${JSON.stringify(order5)})`
    );
    assert(
      standings5[1].matchWins === 2 && standings5[2].matchWins === 2 && standings5[3].matchWins === 2,
      "Pool of 5: positions 1/2/3 are genuinely tied on match-wins (2 each) before the games-won tiebreak"
    );
    assert(
      standings5[1].gamesWon === 6 && standings5[2].gamesWon === 5 && standings5[3].gamesWon === 4,
      `Pool of 5: games-won tiebreak resolved the 3-way tie in strict descending order (got ${standings5[1].gamesWon},${standings5[2].gamesWon},${standings5[3].gamesWon})`
    );

    // ── Pool of 4: genuine 3-way CYCLE (rock-paper-scissors) among
    // positions 0/1/2 — each beats exactly one and loses to exactly one of
    // the other two, so match-wins (2 each), games-won (4 each), AND the
    // within-group head-to-head sub-wins (1 each) are all tied. Only the
    // final random tiebreaker can resolve it. Position 3 loses every match
    // (0 wins) and must never advance.
    const p4 = await poolPositionPlayerIds(pool4);
    await reportPoolMatch(organizerCtx, pool4._id, p4, 0, 1, 2, 0);
    await reportPoolMatch(organizerCtx, pool4._id, p4, 2, 0, 2, 0);
    await reportPoolMatch(organizerCtx, pool4._id, p4, 0, 3, 2, 0);
    await reportPoolMatch(organizerCtx, pool4._id, p4, 1, 2, 2, 0);
    await reportPoolMatch(organizerCtx, pool4._id, p4, 1, 3, 2, 0);
    await reportPoolMatch(organizerCtx, pool4._id, p4, 2, 3, 2, 0);

    const standings4 = await resolvers.Pool.standings(pool4);
    const tiedTrioPositions = new Set([0, 1, 2]);
    assert(
      standings4.slice(0, 3).every(row => tiedTrioPositions.has(p4.indexOf(row.entrant.playerId.toString()))),
      "Pool of 4: the cyclic 3-way tie (positions 0/1/2) occupies ranks 1-3, in SOME order (random tiebreak)"
    );
    assert(
      p4.indexOf(standings4[3].entrant.playerId.toString()) === 3,
      "Pool of 4: position 3 (0 wins) correctly ranked last, excluded from the tie"
    );
    assert(
      standings4[0].matchWins === 2 && standings4[1].matchWins === 2 && standings4[2].matchWins === 2 && standings4[3].matchWins === 0,
      "Pool of 4: standings' win counts match the constructed cycle (2,2,2,0)"
    );

    // ── allPoolsComplete + generateMainBracket gating ──────────────────
    const allComplete = await resolvers.Tournament.allPoolsComplete({ _id: tournament._id });
    assert(allComplete === true, "allPoolsComplete is true once every round-robin match has been reported");

    const mainBracket = await resolvers.Mutation.generateMainBracket(
      null,
      { tournamentId: tournament._id.toString(), seedingMethod: "AVOID_SAME_POOL" },
      organizerCtx
    );
    assert(!!mainBracket, "generateMainBracket succeeded from round-robin standings");
    assert(mainBracket.seedOrder.length === 4, `Main bracket has 4 advancers (2x2 pools) — got ${mainBracket.seedOrder.length}`);
    assert(mainBracket.size === nextPowerOfTwo(4), `Main bracket size is ${nextPowerOfTwo(4)} — got ${mainBracket.size}`);
    assert(mainBracket.poolId == null, "Main bracket has poolId === null (not pool-scoped)");

    const seedOrderStrs = mainBracket.seedOrder.map(id => id.toString());
    const seedOrderSet = new Set(seedOrderStrs);
    const pool1FirstId = p5[0]; // deterministic rank-1 of pool of 5
    const pool1SecondId = p5[1]; // deterministic rank-2 of pool of 5
    const pool2TrioIds = new Set([p4[0], p4[1], p4[2]]);
    const pool2LastId = p4[3];

    assert(seedOrderSet.has(pool1FirstId) && seedOrderSet.has(pool1SecondId), "Main bracket seed order includes both of pool 1's (deterministic) advancers");
    assert(!seedOrderSet.has(p5[2]) && !seedOrderSet.has(p5[3]) && !seedOrderSet.has(p5[4]), "Main bracket seed order excludes every pool-1 non-advancer");
    assert(!seedOrderSet.has(pool2LastId), "Main bracket seed order excludes pool 2's clear last-place entrant");
    const otherTwo = seedOrderStrs.filter(id => id !== pool1FirstId && id !== pool1SecondId);
    assert(
      otherTwo.length === 2 && otherTwo.every(id => pool2TrioIds.has(id)),
      "Main bracket seed order's other 2 slots are exactly 2 of pool 2's tied trio"
    );
    // AVOID_SAME_POOL: first half = every pool's rank-1 advancer, second
    // half = every pool's rank-2 advancer — pool 1's deterministic ranks
    // let this be checked precisely regardless of pool 2's random pick.
    assert(seedOrderStrs.slice(0, 2).includes(pool1FirstId), "Pool 1's rank-1 advancer landed in the low-seed (winners-finalist) half");
    assert(seedOrderStrs.slice(2, 4).includes(pool1SecondId), "Pool 1's rank-2 advancer landed in the high-seed (losers-finalist) half");

    // ═══════════════════════════════════════════════════════════════════
    // TEST 2: Model C regression — default pool model, same tournament
    // shape, confirmed completely unaffected by any Model A code path.
    // ═══════════════════════════════════════════════════════════════════
    console.log("\n=== TEST 2: Model C (default) unaffected regression check ===");

    const organizerC = await makeTestPlayer("ModelCRegressionTO");
    const organizerCtxC = { playerId: organizerC._id.toString(), role: "USER" };
    const entrantPlayersC = [];
    for (let i = 1; i <= 8; i++) entrantPlayersC.push(await makeTestPlayer(`ModelCP${String(i).padStart(2, "0")}`));

    // poolModel intentionally omitted -- must default to "C" and behave
    // exactly like every pre-existing Pools + Bracket tournament.
    const tournamentC = await Tournament.create({
      name: "Model C Regression Test",
      game: "Test Game",
      format: "Pools + Bracket",
      organizers: [organizerC._id],
      startDate: new Date(),
      entrantCount: entrantPlayersC.length,
    });
    createdTournamentIds.push(tournamentC._id);
    await Entrant.insertMany(entrantPlayersC.map(p => ({ playerId: p._id, tournamentId: tournamentC._id })));

    assert(
      resolvers.Tournament.poolModel({ poolModel: tournamentC.poolModel }) === "C",
      "Omitted poolModel at creation resolves to 'C' end-to-end"
    );

    const poolsC = await resolvers.Mutation.generatePools(null, { tournamentId: tournamentC._id.toString(), poolCount: 2 }, organizerCtxC);
    assert(poolsC.length === 2, "Model C: generatePools still creates 2 pools");

    for (const pool of poolsC) {
      const bracket = await resolvers.Pool.bracket(pool);
      assert(!!bracket, `Model C: Pool ${pool.poolNumber} HAS its own double-elim Bracket (unchanged behavior)`);
      const matches = await resolvers.Pool.matches(pool);
      assert(matches.length === 0, `Model C: Pool ${pool.poolNumber}.matches (round-robin field) is empty — its matches live on the bracket instead`);
      const standings = await resolvers.Pool.standings(pool);
      assert(standings === null, `Model C: Pool ${pool.poolNumber}.standings is null (no round-robin data to rank)`);

      // Play the pool's own double-elim bracket to completion via reportResult.
      for (let round = 1; round <= 6; round++) {
        const ready = await Match.find({ bracketId: bracket._id, status: "PENDING", player1Id: { $ne: null }, player2Id: { $ne: null } });
        if (ready.length === 0) break;
        for (const m of ready) {
          const p1Wins = Math.random() < 0.5;
          await resolvers.Mutation.reportResult(null, { matchId: m._id.toString(), player1Score: p1Wins ? 2 : 0, player2Score: p1Wins ? 0 : 2 }, organizerCtxC);
        }
      }
      const gf = await Match.findOne({ bracketId: bracket._id, bracketSide: "GRAND_FINAL" });
      if (gf && gf.status === "PENDING") {
        await resolvers.Mutation.reportResult(null, { matchId: gf._id.toString(), player1Score: 2, player2Score: 0 }, organizerCtxC);
      }
    }

    const allCompleteC = await resolvers.Tournament.allPoolsComplete({ _id: tournamentC._id });
    assert(allCompleteC === true, "Model C: allPoolsComplete true once every pool's Grand Final completes (existing behavior)");

    const mainBracketC = await resolvers.Mutation.generateMainBracket(null, { tournamentId: tournamentC._id.toString(), seedingMethod: "RANDOM" }, organizerCtxC);
    assert(!!mainBracketC && mainBracketC.seedOrder.length === 4, "Model C: generateMainBracket still works, seeded from Grand Final finalists (unchanged)");

    console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURE(S)`}`);
  } finally {
    console.log("\nCleaning up test data...");
    for (const tournamentId of createdTournamentIds) {
      const pools = await Pool.find({ tournamentId });
      const brackets = await Bracket.find({ tournamentId });
      for (const b of brackets) await Match.deleteMany({ bracketId: b._id });
      for (const p of pools) await Match.deleteMany({ poolId: p._id });
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
    const orgTags = ["ModelATestTO", "ModelCRegressionTO"];
    const orgPlayers = await Player.find({ tag: { $in: orgTags } });
    const orgUserIds = orgPlayers.map(p => p.userId).filter(Boolean);
    await Player.deleteMany({ tag: { $in: orgTags } });
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
