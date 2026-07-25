// scripts/testModelBPoolsFeature.mjs
//
// Functional verification for Pool format Model B, Phase 4: the new
// generateModelBPools mutation (graphql/resolvers/index.ts) that persists
// Model B's Round 1 to the real database. Same approach as
// scripts/testModelAPoolsFeature.mjs / testPoolsFeature.mjs — calls the REAL
// GraphQL resolver functions against real test data in the actual database,
// not a reimplementation of the logic under test.
//
// Round 1 is structurally identical to a normal Model A/C pool round (flat
// entrant list -> a real Pool + its own double-elimination Bracket/Match
// documents, via the exact same buildDoubleEliminationBracket + DB-write
// pattern generatePools already uses) -- so this test reuses the same
// invariant checks testModelAPoolsFeature.mjs's own Model C regression
// section already established (Pool.bracket exists, bracket.size matches
// entrant count, Pool.matches/standings are the round-robin-only fields and
// stay empty/null here).
//
// Entrants are synthetic (plain ObjectIds with no backing Player/User
// document -- Entrant.playerId is an unenforced ref, same latitude
// scripts/testRepooledBracket.mjs's Phase 3 tests took) rather than real
// registered players, since real identities aren't essential at this scale
// -- only one real Player (the organizer) is needed, for the auth check.
//
// TEST 1: 200 synthetic entrants -- confirms the correct initial pool count
// (power-of-two, ~15/pool), an even entrant distribution across pools, and
// that every pool got a well-formed double-elimination Bracket + Match set.
//
// TEST 2: the below-128 guard (50 synthetic entrants) correctly rejects
// generation rather than silently running Model B on a field too small for
// it.
//
// TEST 3: the wrong-pool-model guard -- calling generateModelBPools against
// a Model C tournament (even with >=128 entrants) is rejected, confirming
// this mutation is genuinely scoped to poolModel "B" and doesn't silently
// reuse another tournament's pool stage.
//
// Run: npx tsx scripts/testModelBPoolsFeature.mjs

import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import { Types } from "mongoose";

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
const { nextPowerOfTwo, computeModelBInitialPoolCount, MODEL_B_MIN_ENTRANTS } = await import("../lib/bracket");
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

function synthesizeEntrants(tournamentId, count) {
  return Array.from({ length: count }, () => ({ playerId: new Types.ObjectId(), tournamentId }));
}

async function throwsAsync(fn) {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

async function main() {
  await connectToDatabase();
  const createdTournamentIds = [];

  try {
    // ═══════════════════════════════════════════════════════════════════
    // TEST 1: 200 synthetic entrants -- correct Round 1 pool generation.
    // ═══════════════════════════════════════════════════════════════════
    console.log("\n=== TEST 1: Model B Round 1, 200 synthetic entrants ===");

    const organizer = await makeTestPlayer("ModelBTestTO");
    const organizerCtx = { playerId: organizer._id.toString(), role: "USER" };

    const tournament = await Tournament.create({
      name: "Model B Pools Test",
      game: "Test Game",
      format: "Pools + Bracket",
      poolModel: "B",
      organizers: [organizer._id],
      startDate: new Date(),
      entrantCount: 200,
    });
    createdTournamentIds.push(tournament._id);
    await Entrant.insertMany(synthesizeEntrants(tournament._id, 200));

    assert(
      resolvers.Tournament.poolModel({ poolModel: "B" }) === "B",
      "Tournament.poolModel resolver: explicit 'B' passes through"
    );

    const expectedPoolCount = computeModelBInitialPoolCount(200);
    assert(expectedPoolCount === 16, `computeModelBInitialPoolCount(200) === 16 (power-of-2, ~15/pool) -- got ${expectedPoolCount}`);

    const pools = await resolvers.Mutation.generateModelBPools(null, { tournamentId: tournament._id.toString() }, organizerCtx);
    assert(pools.length === expectedPoolCount, `generateModelBPools created ${expectedPoolCount} pools -- got ${pools.length}`);

    const poolSizes = pools.map(p => p.entrantIds.length);
    const totalEntrants = poolSizes.reduce((a, b) => a + b, 0);
    assert(totalEntrants === 200, `Pool sizes sum to all 200 entrants -- got ${totalEntrants} (sizes=${poolSizes.join(",")})`);
    assert(poolSizes.every(s => s === 12 || s === 13), `Pool sizes are all 12 or 13 (even split of 200/16) -- got ${poolSizes.join(",")}`);

    for (const pool of pools) {
      const bracket = await resolvers.Pool.bracket(pool);
      assert(!!bracket, `Pool ${pool.poolNumber} has its own Bracket document`);
      const expectedSize = nextPowerOfTwo(pool.entrantIds.length);
      assert(bracket.size === expectedSize, `Pool ${pool.poolNumber} bracket size ${bracket.size} matches ${pool.entrantIds.length} entrants (expected ${expectedSize})`);
      assert(bracket.seedOrder.length === pool.entrantIds.length, `Pool ${pool.poolNumber} bracket seedOrder has one entry per entrant`);

      const matchCount = await Match.countDocuments({ bracketId: bracket._id });
      assert(matchCount > 0, `Pool ${pool.poolNumber} has real Match documents (got ${matchCount})`);

      const gf = await Match.findOne({ bracketId: bracket._id, bracketSide: "GRAND_FINAL" });
      assert(!!gf, `Pool ${pool.poolNumber} bracket has a Grand Final match`);
      assert(gf.status === "PENDING", `Pool ${pool.poolNumber} Grand Final is unplayed (PENDING) -- Round 1 is only generated, not simulated`);

      const roundRobinMatches = await resolvers.Pool.matches(pool);
      assert(roundRobinMatches.length === 0, `Pool ${pool.poolNumber}.matches (round-robin field) is empty -- Model B Round 1 is double-elim, not round-robin`);
      const standings = await resolvers.Pool.standings(pool);
      assert(standings === null, `Pool ${pool.poolNumber}.standings is null -- no round-robin data to rank`);
    }

    assert(
      await throwsAsync(() => resolvers.Mutation.generateModelBPools(null, { tournamentId: tournament._id.toString() }, organizerCtx)),
      "Calling generateModelBPools again on the same tournament is rejected (pools already exist)"
    );

    // ═══════════════════════════════════════════════════════════════════
    // TEST 2: the below-128 guard.
    // ═══════════════════════════════════════════════════════════════════
    console.log("\n=== TEST 2: below-128-entrant guard ===");

    const organizerSmall = await makeTestPlayer("ModelBSmallTO");
    const organizerCtxSmall = { playerId: organizerSmall._id.toString(), role: "USER" };

    const smallTournament = await Tournament.create({
      name: "Model B Too-Small Test",
      game: "Test Game",
      format: "Pools + Bracket",
      poolModel: "B",
      organizers: [organizerSmall._id],
      startDate: new Date(),
      entrantCount: 50,
    });
    createdTournamentIds.push(smallTournament._id);
    await Entrant.insertMany(synthesizeEntrants(smallTournament._id, 50));

    assert(MODEL_B_MIN_ENTRANTS === 128, `MODEL_B_MIN_ENTRANTS is 128 -- got ${MODEL_B_MIN_ENTRANTS}`);
    assert(
      await throwsAsync(() => resolvers.Mutation.generateModelBPools(null, { tournamentId: smallTournament._id.toString() }, organizerCtxSmall)),
      "Rejects a 50-entrant Model B tournament (below the 128 minimum) rather than silently generating pools"
    );
    assert((await Pool.countDocuments({ tournamentId: smallTournament._id })) === 0, "No pools were created for the rejected too-small tournament");

    // ═══════════════════════════════════════════════════════════════════
    // TEST 3: the wrong-pool-model guard -- a Model C tournament (even with
    // >=128 entrants) can't have its pools generated via this mutation.
    // ═══════════════════════════════════════════════════════════════════
    console.log("\n=== TEST 3: wrong-pool-model guard (Model C tournament) ===");

    const organizerC = await makeTestPlayer("ModelBWrongModelTO");
    const organizerCtxC = { playerId: organizerC._id.toString(), role: "USER" };

    const modelCTournament = await Tournament.create({
      name: "Model B Wrong-Model Test",
      game: "Test Game",
      format: "Pools + Bracket",
      poolModel: "C",
      organizers: [organizerC._id],
      startDate: new Date(),
      entrantCount: 150,
    });
    createdTournamentIds.push(modelCTournament._id);
    await Entrant.insertMany(synthesizeEntrants(modelCTournament._id, 150));

    assert(
      await throwsAsync(() => resolvers.Mutation.generateModelBPools(null, { tournamentId: modelCTournament._id.toString() }, organizerCtxC)),
      "Rejects a Model C tournament even with a large enough field -- generateModelBPools is scoped to poolModel 'B' only"
    );
    assert((await Pool.countDocuments({ tournamentId: modelCTournament._id })) === 0, "No pools were created for the wrong-pool-model tournament");

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
      await Entrant.deleteMany({ tournamentId });
      await Tournament.findByIdAndDelete(tournamentId);
    }
    const orgTags = ["ModelBTestTO", "ModelBSmallTO", "ModelBWrongModelTO"];
    const orgPlayers = await Player.find({ tag: { $in: orgTags } });
    const orgUserIds = orgPlayers.map(p => p.userId).filter(Boolean);
    await Player.deleteMany({ tag: { $in: orgTags } });
    await User.deleteMany({ _id: { $in: orgUserIds } });
    console.log("Cleanup done.");
  }

  process.exit(failures === 0 ? 0 : 1);
}

main();
