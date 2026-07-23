// scripts/testPoolsFeature.mjs
//
// Functional verification for the Pool play + top-cut bracket feature.
// Calls the REAL GraphQL resolver functions (imported from
// graphql/resolvers/index.ts, not reimplemented) against real test data in
// the actual database — the same code path the GraphQL API itself runs,
// just skipping the HTTP/NextAuth-cookie layer (which the pools feature
// doesn't touch). Entrant/organizer/tournament setup writes directly via
// Mongoose models, mirroring scripts/seedBracketSimulation.js's established
// pattern, to avoid rate limits and the 24h-account-age gate on
// createTournament.
//
// Run: npx tsx scripts/testPoolsFeature.mjs

// graphql/resolvers/index.ts transitively imports lib/email.ts, which
// constructs `new Resend(process.env.RESEND_API_KEY)` at MODULE LOAD time —
// so .env.local must be loaded before that import even happens. ESM static
// imports are hoisted above any code in this file, so everything that
// (transitively) needs env vars is imported dynamically, after loadEnvLocal()
// runs. fs/path/bcrypt/mongoose don't read env vars at import time, so those
// stay as normal static imports.
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

const { Types } = await import("mongoose");
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

// Plays every currently-ready match on one bracket side/round via the REAL
// reportResult resolver (not advanceBracketMatch directly) — mirrors what a
// TO reporting results through the UI actually triggers.
async function playRound(organizerCtx, bracketId, bracketSide, bracketRound) {
  const ready = await Match.find({
    bracketId,
    bracketSide,
    bracketRound,
    status: "PENDING",
    player1Id: { $ne: null },
    player2Id: { $ne: null },
  });
  for (const match of ready) {
    const player1Wins = Math.random() < 0.5;
    await resolvers.Mutation.reportResult(
      null,
      { matchId: match._id.toString(), player1Score: player1Wins ? 2 : 0, player2Score: player1Wins ? 0 : 2 },
      organizerCtx
    );
  }
  return ready.length;
}

// Plays an entire bracket to completion (WB/LB alternating rounds, then
// Grand Final, then Reset if one gets created) via reportResult.
async function playBracketToCompletion(organizerCtx, bracketId) {
  for (let round = 1; round <= 10; round++) {
    const wbPlayed = await playRound(organizerCtx, bracketId, "WINNERS", round);
    const lbPlayed = await playRound(organizerCtx, bracketId, "LOSERS", round);
    if (wbPlayed === 0 && lbPlayed === 0) break;
  }
  // Grand Final
  const gf = await Match.findOne({ bracketId, bracketSide: "GRAND_FINAL" });
  if (gf && gf.status === "PENDING" && gf.player1Id && gf.player2Id) {
    // Force the losers-finalist (player2) to win game 1, to exercise the
    // bracket-reset path at least once across the whole test run.
    await resolvers.Mutation.reportResult(null, { matchId: gf._id.toString(), player1Score: 0, player2Score: 2 }, organizerCtx);
  }
  const reset = await Match.findOne({ bracketId, bracketSide: "GRAND_FINAL_RESET" });
  if (reset && reset.status === "PENDING") {
    await resolvers.Mutation.reportResult(null, { matchId: reset._id.toString(), player1Score: 2, player2Score: 0 }, organizerCtx);
  }
}

async function main() {
  const mongooseInstance = await connectToDatabase();

  const createdTournamentIds = [];

  try {
    // ═══════════════════════════════════════════════════════════════════
    // TEST 1: 34-entrant Pools + Bracket tournament, 5 pools (uneven split:
    // 7,7,7,7,6 — none a power of 2, exercising within-pool byes), played
    // through to a real main bracket with AVOID_SAME_POOL seeding.
    // ═══════════════════════════════════════════════════════════════════
    console.log("\n=== TEST 1: 34 entrants, 5 pools, AVOID_SAME_POOL main bracket ===");

    const organizer1 = await makeTestPlayer("PoolsTestTO1");
    const organizerCtx1 = { playerId: organizer1._id.toString(), role: "USER" };

    const entrantPlayers1 = [];
    for (let i = 1; i <= 34; i++) entrantPlayers1.push(await makeTestPlayer(`PoolsT1P${String(i).padStart(2, "0")}`));

    const tournament1 = await Tournament.create({
      name: "Pools Feature Test 1",
      game: "Test Game",
      format: "Pools + Bracket",
      organizers: [organizer1._id],
      startDate: new Date(),
      entrantCount: entrantPlayers1.length,
    });
    createdTournamentIds.push(tournament1._id);

    await Entrant.insertMany(entrantPlayers1.map(p => ({ playerId: p._id, tournamentId: tournament1._id })));

    // Suggested pool count sanity check (targets ~6-8/pool -> 34/7 ~= 5)
    const suggested1 = resolvers.Tournament.suggestedPoolCount({ entrantCount: 34 });
    assert(suggested1 === 5, `suggestedPoolCount(34) === 5 (got ${suggested1})`);

    const pools1 = await resolvers.Mutation.generatePools(null, { tournamentId: tournament1._id.toString(), poolCount: 5 }, organizerCtx1);
    assert(pools1.length === 5, `generatePools created 5 pools (got ${pools1.length})`);

    const poolSizes = [];
    for (const pool of pools1) {
      const entrants = await resolvers.Pool.entrants(pool);
      poolSizes.push(entrants.length);
      const bracket = await resolvers.Pool.bracket(pool);
      assert(!!bracket, `Pool ${pool.poolNumber} has a Bracket`);
      const expectedSize = entrants.length <= 4 ? 4 : entrants.length <= 8 ? 8 : 16;
      assert(bracket.size === expectedSize, `Pool ${pool.poolNumber} bracket size ${bracket.size} matches ${entrants.length} entrants (expected ${expectedSize})`);
    }
    const totalEntrants = poolSizes.reduce((a, b) => a + b, 0);
    assert(totalEntrants === 34, `Pool sizes sum to 34 entrants (got ${totalEntrants}, sizes=${poolSizes.join(",")})`);
    assert(poolSizes.every(s => s === 7 || s === 6), `Pool sizes are all 6 or 7 (even split of 34/5) — got ${poolSizes.join(",")}`);

    // Play pool 1 and pool 2 fully to completion via reportResult.
    for (const pool of pools1.slice(0, 2)) {
      const bracket = await Bracket.findOne({ poolId: pool._id });
      await playBracketToCompletion(organizerCtx1, bracket._id);
    }

    // Verify advancement identification for pool 1: the 2 Grand Final
    // participants (player1 = winners-finalist, player2 = losers-finalist).
    const pool1Bracket = await Bracket.findOne({ poolId: pools1[0]._id });
    const pool1GF = await Match.findOne({ bracketId: pool1Bracket._id, bracketSide: "GRAND_FINAL" });
    assert(pool1GF && pool1GF.status === "COMPLETED", "Pool 1 Grand Final reached COMPLETED");
    assert(!!pool1GF.player1Id && !!pool1GF.player2Id, "Pool 1 Grand Final has both a winners-finalist and losers-finalist");

    // Verify the placement-gating fix: pool completions must NOT have
    // written tournament-level Entrant.placement for pool 1/2's entrants.
    const pool1EntrantDocs = await Entrant.find({ _id: { $in: pools1[0].entrantIds } });
    const anyPlacementSet = pool1EntrantDocs.some(e => e.placement != null);
    assert(!anyPlacementSet, "Pool 1 completing did NOT set tournament-level Entrant.placement (gating fix works)");

    // allPoolsComplete should be false — only 2/5 pools played.
    const allCompleteEarly = await resolvers.Tournament.allPoolsComplete({ _id: tournament1._id });
    assert(allCompleteEarly === false, "allPoolsComplete is false with only 2/5 pools finished");

    // generateMainBracket should be rejected while pools are incomplete.
    let rejectedEarly = false;
    try {
      await resolvers.Mutation.generateMainBracket(null, { tournamentId: tournament1._id.toString(), seedingMethod: "RANDOM" }, organizerCtx1);
    } catch {
      rejectedEarly = true;
    }
    assert(rejectedEarly, "generateMainBracket correctly rejected before all pools finish");

    // Play the remaining 3 pools.
    for (const pool of pools1.slice(2)) {
      const bracket = await Bracket.findOne({ poolId: pool._id });
      await playBracketToCompletion(organizerCtx1, bracket._id);
    }

    const allCompleteNow = await resolvers.Tournament.allPoolsComplete({ _id: tournament1._id });
    assert(allCompleteNow === true, "allPoolsComplete is true once every pool's Grand Final has completed");

    // Collect expected winners/losers-finalists directly from each pool's
    // Grand Final, independent of the resolver, to cross-check seeding.
    const expectedWinnersFinalists = new Set();
    const expectedLosersFinalists = new Set();
    for (const pool of pools1) {
      const b = await Bracket.findOne({ poolId: pool._id });
      const gf = await Match.findOne({ bracketId: b._id, bracketSide: "GRAND_FINAL" });
      expectedWinnersFinalists.add(gf.player1Id.toString());
      expectedLosersFinalists.add(gf.player2Id.toString());
    }

    const mainBracket1 = await resolvers.Mutation.generateMainBracket(
      null,
      { tournamentId: tournament1._id.toString(), seedingMethod: "AVOID_SAME_POOL" },
      organizerCtx1
    );
    assert(!!mainBracket1, "generateMainBracket succeeded once all pools finished");
    assert(mainBracket1.seedOrder.length === 10, `Main bracket has 10 advancers (2x5 pools) — got ${mainBracket1.seedOrder.length}`);
    const seedOrderStrs = mainBracket1.seedOrder.map(id => id.toString());
    const firstHalf = seedOrderStrs.slice(0, 5);
    const secondHalf = seedOrderStrs.slice(5);
    assert(
      firstHalf.every(id => expectedWinnersFinalists.has(id)) && secondHalf.every(id => expectedLosersFinalists.has(id)),
      "AVOID_SAME_POOL seeding places all winners-finalists first, all losers-finalists second"
    );
    assert(mainBracket1.poolId == null, "Main bracket has poolId === null (not pool-scoped)");

    const tourAfterMain1 = await Tournament.findById(tournament1._id);
    assert(tourAfterMain1.mainBracketId?.toString() === mainBracket1._id.toString(), "Tournament.mainBracketId set to the new main bracket");

    const mainBracketField1 = await resolvers.Tournament.mainBracket({ mainBracketId: tourAfterMain1.mainBracketId });
    assert(mainBracketField1?._id.toString() === mainBracket1._id.toString(), "Tournament.mainBracket field resolver returns the main bracket");

    // Calling generateMainBracket again should be rejected (already generated).
    let rejectedTwice = false;
    try {
      await resolvers.Mutation.generateMainBracket(null, { tournamentId: tournament1._id.toString(), seedingMethod: "RANDOM" }, organizerCtx1);
    } catch {
      rejectedTwice = true;
    }
    assert(rejectedTwice, "generateMainBracket correctly rejected once already generated");

    // Standard generateBracket/deleteBracket must be blocked for this format.
    let blockedGenerate = false;
    try {
      await resolvers.Mutation.generateBracket(null, { tournamentId: tournament1._id.toString(), seedingMethod: "RANDOM" }, organizerCtx1);
    } catch {
      blockedGenerate = true;
    }
    assert(blockedGenerate, "generateBracket (standard mutation) is blocked for a Pools + Bracket tournament");

    let blockedDelete = false;
    try {
      await resolvers.Mutation.deleteBracket(null, { tournamentId: tournament1._id.toString() }, organizerCtx1);
    } catch {
      blockedDelete = true;
    }
    assert(blockedDelete, "deleteBracket (standard mutation) is blocked for a Pools + Bracket tournament");

    // Play the main bracket a couple rounds + one editMatchResult correction
    // + one forfeit, to touch those paths too.
    const wbR1Matches = await Match.find({ bracketId: mainBracket1._id, bracketSide: "WINNERS", bracketRound: 1 });
    if (wbR1Matches.length > 0) {
      const m = wbR1Matches[0];
      await resolvers.Mutation.reportResult(null, { matchId: m._id.toString(), player1Score: 2, player2Score: 1 }, organizerCtx1);
      const corrected = await resolvers.Mutation.editMatchResult(
        null,
        { matchId: m._id.toString(), player1Score: 0, player2Score: 2 },
        organizerCtx1
      );
      assert(corrected.player2Score === 2 && corrected.winnerId.toString() === m.player2Id.toString(), "editMatchResult correction re-ran advancement with the corrected winner");
    }
    if (wbR1Matches.length > 1) {
      const m = wbR1Matches[1];
      const forfeited = await resolvers.Mutation.reportResult(
        null,
        { matchId: m._id.toString(), isForfeit: true, forfeitingPlayerId: m.player1Id.toString() },
        organizerCtx1
      );
      assert(forfeited.isForfeit === true, "Forfeit path works on a main-bracket match");
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEST 2: 16-entrant Pools + Bracket tournament, 4 pools of 4 (clean
    // power-of-2 split, byes-free at every stage), full run with RANDOM
    // main-bracket seeding.
    // ═══════════════════════════════════════════════════════════════════
    console.log("\n=== TEST 2: 16 entrants, 4 pools of 4, RANDOM main bracket ===");

    const organizer2 = await makeTestPlayer("PoolsTestTO2");
    const organizerCtx2 = { playerId: organizer2._id.toString(), role: "USER" };
    const entrantPlayers2 = [];
    for (let i = 1; i <= 16; i++) entrantPlayers2.push(await makeTestPlayer(`PoolsT2P${String(i).padStart(2, "0")}`));

    const tournament2 = await Tournament.create({
      name: "Pools Feature Test 2",
      game: "Test Game",
      format: "Pools + Bracket",
      organizers: [organizer2._id],
      startDate: new Date(),
      entrantCount: entrantPlayers2.length,
    });
    createdTournamentIds.push(tournament2._id);
    await Entrant.insertMany(entrantPlayers2.map(p => ({ playerId: p._id, tournamentId: tournament2._id })));

    // Explicit poolCount: 4 (the TO overriding the auto-suggestion), to
    // exercise the "clean power-of-2 pool count" path deliberately — the
    // auto-suggestion itself (targeting ~6-8/pool) is separately verified
    // above via suggestedPoolCount(34) === 5; for 16 entrants it would
    // suggest 2 pools of 8, which is correct but not what this test wants.
    const pools2 = await resolvers.Mutation.generatePools(null, { tournamentId: tournament2._id.toString(), poolCount: 4 }, organizerCtx2);
    assert(pools2.length === 4, `generatePools(poolCount: 4) created 4 pools for 16 entrants (got ${pools2.length})`);
    const suggested2 = resolvers.Tournament.suggestedPoolCount({ entrantCount: 16 });
    assert(suggested2 === 2, `suggestedPoolCount(16) === 2 (targets ~6-8/pool) (got ${suggested2})`);

    for (const pool of pools2) {
      const bracket = await Bracket.findOne({ poolId: pool._id });
      await playBracketToCompletion(organizerCtx2, bracket._id);
    }

    const mainBracket2 = await resolvers.Mutation.generateMainBracket(
      null,
      { tournamentId: tournament2._id.toString(), seedingMethod: "RANDOM" },
      organizerCtx2
    );
    assert(mainBracket2.seedOrder.length === 8, `Main bracket has 8 advancers (2x4 pools) — got ${mainBracket2.seedOrder.length}`);
    assert(mainBracket2.size === 8, `Main bracket size is 8 (byes-free, since 2x4 is already a power of 2) — got ${mainBracket2.size}`);

    // ═══════════════════════════════════════════════════════════════════
    // TEST 3: standard (non-pools) tournament — confirm completely
    // unaffected regression-free flow through the existing mutations.
    // ═══════════════════════════════════════════════════════════════════
    console.log("\n=== TEST 3: standard tournament regression check ===");

    const organizer3 = await makeTestPlayer("PoolsTestTO3");
    const organizerCtx3 = { playerId: organizer3._id.toString(), role: "USER" };
    const entrantPlayers3 = [];
    for (let i = 1; i <= 9; i++) entrantPlayers3.push(await makeTestPlayer(`StdT3P${String(i).padStart(2, "0")}`));

    const tournament3 = await Tournament.create({
      name: "Standard Regression Test",
      game: "Test Game",
      format: "Standard Bracket",
      organizers: [organizer3._id],
      startDate: new Date(),
      entrantCount: entrantPlayers3.length,
    });
    createdTournamentIds.push(tournament3._id);
    await Entrant.insertMany(entrantPlayers3.map(p => ({ playerId: p._id, tournamentId: tournament3._id })));

    const standardBracket = await resolvers.Mutation.generateBracket(
      null,
      { tournamentId: tournament3._id.toString(), seedingMethod: "RANDOM" },
      organizerCtx3
    );
    assert(!!standardBracket, "Standard tournament: generateBracket still works directly");
    assert(standardBracket.poolId == null, "Standard tournament's bracket has poolId === null");

    await playBracketToCompletion(organizerCtx3, standardBracket._id);
    const std3Entrants = await Entrant.find({ tournamentId: tournament3._id });
    assert(std3Entrants.some(e => e.placement === 1), "Standard tournament: placements ARE set automatically on its own Grand Final completion (unlike a pool bracket)");

    const poolsFieldStd = await resolvers.Tournament.pools({ _id: tournament3._id });
    assert(poolsFieldStd.length === 0, "Standard tournament's Tournament.pools field resolves empty");
    const allCompleteStd = await resolvers.Tournament.allPoolsComplete({ _id: tournament3._id });
    assert(allCompleteStd === false, "Standard tournament's Tournament.allPoolsComplete is false (no pools)");

    let deleted = await resolvers.Mutation.deleteBracket(null, { tournamentId: tournament3._id.toString() }, organizerCtx3);
    assert(deleted === true, "Standard tournament: deleteBracket still works");

    console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURE(S)`}`);
  } finally {
    // ── Cleanup: remove every doc this run created ──────────────────────
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
    // Organizers too.
    const orgTags = ["PoolsTestTO1", "PoolsTestTO2", "PoolsTestTO3"];
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
