// scripts/testRankingPoints.mjs
//
// Functional verification for the size-scaled ranking points formula
// (lib/ranking.ts's scaledPointsForPlacement), applied to the existing flat
// placement->points table, rounded to the nearest whole point. Two-piece
// curve (small/mid-tournament ranking exception, settled July 26, 2026):
// entrantCount<64 -> 2*(entrantCount/64)^3 (steep anti-farming cubic),
// entrantCount>=64 -> sqrt(entrantCount/16) (completely unchanged from the
// original formula). The two pieces meet exactly at 64 entrants (both = 2x).
// Same approach as the other scripts/test*.mjs files -- calls the REAL
// functions against real data in the actual database, not a mock.
//
// TEST 1: scaledPointsForPlacement is a pure function -- exact rounding
// checked directly against every documented example (2/16/32/48/64/100/700
// entrants), plus continuity across the 63/64/65 boundary, no DB needed.
// TEST 2: the full read-time pipeline (computeRankingPoints against a real
// Tournament + Entrant) produces the exact same scaled values for a spread
// of entrant counts on both sides of the boundary (8, 32, 64, 500).
// TEST 3: proves this is genuinely computed at READ TIME, not cached --
// queries a real player's computed points, mutates the underlying
// Tournament.entrantCount directly, queries again, and confirms the number
// actually changed to reflect the new multiplier.
// TEST 4: best-10 cap and 52-week window (unchanged by this task) still
// work correctly with scaled point values -- an 11th otherwise-countable
// result doesn't get counted, confirming no regression from this change.
// TEST 6: computeGameLeaderboard/Query.gameLeaderboard (the /games/[game]
// full leaderboard) -- 3 real players with different real point totals in
// a unique test-only game are returned fully ranked and sorted, a
// soft-deleted player is excluded from the GraphQL resolver's result with
// rank staying contiguous (no gap) for the ones after them, and a game with
// zero real players returns an empty list rather than erroring.
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
const { pointsForPlacement, scaledPointsForPlacement, computeRankingPoints, computeGameRankingsForPlayer, computeGameLeaderboard } = await import("../lib/ranking");
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
    // Small/mid-tournament ranking exception (settled July 26, 2026) --
    // two-piece curve: entrantCount<64 -> 2*(entrantCount/64)^3 (steep
    // anti-farming cubic), entrantCount>=64 -> sqrt(entrantCount/16)
    // (completely unchanged). Confirmed documented values, Winner (base 100):
    assert(scaledPointsForPlacement(1, 2) === 0, `2 entrants, Winner: 2*(2/64)^3*100 = 0.0061 -> round 0 (got ${scaledPointsForPlacement(1, 2)})`);
    assert(scaledPointsForPlacement(1, 16) === 3, `16 entrants, Winner: 2*(16/64)^3*100 = 3.125 -> round 3 (got ${scaledPointsForPlacement(1, 16)})`);
    assert(scaledPointsForPlacement(1, 32) === 25, `32 entrants, Winner: 2*(32/64)^3*100 = 25 exactly (got ${scaledPointsForPlacement(1, 32)})`);
    assert(scaledPointsForPlacement(1, 48) === 84, `48 entrants, Winner: 2*(48/64)^3*100 = 84.375 -> round 84 (got ${scaledPointsForPlacement(1, 48)})`);
    assert(scaledPointsForPlacement(1, 64) === 200, `64 entrants, Winner: the two pieces meet exactly here (both = 2x) -> 200 exactly (got ${scaledPointsForPlacement(1, 64)})`);
    assert(scaledPointsForPlacement(1, 100) === 250, `100 entrants, Winner (unchanged branch): sqrt(100/16)*100 = 250 exactly (got ${scaledPointsForPlacement(1, 100)})`);
    assert(scaledPointsForPlacement(1, 700) === 661, `700 entrants, Winner (unchanged branch): sqrt(700/16)*100 = 661.44 -> round 661 (got ${scaledPointsForPlacement(1, 700)})`);

    // Continuity at the 64-entrant boundary -- 63/64/65 should ramp smoothly
    // (each step higher than the last, no jump/reversal beyond what normal
    // rounding of a continuous curve with a kink there would produce).
    const at63 = scaledPointsForPlacement(1, 63);
    const at64 = scaledPointsForPlacement(1, 64);
    const at65 = scaledPointsForPlacement(1, 65);
    assert(at63 === 191, `63 entrants (just below the cutoff, cubic piece): 2*(63/64)^3*100 = 190.77 -> round 191 (got ${at63})`);
    assert(at65 === 202, `65 entrants (just above the cutoff, sqrt piece): sqrt(65/16)*100 = 201.56 -> round 202 (got ${at65})`);
    assert(at63 < at64 && at64 < at65, `No jump/reversal across the boundary -- monotonically increasing 63 -> 64 -> 65 (got ${at63}, ${at64}, ${at65})`);

    // A non-Winner bucket below the cutoff (32 entrants, multiplier exactly
    // 0.25), to confirm the new curve applies uniformly across the whole
    // table, not just placement 1.
    assert(scaledPointsForPlacement(2, 32) === 15, `32 entrants (multiplier 0.25), Runner-up: 60*0.25=15 (got ${scaledPointsForPlacement(2, 32)})`);
    assert(scaledPointsForPlacement(3, 32) === 9, `32 entrants (multiplier 0.25), 3rd: 35*0.25=8.75 -> round 9 (got ${scaledPointsForPlacement(3, 32)})`);
    assert(scaledPointsForPlacement(5, 32) === 5, `32 entrants (multiplier 0.25), 5th: 20*0.25=5 exactly (got ${scaledPointsForPlacement(5, 32)})`);
    assert(scaledPointsForPlacement(9, 32) === 3, `32 entrants (multiplier 0.25), 9th: 10*0.25=2.5 -> round 3 (got ${scaledPointsForPlacement(9, 32)})`);
    assert(scaledPointsForPlacement(99, 32) === 0, `32 entrants (multiplier 0.25), 99th (other): 1*0.25=0.25 -> round 0 (got ${scaledPointsForPlacement(99, 32)})`);

    // Same check above the cutoff (64 entrants, multiplier exactly 2) --
    // this branch is untouched, so these match the pre-existing behavior.
    assert(scaledPointsForPlacement(2, 64) === 120, `64 entrants (multiplier 2), Runner-up: 60*2=120 (got ${scaledPointsForPlacement(2, 64)})`);
    assert(scaledPointsForPlacement(3, 64) === 70, `64 entrants (multiplier 2), 3rd: 35*2=70 (got ${scaledPointsForPlacement(3, 64)})`);
    assert(scaledPointsForPlacement(5, 64) === 40, `64 entrants (multiplier 2), 5th: 20*2=40 (got ${scaledPointsForPlacement(5, 64)})`);
    assert(scaledPointsForPlacement(9, 64) === 20, `64 entrants (multiplier 2), 9th: 10*2=20 (got ${scaledPointsForPlacement(9, 64)})`);
    assert(scaledPointsForPlacement(99, 64) === 2, `64 entrants (multiplier 2), 99th (other): 1*2=2 (got ${scaledPointsForPlacement(99, 64)})`);

    // Well above the cutoff -- unchanged branch, same as before this task.
    assert(scaledPointsForPlacement(1, 500) === 559, `500 entrants, Winner (unchanged branch): sqrt(500/16)=5.5901... * 100 = 559.01 -> round 559 (got ${scaledPointsForPlacement(1, 500)})`);

    // Base table itself must be completely unchanged (unscaled) -- this
    // task is a pure formula change to the multiplier, not a rewrite of the
    // existing table.
    assert(pointsForPlacement(1) === 100 && pointsForPlacement(2) === 60 && pointsForPlacement(3) === 35 && pointsForPlacement(5) === 20 && pointsForPlacement(9) === 10 && pointsForPlacement(99) === 1,
      "pointsForPlacement (the base, unscaled table) is completely unchanged");

    console.log("\n=== TEST 2: full read-time pipeline (real Tournament + Entrant + computeRankingPoints) ===");
    const organizer = await makeTestPlayer("RankingPointsTO");
    createdPlayerTags.push("RankingPointsTO");

    const winner8 = await makeTestPlayer("RankWinner8");
    createdPlayerTags.push("RankWinner8");
    const t8 = await makeEndedTournament(organizer._id, "Ranking Test 8-entrant", 8);
    createdTournamentIds.push(t8._id);
    await Entrant.create({ playerId: winner8._id, tournamentId: t8._id, placement: 1 });
    assert((await computeRankingPoints(winner8._id.toString())) === 0, "Real 8-entrant tournament, real Winner entrant -> computeRankingPoints returns 0 (small-tournament exception neutralizes a tiny field's win)");

    const winner32 = await makeTestPlayer("RankWinner32");
    createdPlayerTags.push("RankWinner32");
    const t32 = await makeEndedTournament(organizer._id, "Ranking Test 32-entrant", 32);
    createdTournamentIds.push(t32._id);
    await Entrant.create({ playerId: winner32._id, tournamentId: t32._id, placement: 1 });
    assert((await computeRankingPoints(winner32._id.toString())) === 25, "Real 32-entrant tournament, real Winner entrant -> computeRankingPoints returns exactly 25");

    const winner64 = await makeTestPlayer("RankWinner64");
    createdPlayerTags.push("RankWinner64");
    const t64 = await makeEndedTournament(organizer._id, "Ranking Test 64-entrant", 64);
    createdTournamentIds.push(t64._id);
    await Entrant.create({ playerId: winner64._id, tournamentId: t64._id, placement: 1 });
    assert((await computeRankingPoints(winner64._id.toString())) === 200, "Real 64-entrant tournament (the boundary), real Winner entrant -> computeRankingPoints returns exactly 200");

    const winner500 = await makeTestPlayer("RankWinner500");
    createdPlayerTags.push("RankWinner500");
    const t500 = await makeEndedTournament(organizer._id, "Ranking Test 500-entrant", 500);
    createdTournamentIds.push(t500._id);
    await Entrant.create({ playerId: winner500._id, tournamentId: t500._id, placement: 1 });
    assert((await computeRankingPoints(winner500._id.toString())) === 559, "Real 500-entrant tournament (unchanged branch), real Winner entrant -> computeRankingPoints returns exactly 559");

    console.log("\n=== TEST 3: genuinely computed at READ TIME, not cached/stale ===");
    const flexPlayer = await makeTestPlayer("RankFlexPlayer");
    createdPlayerTags.push("RankFlexPlayer");
    const tFlex = await makeEndedTournament(organizer._id, "Ranking Test Flex-entrant", 16);
    createdTournamentIds.push(tFlex._id);
    await Entrant.create({ playerId: flexPlayer._id, tournamentId: tFlex._id, placement: 1 });

    const pointsBefore = await computeRankingPoints(flexPlayer._id.toString());
    assert(pointsBefore === 3, `Before: 16-entrant tournament, Winner (small-tournament exception) -> 3 (got ${pointsBefore})`);

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
    // 11 real ENDED 64-entrant tournaments (the unchanged branch, multiplier
    // exactly 2x -- deliberately NOT a small/mid field, so this test stays
    // focused on cap behavior rather than the new curve's rounding), all
    // Winner (200 pts each) -- only the best 10 should count, so the total
    // must be exactly 2000, not 2200.
    for (let i = 0; i < 11; i++) {
      const t = await makeEndedTournament(organizer._id, `Ranking Test Cap ${i}`, 64);
      createdTournamentIds.push(t._id);
      await Entrant.create({ playerId: capPlayer._id, tournamentId: t._id, placement: 1 });
    }
    const capTotal = await computeRankingPoints(capPlayer._id.toString());
    assert(capTotal === 2000, `11 real Winner (200pt) results, best-10 cap -> exactly 2000, not 2200 (got ${capTotal})`);

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

    // Player A's 3 real results are all 16-entrant tournaments -- under the
    // small-tournament exception, a Winner there is worth 3 (not 100) and a
    // Runner-up worth 2 (not 60): 3 (SF6 1st) + 2 (SF6 2nd) + 3 (Tekken 1st) = 8.
    const combinedA = await computeRankingPoints(playerA._id.toString());
    assert(combinedA === 8, `Player A's COMBINED points aggregate across BOTH games (3 SF6 + 2 SF6 + 3 Tekken = 8, got ${combinedA})`);

    const gameRankingsA = await computeGameRankingsForPlayer(playerA._id.toString());
    assert(gameRankingsA.length === 2, `Player A shows exactly 2 games entered (got ${gameRankingsA.length}: ${gameRankingsA.map(g => g.game).join(", ")})`);

    const aSf6 = gameRankingsA.find(g => g.game === "RankingTestIsolatedGameSF6");
    const aTekken = gameRankingsA.find(g => g.game === "RankingTestIsolatedGameTekken");
    assert(!!aSf6 && aSf6.points === 5, `Player A's SF6-only points correctly isolated to just the 2 SF6 results (3+2=5, got ${aSf6?.points})`);
    assert(!!aTekken && aTekken.points === 3, `Player A's Tekken entry exists with just 1 counted result -- no minimum-tournament threshold (3 pts, got ${aTekken?.points})`);

    // Player B's SINGLE 64-entrant win (200pts, unchanged branch) now beats
    // Player A's two small-tournament SF6 results (5pts) by an even wider
    // margin than before this task -- exactly the intended effect: a real
    // big-field result should clearly outrank farmed small-tournament wins.
    assert(aSf6.rank === 2, `Player A ranks #2 in SF6, behind Player B's bigger-field win (got #${aSf6.rank})`);

    const gameRankingsB = await computeGameRankingsForPlayer(playerB._id.toString());
    const bSf6 = gameRankingsB.find(g => g.game === "RankingTestIsolatedGameSF6");
    assert(bSf6.rank === 1, `Player B ranks #1 in SF6 (got #${bSf6?.rank})`);
    assert(bSf6.points === 200, `Player B's SF6 points: 64-entrant Winner = sqrt(64/16)*100 = 200 exactly (got ${bSf6?.points})`);
    assert(gameRankingsB.length === 1, `Player B (never entered Tekken) shows exactly 1 game, not an empty/placeholder Tekken entry (got ${gameRankingsB.length})`);

    // Independent best-10 cap per game: 11 real SF6 results + 11 real
    // Tekken results for the SAME player, all Winner (3pts each -- 16
    // entrants, small-tournament exception) -- each game's own cap must
    // land at exactly 30, while the COMBINED cap (applied across the full
    // 22-result pool) must ALSO cap at 30, not 60 -- proving the per-game
    // cap operates on the game-filtered subset independently, not merely
    // re-reading the already-capped combined total.
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
    assert(capPlayerCombined === 30, `22 total real Winner (3pt) results across 2 games, COMBINED best-10 cap -> exactly 30 (got ${capPlayerCombined})`);

    const capPlayerGameRankings = await computeGameRankingsForPlayer(capPlayerMultiGame._id.toString());
    const capSf6 = capPlayerGameRankings.find(g => g.game === "RankingTestIsolatedGameSF6");
    const capTekken = capPlayerGameRankings.find(g => g.game === "RankingTestIsolatedGameTekken");
    assert(capSf6.points === 30, `SF6-only best-10 cap (11 real SF6 results) -> exactly 30 independently of Tekken (got ${capSf6?.points})`);
    assert(capTekken.points === 30, `Tekken-only best-10 cap (11 real Tekken results) -> exactly 30 independently of SF6 (got ${capTekken?.points})`);

    console.log("\n=== TEST 6: computeGameLeaderboard / Query.gameLeaderboard (/games/[game] full leaderboard) ===");

    // 3 real players, 3 different real point totals, all in one unique
    // test-only game -- confirms computeGameLeaderboard returns every real
    // player who entered, fully ranked and sorted by points descending.
    const lbPlayer1 = await makeTestPlayer("GameLbPlayer1");
    createdPlayerTags.push("GameLbPlayer1");
    const lbT1 = await makeEndedTournament(organizer._id, "Ranking Test Leaderboard 1st", 16, "RankingTestIsolatedGameLeaderboard");
    createdTournamentIds.push(lbT1._id);
    await Entrant.create({ playerId: lbPlayer1._id, tournamentId: lbT1._id, placement: 1 });

    const lbPlayer2 = await makeTestPlayer("GameLbPlayer2");
    createdPlayerTags.push("GameLbPlayer2");
    const lbT2 = await makeEndedTournament(organizer._id, "Ranking Test Leaderboard 2nd", 16, "RankingTestIsolatedGameLeaderboard");
    createdTournamentIds.push(lbT2._id);
    await Entrant.create({ playerId: lbPlayer2._id, tournamentId: lbT2._id, placement: 2 });

    const lbPlayer3 = await makeTestPlayer("GameLbPlayer3");
    createdPlayerTags.push("GameLbPlayer3");
    const lbT3 = await makeEndedTournament(organizer._id, "Ranking Test Leaderboard 3rd", 16, "RankingTestIsolatedGameLeaderboard");
    createdTournamentIds.push(lbT3._id);
    await Entrant.create({ playerId: lbPlayer3._id, tournamentId: lbT3._id, placement: 3 });

    // All 3 real results are 16-entrant tournaments -- small-tournament
    // exception values: Winner=3, Runner-up=2, 3rd=1 (not 100/60/35). The
    // relative ORDER is unaffected (3 > 2 > 1, same as 100 > 60 > 35), so
    // rank assertions below are unchanged -- only the point values are.
    const lbGame = "RankingTestIsolatedGameLeaderboard";
    const rawLeaderboard = await computeGameLeaderboard(lbGame);
    assert(rawLeaderboard.length === 3, `computeGameLeaderboard returns exactly the 3 real players who entered (got ${rawLeaderboard.length})`);
    assert(
      rawLeaderboard[0].playerId === lbPlayer1._id.toString() && rawLeaderboard[0].points === 3,
      `Leaderboard[0] is the Winner (3pts) (got ${rawLeaderboard[0]?.points})`
    );
    assert(
      rawLeaderboard[1].playerId === lbPlayer2._id.toString() && rawLeaderboard[1].points === 2,
      `Leaderboard[1] is the Runner-up (2pts) (got ${rawLeaderboard[1]?.points})`
    );
    assert(
      rawLeaderboard[2].playerId === lbPlayer3._id.toString() && rawLeaderboard[2].points === 1,
      `Leaderboard[2] is 3rd place (1pt) (got ${rawLeaderboard[2]?.points})`
    );

    // The GraphQL resolver itself -- real player objects, contiguous 1-indexed
    // rank, sorted the same way.
    const resolvedLb = await resolvers.Query.gameLeaderboard(null, { game: lbGame });
    assert(resolvedLb.length === 3, `Query.gameLeaderboard resolver returns 3 entries (got ${resolvedLb.length})`);
    assert(
      resolvedLb[0].rank === 1 && resolvedLb[0].points === 3 && resolvedLb[0].player.tag === "GameLbPlayer1",
      `Resolver rank #1 is GameLbPlayer1 with 3pts (got rank ${resolvedLb[0]?.rank}, ${resolvedLb[0]?.points}pts, ${resolvedLb[0]?.player?.tag})`
    );
    assert(
      resolvedLb[1].rank === 2 && resolvedLb[1].points === 2 && resolvedLb[1].player.tag === "GameLbPlayer2",
      `Resolver rank #2 is GameLbPlayer2 with 2pts (got rank ${resolvedLb[1]?.rank}, ${resolvedLb[1]?.points}pts, ${resolvedLb[1]?.player?.tag})`
    );
    assert(
      resolvedLb[2].rank === 3 && resolvedLb[2].points === 1 && resolvedLb[2].player.tag === "GameLbPlayer3",
      `Resolver rank #3 is GameLbPlayer3 with 1pt (got rank ${resolvedLb[2]?.rank}, ${resolvedLb[2]?.points}pts, ${resolvedLb[2]?.player?.tag})`
    );

    // Soft-delete the #2 player -- the resolver must exclude them (matching
    // Query.players' isDeleted convention) AND close the rank gap so #3
    // becomes #2, not stay #3 with a hole left behind.
    await Player.findByIdAndUpdate(lbPlayer2._id, { isDeleted: true });
    const resolvedLbAfterDelete = await resolvers.Query.gameLeaderboard(null, { game: lbGame });
    assert(resolvedLbAfterDelete.length === 2, `After soft-deleting GameLbPlayer2, resolver returns 2 entries, not 3 (got ${resolvedLbAfterDelete.length})`);
    assert(
      !resolvedLbAfterDelete.some(e => e.player.tag === "GameLbPlayer2"),
      "Soft-deleted GameLbPlayer2 is excluded from the resolver's result"
    );
    assert(
      resolvedLbAfterDelete[0].rank === 1 && resolvedLbAfterDelete[0].player.tag === "GameLbPlayer1",
      `Rank #1 unaffected by the deletion further down the list (got ${resolvedLbAfterDelete[0]?.rank}, ${resolvedLbAfterDelete[0]?.player?.tag})`
    );
    assert(
      resolvedLbAfterDelete[1].rank === 2 && resolvedLbAfterDelete[1].player.tag === "GameLbPlayer3",
      `GameLbPlayer3 moved up to contiguous rank #2 (no gap left for the deleted #2) (got ${resolvedLbAfterDelete[1]?.rank}, ${resolvedLbAfterDelete[1]?.player?.tag})`
    );

    // A game nobody has ever entered -- must return an empty list, not throw.
    const emptyGame = "RankingTestIsolatedGameEmpty";
    const emptyRaw = await computeGameLeaderboard(emptyGame);
    assert(Array.isArray(emptyRaw) && emptyRaw.length === 0, `computeGameLeaderboard for a game with zero real players returns [] (got ${JSON.stringify(emptyRaw)})`);
    const emptyResolved = await resolvers.Query.gameLeaderboard(null, { game: emptyGame });
    assert(Array.isArray(emptyResolved) && emptyResolved.length === 0, `Query.gameLeaderboard resolver for a game with zero real players returns [] (got ${JSON.stringify(emptyResolved)})`);

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
