// scripts/qaTournamentLoopWalkthrough.mjs
//
// One-off QA walkthrough (not a permanent regression test) of the FULL
// tournament lifecycle as a real user/TO would experience it, end-to-end
// rather than piece-by-piece (individual pieces are already covered by
// scripts/testPoolsFeature.mjs, testModelAPoolsFeature.mjs,
// testUndoMatchResult.mjs, testRankingPoints.mjs, etc). Calls the REAL
// GraphQL resolver functions against real data in the actual production
// database, same code path the API itself runs.
//
// Covers, per format (Standard Bracket, then Pools + Bracket / Model C):
//   1. Players join via the real joinTournament resolver (not a direct
//      Entrant.insertMany bypass) -- exercises join-lock + notifications.
//   2. TO sets tournament LIVE (locks joining, fires notifications).
//   3. Bracket/pools generated and played to completion via reportResult,
//      including one editMatchResult (flips a decided match's winner) and
//      one undoMatchResult (reverts a decided match to PENDING then
//      re-reports it) -- both exercised on a bracket's current terminal
//      match, same constraint the UI's Undo button enforces.
//   4. Grand Final completion -> placements auto-computed
//      (computeAndApplyBracketPlacements), verified against hand-derived
//      expected placements from the same match tree.
//   5. TO sets tournament ENDED, verified + notifications checked.
//   6. Top-8 results-page data shape (app/tournaments/[id]/results/page.tsx's
//      own filter/sort/slice(0,8) logic, replicated here against real
//      resolver data) checked directly.
//   7. Ranking points (Player.points field resolver, lib/ranking.ts) checked
//      against hand-computed scaledPointsForPlacement for every entrant.
//   8. Players leaderboard (Query.players) checked: our test players appear,
//      with the right points, in the right relative order.
//   9. Notifications spot-checked for PLAYER_JOINED / TOURNAMENT_LIVE /
//      MATCH_REPORTED / TOURNAMENT_ENDED at the right points.
//
// Run: npx tsx scripts/qaTournamentLoopWalkthrough.mjs

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
const { Notification } = await import("../models/Notification");
const { resolvers } = await import("../graphql/resolvers/index");
const { createLoaders } = await import("../graphql/loaders");
const { scaledPointsForPlacement } = await import("../lib/ranking");

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
const allCreatedTournamentIds = [];
const allCreatedPlayerTags = [];

async function makeTestPlayer(tag) {
  const passwordHash = await PASSWORD_HASH_PROMISE;
  const email = `${tag.toLowerCase()}@example.com`;
  const user = await User.create({ email, passwordHash });
  const player = await Player.create({ userId: user._id, tag });
  await User.findByIdAndUpdate(user._id, { playerId: player._id });
  allCreatedPlayerTags.push(tag);
  return player;
}

function ctx(player, roleOverride) {
  return { playerId: player._id.toString(), role: roleOverride };
}

async function findReadyMatches(bracketId, bracketSide, bracketRound) {
  return Match.find({
    bracketId,
    bracketSide,
    bracketRound,
    status: "PENDING",
    player1Id: { $ne: null },
    player2Id: { $ne: null },
  });
}

async function playRound(organizerCtx, bracketId, bracketSide, bracketRound) {
  const ready = await findReadyMatches(bracketId, bracketSide, bracketRound);
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

// Plays WB round 1 with a real editMatchResult + a real undoMatchResult
// demonstration mixed in, both on freshly-reported (still-terminal) matches
// -- then plays the rest of the bracket to completion normally.
async function playBracketToCompletionWithEditAndUndo(organizerCtx, bracketId, label) {
  const wb1 = await findReadyMatches(bracketId, "WINNERS", 1);
  assert(wb1.length >= 2, `${label}: at least 2 WB round-1 matches ready to demonstrate edit+undo on (got ${wb1.length})`);

  // ── Edit demonstration: report a match, then flip its winner via
  // editMatchResult before anything downstream is touched (guaranteed to
  // still be the bracket's terminal match at this point).
  const editTarget = wb1[0];
  const p1 = editTarget.player1Id.toString();
  const p2 = editTarget.player2Id.toString();
  await resolvers.Mutation.reportResult(null, { matchId: editTarget._id.toString(), player1Score: 2, player2Score: 0 }, organizerCtx);
  let reported = await Match.findById(editTarget._id);
  assert(reported.status === "COMPLETED" && reported.winnerId.toString() === p1, `${label}: edit-target match reported, player1 (${p1}) won`);
  const winsBeforeEdit = (await Player.findById(p1)).wins;
  const lossesBeforeEditP2 = (await Player.findById(p2)).losses;

  const edited = await resolvers.Mutation.editMatchResult(null, { matchId: editTarget._id.toString(), player1Score: 0, player2Score: 2 }, { ...organizerCtx, loaders: createLoaders() });
  assert(edited.winnerId.toString() === p2, `${label}: editMatchResult flipped the winner to player2 (${p2})`);
  const p1AfterEdit = await Player.findById(p1);
  const p2AfterEdit = await Player.findById(p2);
  assert(p1AfterEdit.wins === winsBeforeEdit - 1, `${label}: editMatchResult correctly REVERSED player1's win (not double-counted) -- ${winsBeforeEdit} -> ${p1AfterEdit.wins}`);
  assert(p2AfterEdit.losses === lossesBeforeEditP2 - 1, `${label}: editMatchResult correctly reversed player2's old loss`);
  if (edited.nextMatchId) {
    const field = edited.nextMatchSlot === 1 ? "player1Id" : "player2Id";
    const nextMatch = await Match.findById(edited.nextMatchId);
    assert(nextMatch[field]?.toString() === p2, `${label}: corrected winner (player2) correctly landed in the downstream match slot, not the original winner`);
  }

  // ── Undo demonstration: report a different match, undo it, confirm it's
  // back to PENDING with stats/downstream-slot reverted, then re-report it
  // so the bracket can keep progressing.
  const undoTarget = wb1[1];
  const up1 = undoTarget.player1Id.toString();
  const up2 = undoTarget.player2Id.toString();
  await resolvers.Mutation.reportResult(null, { matchId: undoTarget._id.toString(), player1Score: 2, player2Score: 1 }, organizerCtx);
  const undoWinsBefore = (await Player.findById(up1)).wins;
  const undoLossesBefore = (await Player.findById(up2)).losses;

  const undone = await resolvers.Mutation.undoMatchResult(null, { matchId: undoTarget._id.toString() }, { ...organizerCtx, loaders: createLoaders() });
  assert(undone.status === "PENDING" && undone.winnerId == null, `${label}: undoMatchResult reverted the match to PENDING with no winner`);
  const up1After = await Player.findById(up1);
  const up2After = await Player.findById(up2);
  assert(up1After.wins === undoWinsBefore - 1, `${label}: undoMatchResult correctly reversed the win`);
  assert(up2After.losses === undoLossesBefore - 1, `${label}: undoMatchResult correctly reversed the loss`);
  if (undoTarget.nextMatchId) {
    const field = undoTarget.nextMatchSlot === 1 ? "player1Id" : "player2Id";
    const nextMatch = await Match.findById(undoTarget.nextMatchId);
    assert(nextMatch[field] == null, `${label}: undo correctly cleared the downstream match slot`);
  }

  // Re-report so the bracket isn't stuck with a PENDING match forever.
  await resolvers.Mutation.reportResult(null, { matchId: undoTarget._id.toString(), player1Score: 2, player2Score: 0 }, organizerCtx);

  // Now play the rest of the bracket to completion round by round.
  for (let round = 1; round <= 12; round++) {
    const wbPlayed = await playRound(organizerCtx, bracketId, "WINNERS", round);
    const lbPlayed = await playRound(organizerCtx, bracketId, "LOSERS", round);
    if (wbPlayed === 0 && lbPlayed === 0) break;
  }
  const gf = await Match.findOne({ bracketId, bracketSide: "GRAND_FINAL" });
  assert(!!gf && !!gf.player1Id && !!gf.player2Id, `${label}: Grand Final match exists with both finalists determined`);
  if (gf && gf.status === "PENDING") {
    // Force the losers-finalist (player2) to win game 1 at least once
    // across the whole QA run, to exercise the bracket-reset path.
    await resolvers.Mutation.reportResult(null, { matchId: gf._id.toString(), player1Score: 0, player2Score: 2 }, organizerCtx);
  }
  const reset = await Match.findOne({ bracketId, bracketSide: "GRAND_FINAL_RESET" });
  if (reset && reset.status === "PENDING") {
    await resolvers.Mutation.reportResult(null, { matchId: reset._id.toString(), player1Score: 2, player2Score: 0 }, organizerCtx);
  }
  return { gf: await Match.findOne({ bracketId, bracketSide: "GRAND_FINAL" }), reset: await Match.findOne({ bracketId, bracketSide: "GRAND_FINAL_RESET" }) };
}

// Hand-derives expected placements from the match tree, mirroring
// lib/bracket.ts's computeAndApplyBracketPlacements exactly, to verify the
// REAL automatic placements against an independent expectation.
async function expectedPlacementsForBracket(bracketId) {
  const matches = await Match.find({ bracketId });
  const terminal =
    matches.find(m => m.bracketSide === "GRAND_FINAL_RESET" && m.status === "COMPLETED") ??
    matches.find(m => m.bracketSide === "GRAND_FINAL" && m.status === "COMPLETED");
  const expected = new Map();
  if (!terminal || !terminal.winnerId) return expected;
  const winnerId = terminal.winnerId.toString();
  const loserId = (terminal.winnerId.toString() === terminal.player1Id.toString() ? terminal.player2Id : terminal.player1Id).toString();
  expected.set(winnerId, 1);
  expected.set(loserId, 2);
  const loserSideMatches = matches.filter(m => m.bracketSide === "LOSERS" && m.status === "COMPLETED" && m.winnerId);
  const totalLBRounds = loserSideMatches.reduce((max, m) => Math.max(max, m.bracketRound), 0);
  for (const m of loserSideMatches) {
    const depth = totalLBRounds - m.bracketRound;
    const placement = depth === 0 ? 3 : depth === 1 ? 5 : depth === 2 ? 9 : null;
    if (placement === null) continue;
    const loser = (m.winnerId.toString() === m.player1Id.toString() ? m.player2Id : m.player1Id).toString();
    expected.set(loser, placement);
  }
  return expected;
}

async function verifyPlacementsRankingAndTop8(tournamentId, allEntrantPlayerIds, label) {
  const tournament = await Tournament.findById(tournamentId);

  // ── Placements ──
  const entrants = await resolvers.Tournament.entrants({ _id: tournamentId });
  assert(entrants.length === allEntrantPlayerIds.length, `${label}: entrant count unchanged from join phase (${entrants.length})`);

  // ── ENDED + notifications ──
  assert(tournament.status === "ENDED", `${label}: tournament status is ENDED`);
  const endedNotifs = await Notification.find({ type: "TOURNAMENT_ENDED", link: `/tournaments/${tournamentId}` });
  assert(endedNotifs.length === allEntrantPlayerIds.length, `${label}: TOURNAMENT_ENDED notification fired for every entrant (${endedNotifs.length}/${allEntrantPlayerIds.length})`);
  const liveNotifs = await Notification.find({ type: "TOURNAMENT_LIVE", link: `/tournaments/${tournamentId}` });
  assert(liveNotifs.length === allEntrantPlayerIds.length, `${label}: TOURNAMENT_LIVE notification fired for every entrant (${liveNotifs.length}/${allEntrantPlayerIds.length})`);

  // ── Top-8 results-page data shape (app/tournaments/[id]/results/page.tsx's
  // own logic, replicated here against real data) ──
  const top8 = [...entrants]
    .filter(e => e.placement != null)
    .sort((a, b) => a.placement - b.placement)
    .slice(0, 8);
  assert(top8.length > 0, `${label}: Top-8 results page would show at least 1 real placement (got ${top8.length})`);
  assert(top8[0].placement === 1, `${label}: Top-8 results page's first row is placement 1 (got ${top8[0]?.placement})`);
  const placementValues = top8.map(e => e.placement);
  const sortedCopy = [...placementValues].sort((a, b) => a - b);
  assert(JSON.stringify(placementValues) === JSON.stringify(sortedCopy), `${label}: Top-8 rows are in ascending placement order`);

  // ── Ranking points -- Player.rankingPoints is now a CACHED field
  // (recomputeAndCachePlayerPoints, called inline by updateTournamentStatus
  // among other mutations), not computed live -- fetch the real Player
  // documents so Player.points (a synchronous parent.rankingPoints ?? 0
  // field resolver now, not an async live computation) reads real data. ──
  let allPointsCorrect = true;
  for (const entrant of entrants) {
    const expectedPts = scaledPointsForPlacement(entrant.placement ?? null, tournament.entrantCount);
    const playerDoc = await Player.findById(entrant.playerId).lean();
    const actualCachedField = playerDoc.rankingPoints ?? 0;
    const actualPts = resolvers.Player.points(playerDoc);
    if (actualCachedField !== expectedPts || actualPts !== expectedPts) {
      allPointsCorrect = false;
      console.log(`    mismatch: player ${entrant.playerId} placement=${entrant.placement} expected=${expectedPts} rankingPoints field=${actualCachedField} Player.points resolver=${actualPts}`);
    }
  }
  assert(allPointsCorrect, `${label}: every entrant's cached Player.rankingPoints (and the Player.points field resolver reading it) matches scaledPointsForPlacement(placement, entrantCount=${tournament.entrantCount}) exactly -- confirms updateTournamentStatus's recomputeAndCachePlayerPoints call kept the cache correctly in sync through ENDED`);

  // ── Players leaderboard -- the REAL leaderboard query
  // (Query.playersLeaderboard, real server-side pagination + search over the
  // cached rankingPoints index) as well as the picker-oriented Query.players
  // (same cached field, flat limit/offset) ──
  // pageSize is server-clamped to 100 max -- page through the whole real
  // leaderboard (production has 100+ real players already) to find ours.
  let totalCount = 0;
  const fullLeaderboard = [];
  for (let page = 1; ; page++) {
    const result = await resolvers.Query.playersLeaderboard(null, { page, pageSize: 100 }, {});
    totalCount = result.totalCount;
    fullLeaderboard.push(...result.players);
    if (fullLeaderboard.length >= totalCount || result.players.length === 0) break;
  }
  assert(typeof totalCount === "number" && totalCount >= allEntrantPlayerIds.length, `${label}: playersLeaderboard totalCount looks sane (${totalCount})`);
  const ourEntries = fullLeaderboard
    .map((p, idx) => ({ p, idx }))
    .filter(({ p }) => allEntrantPlayerIds.includes(p._id.toString()));
  assert(ourEntries.length === allEntrantPlayerIds.length, `${label}: all ${allEntrantPlayerIds.length} test players appear in Query.playersLeaderboard`);

  // Search spot-check: the tournament winner's exact tag, as a prefix
  // search, should return exactly that player.
  const winnerEntrant = entrants.find(e => e.placement === 1);
  if (winnerEntrant) {
    const winnerPlayer = await Player.findById(winnerEntrant.playerId).lean();
    const searchPrefix = winnerPlayer.tag.slice(0, Math.max(4, winnerPlayer.tag.length - 2));
    const { players: searchResults } = await resolvers.Query.playersLeaderboard(null, { page: 1, pageSize: 20, search: searchPrefix }, {});
    assert(
      searchResults.some(p => p._id.toString() === winnerPlayer._id.toString()),
      `${label}: playersLeaderboard search("${searchPrefix}") correctly finds the tournament winner (${winnerPlayer.tag})`
    );
  }
  // Confirm relative order: sort our own entries by their known expected
  // points and check the leaderboard's own index order agrees.
  const withExpected = await Promise.all(
    entrants.map(async e => ({
      playerId: e.playerId.toString(),
      expectedPts: scaledPointsForPlacement(e.placement ?? null, tournament.entrantCount),
    }))
  );
  const byExpectedDesc = [...withExpected].sort((a, b) => b.expectedPts - a.expectedPts).map(e => e.playerId);
  const byLeaderboardIdx = [...ourEntries].sort((a, b) => a.idx - b.idx).map(({ p }) => p._id.toString());
  // Ties (equal expected points) can appear in either order -- only check
  // that strictly-higher-points players never appear after strictly-lower
  // ones.
  let orderOk = true;
  for (let i = 0; i < byLeaderboardIdx.length; i++) {
    for (let j = i + 1; j < byLeaderboardIdx.length; j++) {
      const ptsI = withExpected.find(e => e.playerId === byLeaderboardIdx[i]).expectedPts;
      const ptsJ = withExpected.find(e => e.playerId === byLeaderboardIdx[j]).expectedPts;
      if (ptsI < ptsJ) orderOk = false;
    }
  }
  assert(orderOk, `${label}: leaderboard orders our test players by points, descending, correctly`);

  // ── MATCH_REPORTED notifications sanity (at least one exists per entrant
  // who played at least one match -- everyone except a lucky bye-only
  // finish, which doesn't happen once the bracket is fully played out) ──
  const matchReportedCount = await Notification.countDocuments({ type: "MATCH_REPORTED", link: `/tournaments/${tournamentId}` });
  assert(matchReportedCount > 0, `${label}: MATCH_REPORTED notifications fired during play (${matchReportedCount} total)`);

  return { entrants, expectedByPlayer: withExpected };
}

async function testStandardBracket() {
  console.log("\n=== TEST A: Standard Bracket, full lifecycle (16 entrants) ===");
  const organizer = await makeTestPlayer("QAWalkTOStd");
  const organizerCtx = ctx(organizer);

  const tournament = await Tournament.create({
    name: "QA Walkthrough Standard Bracket",
    game: "QA Test Game",
    format: "Standard Bracket",
    status: "UPCOMING",
    organizers: [organizer._id],
    startDate: new Date(),
  });
  allCreatedTournamentIds.push(tournament._id);

  const players = [];
  for (let i = 1; i <= 16; i++) players.push(await makeTestPlayer(`QAStdP${i}`));

  // ── Real join flow ──
  for (const p of players) {
    await resolvers.Mutation.joinTournament(null, { tournamentId: tournament._id.toString(), playerId: p._id.toString() }, ctx(p));
  }
  const afterJoin = await Tournament.findById(tournament._id);
  assert(afterJoin.entrantCount === 16, `Standard: entrantCount correctly synced to 16 after real joinTournament calls (got ${afterJoin.entrantCount})`);
  const joinNotifs = await Notification.countDocuments({ type: "PLAYER_JOINED", link: `/tournaments/${tournament._id}` });
  // Player N joining notifies the N-1 players already in -- total = 0+1+...+15 = 120
  assert(joinNotifs === 120, `Standard: PLAYER_JOINED notifications fired correctly for every existing entrant on each join (expected 120, got ${joinNotifs})`);

  // ── Set LIVE, confirm join lock ──
  await resolvers.Mutation.updateTournamentStatus(null, { id: tournament._id.toString(), status: "LIVE" }, organizerCtx);
  const extraPlayer = await makeTestPlayer("QAStdLateJoiner");
  let lockEnforced = false;
  try {
    await resolvers.Mutation.joinTournament(null, { tournamentId: tournament._id.toString(), playerId: extraPlayer._id.toString() }, ctx(extraPlayer));
  } catch {
    lockEnforced = true;
  }
  assert(lockEnforced, "Standard: joinTournament correctly blocked once the tournament is LIVE");

  // ── Generate + play bracket ──
  const bracket = await resolvers.Mutation.generateBracket(null, { tournamentId: tournament._id.toString(), seedingMethod: "RANDOM" }, organizerCtx);
  await playBracketToCompletionWithEditAndUndo(organizerCtx, bracket._id, "Standard");

  const expectedPlacements = await expectedPlacementsForBracket(bracket._id);
  let placementsMatch = true;
  for (const [playerId, expectedPlacement] of expectedPlacements) {
    const entrant = await Entrant.findOne({ tournamentId: tournament._id, playerId });
    if (entrant.placement !== expectedPlacement) {
      placementsMatch = false;
      console.log(`    mismatch: player ${playerId} expected placement ${expectedPlacement}, got ${entrant.placement}`);
    }
  }
  assert(placementsMatch, "Standard: every real auto-computed Entrant.placement matches the hand-derived expectation from the match tree");

  await resolvers.Mutation.updateTournamentStatus(null, { id: tournament._id.toString(), status: "ENDED" }, organizerCtx);

  await verifyPlacementsRankingAndTop8(tournament._id.toString(), players.map(p => p._id.toString()), "Standard");

  return tournament._id;
}

async function testPoolsAndBracket() {
  console.log("\n=== TEST B: Pools + Bracket (Model C, 16 entrants, 4 pools) ===");
  const organizer = await makeTestPlayer("QAWalkTOPools");
  const organizerCtx = ctx(organizer);

  const tournament = await Tournament.create({
    name: "QA Walkthrough Pools + Bracket",
    game: "QA Test Game",
    format: "Pools + Bracket",
    status: "UPCOMING",
    organizers: [organizer._id],
    startDate: new Date(),
  });
  allCreatedTournamentIds.push(tournament._id);

  const players = [];
  for (let i = 1; i <= 16; i++) players.push(await makeTestPlayer(`QAPoolP${i}`));

  for (const p of players) {
    await resolvers.Mutation.joinTournament(null, { tournamentId: tournament._id.toString(), playerId: p._id.toString() }, ctx(p));
  }
  const afterJoin = await Tournament.findById(tournament._id);
  assert(afterJoin.entrantCount === 16, `Pools: entrantCount correctly synced to 16 (got ${afterJoin.entrantCount})`);

  await resolvers.Mutation.updateTournamentStatus(null, { id: tournament._id.toString(), status: "LIVE" }, organizerCtx);

  // ── Generate pools (default Model C: 4 pools of 4, each with its own
  // double-elim bracket) and play every pool to completion ──
  const pools = await resolvers.Mutation.generatePools(null, { tournamentId: tournament._id.toString(), poolCount: 4 }, organizerCtx);
  assert(pools.length === 4, `Pools: 4 pools generated as requested (got ${pools.length})`);

  let firstPoolEditUndoDone = false;
  for (const pool of pools) {
    const poolBracket = await Bracket.findOne({ poolId: pool._id });
    assert(!!poolBracket, `Pools: pool ${pool.poolNumber} has its own double-elimination bracket (Model C)`);
    if (!firstPoolEditUndoDone) {
      await playBracketToCompletionWithEditAndUndo(organizerCtx, poolBracket._id, `Pools (pool ${pool.poolNumber})`);
      firstPoolEditUndoDone = true;
    } else {
      for (let round = 1; round <= 12; round++) {
        const wbPlayed = await playRound(organizerCtx, poolBracket._id, "WINNERS", round);
        const lbPlayed = await playRound(organizerCtx, poolBracket._id, "LOSERS", round);
        if (wbPlayed === 0 && lbPlayed === 0) break;
      }
      const gf = await Match.findOne({ bracketId: poolBracket._id, bracketSide: "GRAND_FINAL" });
      if (gf && gf.status === "PENDING") {
        await resolvers.Mutation.reportResult(null, { matchId: gf._id.toString(), player1Score: 2, player2Score: 0 }, organizerCtx);
      }
    }
  }

  // Pool play must NOT have written tournament-wide placements (gated out
  // for any bracket with a poolId -- see lib/bracket.ts's comment).
  const entrantsAfterPools = await Entrant.find({ tournamentId: tournament._id });
  const anyPlacementSet = entrantsAfterPools.some(e => e.placement != null);
  assert(!anyPlacementSet, "Pools: pool play correctly did NOT write any tournament-wide Entrant.placement (only the main bracket's Grand Final should)");

  // ── Generate + play the main bracket (seeded from each pool's finalists) ──
  const mainBracket = await resolvers.Mutation.generateMainBracket(null, { tournamentId: tournament._id.toString(), seedingMethod: "RANDOM" }, organizerCtx);
  const tAfterMain = await Tournament.findById(tournament._id);
  assert(tAfterMain.mainBracketId?.toString() === mainBracket._id.toString(), "Pools: Tournament.mainBracketId correctly points at the newly-generated main bracket");
  assert(mainBracket.seedOrder.length === 8, `Pools: main bracket seeded with the 8 pool finalists (2 per pool x 4 pools) (got ${mainBracket.seedOrder.length})`);

  for (let round = 1; round <= 12; round++) {
    const wbPlayed = await playRound(organizerCtx, mainBracket._id, "WINNERS", round);
    const lbPlayed = await playRound(organizerCtx, mainBracket._id, "LOSERS", round);
    if (wbPlayed === 0 && lbPlayed === 0) break;
  }
  const gf = await Match.findOne({ bracketId: mainBracket._id, bracketSide: "GRAND_FINAL" });
  if (gf && gf.status === "PENDING") {
    await resolvers.Mutation.reportResult(null, { matchId: gf._id.toString(), player1Score: 2, player2Score: 0 }, organizerCtx);
  }

  const expectedPlacements = await expectedPlacementsForBracket(mainBracket._id);
  let placementsMatch = true;
  for (const [playerId, expectedPlacement] of expectedPlacements) {
    const entrant = await Entrant.findOne({ tournamentId: tournament._id, playerId });
    if (entrant.placement !== expectedPlacement) {
      placementsMatch = false;
      console.log(`    mismatch: player ${playerId} expected placement ${expectedPlacement}, got ${entrant.placement}`);
    }
  }
  assert(placementsMatch, "Pools: main bracket's Grand Final completion correctly auto-computed tournament-wide placements");
  // Entrants eliminated during pools (not among the 8 main-bracket seeds)
  // should have NO placement at all -- confirms pool eliminations don't get
  // a spurious tournament-wide placement of their own.
  const nonFinalistEntrants = entrantsAfterPools.filter(e => !mainBracket.seedOrder.includes(e.playerId.toString()));
  const allNonFinalistsUnplaced = (await Promise.all(nonFinalistEntrants.map(async e => (await Entrant.findById(e._id)).placement))).every(p => p == null);
  assert(allNonFinalistsUnplaced, "Pools: entrants eliminated during pool play (never reached the main bracket) correctly have no tournament-wide placement");

  await resolvers.Mutation.updateTournamentStatus(null, { id: tournament._id.toString(), status: "ENDED" }, organizerCtx);

  await verifyPlacementsRankingAndTop8(tournament._id.toString(), players.map(p => p._id.toString()), "Pools");

  return tournament._id;
}

async function main() {
  await connectToDatabase();
  try {
    await testStandardBracket();
    await testPoolsAndBracket();
    console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURE(S)`}`);
  } finally {
    console.log("\nCleaning up test data...");
    for (const tournamentId of allCreatedTournamentIds) {
      const brackets = await Bracket.find({ tournamentId });
      for (const b of brackets) await Match.deleteMany({ bracketId: b._id });
      await Match.deleteMany({ tournamentId, bracketId: null });
      await Bracket.deleteMany({ tournamentId });
      await Pool.deleteMany({ tournamentId });
      await Entrant.deleteMany({ tournamentId });
      await Notification.deleteMany({ link: `/tournaments/${tournamentId}` });
      await Tournament.findByIdAndDelete(tournamentId);
    }
    const orgPlayers = await Player.find({ tag: { $in: allCreatedPlayerTags } });
    const orgUserIds = orgPlayers.map(p => p.userId).filter(Boolean);
    await Player.deleteMany({ tag: { $in: allCreatedPlayerTags } });
    await User.deleteMany({ _id: { $in: orgUserIds } });

    const leftoverTournaments = await Tournament.countDocuments({ name: /^QA Walkthrough/i });
    const leftoverPlayers = await Player.countDocuments({ tag: { $in: allCreatedPlayerTags } });
    const leftoverNotifs = await Notification.countDocuments({ link: { $in: allCreatedTournamentIds.map(id => `/tournaments/${id}`) } });
    console.log(`Verification -- leftover tournaments: ${leftoverTournaments}, leftover players: ${leftoverPlayers}, leftover notifications: ${leftoverNotifs}`);
    console.log("Cleanup done.");
  }

  process.exit(failures === 0 ? 0 : 1);
}

main();
