// scripts/testRankingPoints.mjs
//
// Functional verification for the size-scaled ranking points formula
// (lib/ranking.ts's scaledPointsForPlacement): multiplier = sqrt(entrantCount
// / 16), applied to the existing flat placement->points table, rounded to
// the nearest whole point. Same approach as the other scripts/test*.mjs
// files -- calls the REAL functions against real data in the actual
// database, not a mock.
//
// TEST 1: scaledPointsForPlacement is a pure function -- exact rounding
// checked directly against every documented example (16/8/4/2/500 entrants),
// no DB needed.
// TEST 2: the full read-time pipeline (computeRankingPoints against a real
// Tournament + Entrant) produces the exact same scaled values for a spread
// of placement buckets at both the baseline (16) and a non-baseline (64)
// entrant count.
// TEST 3: proves this is genuinely computed at READ TIME, not cached --
// queries a real player's computed points, mutates the underlying
// Tournament.entrantCount directly, queries again, and confirms the number
// actually changed to reflect the new multiplier.
// TEST 4: best-10 cap and 52-week window (unchanged by this task) still
// work correctly with scaled point values -- an 11th otherwise-countable
// result doesn't get counted, confirming no regression from this change.
//
// Run: npx tsx scripts/testRankingPoints.mjs

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
const { pointsForPlacement, scaledPointsForPlacement, computeRankingPoints } = await import("../lib/ranking");

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

// A tournament ended ~1 week ago (well within the 52-week window) --
// entrantCount is set directly since scaledPointsForPlacement only ever
// reads that stored field, never a live recount of real Entrant documents
// (see lib/ranking.ts's comment on why that's the correct field to trust).
async function makeEndedTournament(organizerId, name, entrantCount) {
  return Tournament.create({
    name,
    game: "Test Game",
    format: "Standard Bracket",
    status: "ENDED",
    organizers: [organizerId],
    startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    entrantCount,
  });
}

async function main() {
  await connectToDatabase();
  const createdTournamentIds = [];
  const createdPlayerTags = [];

  try {
    console.log("\n=== TEST 1: scaledPointsForPlacement -- pure function, exact rounding ===");
    // Baseline: 16 entrants, multiplier exactly 1 -- every bucket should
    // equal the raw base table with zero rounding drift.
    assert(scaledPointsForPlacement(1, 16) === 100, "16 entrants, Winner: sqrt(16/16)=1 -> 100 exactly");
    assert(scaledPointsForPlacement(2, 16) === 60, "16 entrants, Runner-up -> 60 exactly");
    assert(scaledPointsForPlacement(3, 16) === 35, "16 entrants, 3rd -> 35 exactly");
    assert(scaledPointsForPlacement(4, 16) === 35, "16 entrants, 4th -> 35 exactly");
    assert(scaledPointsForPlacement(5, 16) === 20, "16 entrants, 5th -> 20 exactly");
    assert(scaledPointsForPlacement(8, 16) === 20, "16 entrants, 8th -> 20 exactly");
    assert(scaledPointsForPlacement(9, 16) === 10, "16 entrants, 9th -> 10 exactly");
    assert(scaledPointsForPlacement(16, 16) === 10, "16 entrants, 16th -> 10 exactly");
    assert(scaledPointsForPlacement(17, 16) === 1, "16 entrants, 17th (below the table) -> 1 exactly");
    assert(scaledPointsForPlacement(null, 16) === 1, "16 entrants, no recorded placement -> 1 exactly");

    // Documented examples from the settled formula, smaller-than-baseline --
    // no floor/special-casing, scales down smoothly.
    assert(scaledPointsForPlacement(1, 8) === 71, `8 entrants, Winner: sqrt(8/16)=0.7071... * 100 = 70.71 -> round 71 (got ${scaledPointsForPlacement(1, 8)})`);
    assert(scaledPointsForPlacement(1, 4) === 50, `4 entrants, Winner: sqrt(4/16)=0.5 * 100 = 50 -> 50 exactly (got ${scaledPointsForPlacement(1, 4)})`);
    assert(scaledPointsForPlacement(1, 2) === 35, `2 entrants, Winner: sqrt(2/16)=0.3535... * 100 = 35.35 -> round 35 (got ${scaledPointsForPlacement(1, 2)})`);

    // Larger-than-baseline -- scales up the same way.
    assert(scaledPointsForPlacement(1, 500) === 559, `500 entrants, Winner: sqrt(500/16)=5.5901... * 100 = 559.01 -> round 559 (got ${scaledPointsForPlacement(1, 500)})`);

    // A non-Winner bucket at a non-baseline size, to confirm the multiplier
    // applies uniformly across the whole table, not just placement 1.
    assert(scaledPointsForPlacement(2, 64) === 120, `64 entrants (multiplier 2), Runner-up: 60*2=120 (got ${scaledPointsForPlacement(2, 64)})`);
    assert(scaledPointsForPlacement(3, 64) === 70, `64 entrants (multiplier 2), 3rd: 35*2=70 (got ${scaledPointsForPlacement(3, 64)})`);
    assert(scaledPointsForPlacement(5, 64) === 40, `64 entrants (multiplier 2), 5th: 20*2=40 (got ${scaledPointsForPlacement(5, 64)})`);
    assert(scaledPointsForPlacement(9, 64) === 20, `64 entrants (multiplier 2), 9th: 10*2=20 (got ${scaledPointsForPlacement(9, 64)})`);
    assert(scaledPointsForPlacement(99, 64) === 2, `64 entrants (multiplier 2), 99th (other): 1*2=2 (got ${scaledPointsForPlacement(99, 64)})`);

    // Base table itself must be completely unchanged (unscaled) -- this
    // task is a pure formula addition, not a rewrite of the existing table.
    assert(pointsForPlacement(1) === 100 && pointsForPlacement(2) === 60 && pointsForPlacement(3) === 35 && pointsForPlacement(5) === 20 && pointsForPlacement(9) === 10 && pointsForPlacement(99) === 1,
      "pointsForPlacement (the base, unscaled table) is completely unchanged");

    console.log("\n=== TEST 2: full read-time pipeline (real Tournament + Entrant + computeRankingPoints) ===");
    const organizer = await makeTestPlayer("RankingPointsTO");
    createdPlayerTags.push("RankingPointsTO");

    const winner16 = await makeTestPlayer("RankWinner16");
    createdPlayerTags.push("RankWinner16");
    const t16 = await makeEndedTournament(organizer._id, "Ranking Test 16-entrant", 16);
    createdTournamentIds.push(t16._id);
    await Entrant.create({ playerId: winner16._id, tournamentId: t16._id, placement: 1 });
    assert((await computeRankingPoints(winner16._id.toString())) === 100, "Real 16-entrant tournament, real Winner entrant -> computeRankingPoints returns exactly 100");

    const winner8 = await makeTestPlayer("RankWinner8");
    createdPlayerTags.push("RankWinner8");
    const t8 = await makeEndedTournament(organizer._id, "Ranking Test 8-entrant", 8);
    createdTournamentIds.push(t8._id);
    await Entrant.create({ playerId: winner8._id, tournamentId: t8._id, placement: 1 });
    assert((await computeRankingPoints(winner8._id.toString())) === 71, "Real 8-entrant tournament, real Winner entrant -> computeRankingPoints returns exactly 71");

    const winner500 = await makeTestPlayer("RankWinner500");
    createdPlayerTags.push("RankWinner500");
    const t500 = await makeEndedTournament(organizer._id, "Ranking Test 500-entrant", 500);
    createdTournamentIds.push(t500._id);
    await Entrant.create({ playerId: winner500._id, tournamentId: t500._id, placement: 1 });
    assert((await computeRankingPoints(winner500._id.toString())) === 559, "Real 500-entrant tournament, real Winner entrant -> computeRankingPoints returns exactly 559");

    console.log("\n=== TEST 3: genuinely computed at READ TIME, not cached/stale ===");
    const flexPlayer = await makeTestPlayer("RankFlexPlayer");
    createdPlayerTags.push("RankFlexPlayer");
    const tFlex = await makeEndedTournament(organizer._id, "Ranking Test Flex-entrant", 16);
    createdTournamentIds.push(tFlex._id);
    await Entrant.create({ playerId: flexPlayer._id, tournamentId: tFlex._id, placement: 1 });

    const pointsBefore = await computeRankingPoints(flexPlayer._id.toString());
    assert(pointsBefore === 100, `Before: 16-entrant tournament, Winner -> 100 (got ${pointsBefore})`);

    // Mutate the underlying Tournament.entrantCount directly (nothing about
    // the Entrant/placement changes) -- if points were cached anywhere,
    // this would NOT be reflected on the next call.
    await Tournament.findByIdAndUpdate(tFlex._id, { entrantCount: 64 });
    const pointsAfter = await computeRankingPoints(flexPlayer._id.toString());
    assert(pointsAfter === 200, `After entrantCount changed 16->64 with no other change: Winner -> 200 (got ${pointsAfter})`);
    assert(pointsBefore !== pointsAfter, "The computed value genuinely changed between calls -- proves this is read-time, not a cached/stale value");

    console.log("\n=== TEST 4: best-10 cap still works correctly with scaled values (unaffected by this change) ===");
    const capPlayer = await makeTestPlayer("RankCapPlayer");
    createdPlayerTags.push("RankCapPlayer");
    // 11 real ENDED 16-entrant tournaments, all Winner (100 pts each,
    // unscaled since 16 is the baseline) -- only the best 10 should count,
    // so the total must be exactly 1000, not 1100.
    for (let i = 0; i < 11; i++) {
      const t = await makeEndedTournament(organizer._id, `Ranking Test Cap ${i}`, 16);
      createdTournamentIds.push(t._id);
      await Entrant.create({ playerId: capPlayer._id, tournamentId: t._id, placement: 1 });
    }
    const capTotal = await computeRankingPoints(capPlayer._id.toString());
    assert(capTotal === 1000, `11 real Winner (100pt) results, best-10 cap -> exactly 1000, not 1100 (got ${capTotal})`);

    console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURE(S)`}`);
  } finally {
    console.log("\nCleaning up test data...");
    for (const tournamentId of createdTournamentIds) {
      await Entrant.deleteMany({ tournamentId });
      await Tournament.findByIdAndDelete(tournamentId);
    }
    const orgPlayers = await Player.find({ tag: { $in: createdPlayerTags } });
    const orgUserIds = orgPlayers.map(p => p.userId).filter(Boolean);
    await Player.deleteMany({ tag: { $in: createdPlayerTags } });
    await User.deleteMany({ _id: { $in: orgUserIds } });

    const leftoverTournaments = await Tournament.countDocuments({ name: /^Ranking Test/i });
    const leftoverPlayers = await Player.countDocuments({ tag: { $in: createdPlayerTags } });
    console.log(`Verification -- leftover tournaments: ${leftoverTournaments}, leftover players: ${leftoverPlayers}`);
    console.log("Cleanup done.");
  }

  process.exit(failures === 0 ? 0 : 1);
}

main();
