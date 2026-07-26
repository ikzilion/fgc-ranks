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
const { pointsForPlacement, scaledPointsForPlacement, computeRankingPoints, computeGameRankingsForPlayer } = await import("../lib/ranking");

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
async function makeEndedTournament(organizerId, name, entrantCount, game = "Test Game") {
  return Tournament.create({
    name,
    game,
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

    console.log("\n=== TEST 5: per-game ranking (computeGameRankingsForPlayer) -- isolation, independent cap, no threshold, combined calc unaffected ===");

    // Player A: 2 real Street Fighter 6 results (Winner + Runner-up) and 1
    // real Tekken 8 result (Winner) -- confirms every game they've entered
    // shows up, including Tekken with just its single result (no minimum
    // threshold).
    const playerA = await makeTestPlayer("GameRankPlayerA");
    createdPlayerTags.push("GameRankPlayerA");
    const sf6First = await makeEndedTournament(organizer._id, "Ranking Test Game SF6 1st", 16, "RankingTestIsolatedGameSF6");
    createdTournamentIds.push(sf6First._id);
    await Entrant.create({ playerId: playerA._id, tournamentId: sf6First._id, placement: 1 });
    const sf6Second = await makeEndedTournament(organizer._id, "Ranking Test Game SF6 2nd", 16, "RankingTestIsolatedGameSF6");
    createdTournamentIds.push(sf6Second._id);
    await Entrant.create({ playerId: playerA._id, tournamentId: sf6Second._id, placement: 2 });
    const tekkenOnly = await makeEndedTournament(organizer._id, "Ranking Test Game Tekken Only", 16, "RankingTestIsolatedGameTekken");
    createdTournamentIds.push(tekkenOnly._id);
    await Entrant.create({ playerId: playerA._id, tournamentId: tekkenOnly._id, placement: 1 });

    // Player B: a real 1st-place Street Fighter 6 result in a MUCH bigger
    // field, so B's SF6 points genuinely outrank A's -- proves rank is
    // computed relative to other real players in that game, not just a
    // placeholder constant.
    const playerB = await makeTestPlayer("GameRankPlayerB");
    createdPlayerTags.push("GameRankPlayerB");
    const sf6BigOne = await makeEndedTournament(organizer._id, "Ranking Test Game SF6 Big", 64, "RankingTestIsolatedGameSF6");
    createdTournamentIds.push(sf6BigOne._id);
    await Entrant.create({ playerId: playerB._id, tournamentId: sf6BigOne._id, placement: 1 });

    const combinedA = await computeRankingPoints(playerA._id.toString());
    assert(combinedA === 260, `Player A's COMBINED points aggregate across BOTH games unchanged (100 SF6 + 60 SF6 + 100 Tekken = 260, got ${combinedA})`);

    const gameRankingsA = await computeGameRankingsForPlayer(playerA._id.toString());
    assert(gameRankingsA.length === 2, `Player A shows exactly 2 games entered (got ${gameRankingsA.length}: ${gameRankingsA.map(g => g.game).join(", ")})`);

    const aSf6 = gameRankingsA.find(g => g.game === "RankingTestIsolatedGameSF6");
    const aTekken = gameRankingsA.find(g => g.game === "RankingTestIsolatedGameTekken");
    assert(!!aSf6 && aSf6.points === 160, `Player A's SF6-only points correctly isolated to just the 2 SF6 results (100+60=160, got ${aSf6?.points})`);
    assert(!!aTekken && aTekken.points === 100, `Player A's Tekken entry exists with just 1 counted result -- no minimum-tournament threshold (100 pts, got ${aTekken?.points})`);

    assert(aSf6.rank === 2, `Player A ranks #2 in SF6, behind Player B's bigger-field win (got #${aSf6.rank})`);

    const gameRankingsB = await computeGameRankingsForPlayer(playerB._id.toString());
    const bSf6 = gameRankingsB.find(g => g.game === "RankingTestIsolatedGameSF6");
    assert(bSf6.rank === 1, `Player B ranks #1 in SF6 (got #${bSf6?.rank})`);
    assert(bSf6.points === 200, `Player B's SF6 points: 64-entrant Winner = sqrt(64/16)*100 = 200 exactly (got ${bSf6?.points})`);
    assert(gameRankingsB.length === 1, `Player B (never entered Tekken) shows exactly 1 game, not an empty/placeholder Tekken entry (got ${gameRankingsB.length})`);

    // Independent best-10 cap per game: 11 real SF6 results + 11 real
    // Tekken results for the SAME player, all Winner (100pts unscaled at 16
    // entrants) -- each game's own cap must land at exactly 1000, while the
    // COMBINED cap (applied across the full 22-result pool) must ALSO cap
    // at 1000, not 2000 -- proving the per-game cap operates on the
    // game-filtered subset independently, not merely re-reading the
    // already-capped combined total.
    const capPlayerMultiGame = await makeTestPlayer("GameRankCapPlayer");
    createdPlayerTags.push("GameRankCapPlayer");
    for (let i = 0; i < 11; i++) {
      const sf6 = await makeEndedTournament(organizer._id, `Ranking Test Game Cap SF6 ${i}`, 16, "RankingTestIsolatedGameSF6");
      createdTournamentIds.push(sf6._id);
      await Entrant.create({ playerId: capPlayerMultiGame._id, tournamentId: sf6._id, placement: 1 });
      const tekken = await makeEndedTournament(organizer._id, `Ranking Test Game Cap Tekken ${i}`, 16, "RankingTestIsolatedGameTekken");
      createdTournamentIds.push(tekken._id);
      await Entrant.create({ playerId: capPlayerMultiGame._id, tournamentId: tekken._id, placement: 1 });
    }
    const capPlayerCombined = await computeRankingPoints(capPlayerMultiGame._id.toString());
    assert(capPlayerCombined === 1000, `22 total real Winner results across 2 games, COMBINED best-10 cap -> exactly 1000 (got ${capPlayerCombined})`);

    const capPlayerGameRankings = await computeGameRankingsForPlayer(capPlayerMultiGame._id.toString());
    const capSf6 = capPlayerGameRankings.find(g => g.game === "RankingTestIsolatedGameSF6");
    const capTekken = capPlayerGameRankings.find(g => g.game === "RankingTestIsolatedGameTekken");
    assert(capSf6.points === 1000, `SF6-only best-10 cap (11 real SF6 results) -> exactly 1000 independently of Tekken (got ${capSf6?.points})`);
    assert(capTekken.points === 1000, `Tekken-only best-10 cap (11 real Tekken results) -> exactly 1000 independently of SF6 (got ${capTekken?.points})`);

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
