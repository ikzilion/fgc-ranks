// scripts/testUndoMatchResult.mjs
//
// Functional verification for the Undo feature (undoMatchResult mutation +
// Match.canUndo field resolver) that replaces the old per-match Delete
// action (deleteMatch/deleteMatchWithCascade, removed -- its arbitrary-depth
// cascade was found to be silently breaking live brackets in production).
// Same approach as the other scripts/test*.mjs files -- calls the REAL
// resolver functions against real data in the actual database.
//
// TEST 1: canUndo/undoMatchResult correctly identify a bracket's CURRENT
// terminal match(es) -- a completed Winners Round 1 match with its
// downstream Winners Round 2 match not yet played is undo-able; the moment
// that downstream match is played, the feeder becomes NOT undo-able, while
// siblings whose own downstream match is still unplayed remain undo-able.
// Confirms the reversed match goes back to PENDING with score/winner
// cleared and both players' win/loss stats correctly reversed.
//
// TEST 2: undoing a natural (no-reset) Grand Final un-applies the automatic
// placements it triggered, EXCEPT a manually-set one (placementSetManually),
// which survives completely untouched.
//
// TEST 3: a Grand Final that spawned a Reset (losers-side finalist won game
// 1) is correctly NOT undo-able itself (a Reset existing at all blocks it,
// per assertBracketMatchEditable's own Grand-Final-specific check) --
// confirmed via BOTH canUndo === false AND a real undoMatchResult call
// throwing. The Reset match itself, once completed, IS the real terminal
// match and IS undo-able.
//
// Run: npx tsx scripts/testUndoMatchResult.mjs

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
const { resolvers } = await import("../graphql/resolvers/index");
const { createLoaders } = await import("../graphql/loaders");

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

async function main() {
  await connectToDatabase();
  const createdTournamentIds = [];
  const createdPlayerTags = [];

  try {
    console.log("\n=== TEST 1: canUndo/undoMatchResult identify the real current terminal match(es) ===");

    const organizer = await makeTestPlayer("UndoMatchTO");
    createdPlayerTags.push("UndoMatchTO");
    const organizerCtx = { playerId: organizer._id.toString(), role: "USER" };

    const players = [];
    for (let i = 1; i <= 8; i++) {
      const p = await makeTestPlayer(`UndoMatchP${i}`);
      createdPlayerTags.push(`UndoMatchP${i}`);
      players.push(p);
    }

    const tournament = await Tournament.create({
      name: "Undo Match Test",
      game: "Test Game",
      format: "Standard Bracket",
      organizers: [organizer._id],
      startDate: new Date(),
      entrantCount: 8,
    });
    createdTournamentIds.push(tournament._id);
    const entrants = await Entrant.insertMany(players.map(p => ({ playerId: p._id, tournamentId: tournament._id })));

    const bracket = await resolvers.Mutation.generateBracket(
      null,
      { tournamentId: tournament._id.toString(), seedingMethod: "RANDOM" },
      organizerCtx
    );

    const wbRound1 = await Match.find({ bracketId: bracket._id, bracketSide: "WINNERS", bracketRound: 1 }).sort({ bracketPosition: 1 });
    assert(wbRound1.length === 4, `Real 8-entrant bracket has 4 real Winners Round 1 matches (got ${wbRound1.length})`);

    // Play all 4 WB Round 1 matches (player1 always wins, same convention
    // other test scripts use).
    for (const m of wbRound1) {
      await resolvers.Mutation.reportResult(null, { matchId: m._id.toString(), player1Score: 2, player2Score: 0 }, organizerCtx);
    }

    // Refetch — every WB Round 1 match is now COMPLETED with its downstream
    // WB Round 2 match still PENDING (unplayed) -- all 4 should be undo-able
    // right now, simultaneously.
    const wbRound1AfterPlay = await Match.find({ _id: { $in: wbRound1.map(m => m._id) } });
    for (const m of wbRound1AfterPlay) {
      assert(await resolvers.Match.canUndo(m, null, { loaders: createLoaders() }) === true, `WB Round 1 match "${m.round}" is undo-able before its downstream match is played`);
    }

    // Play ONLY the first WB Round 2 match (consumes 2 of the 4 WB Round 1
    // winners) -- leave the second WB Round 2 match unplayed.
    const wbRound2 = await Match.find({ bracketId: bracket._id, bracketSide: "WINNERS", bracketRound: 2 }).sort({ bracketPosition: 1 });
    assert(wbRound2.length === 2, `Real 8-entrant bracket has 2 real Winners Round 2 matches (got ${wbRound2.length})`);
    await resolvers.Mutation.reportResult(null, { matchId: wbRound2[0]._id.toString(), player1Score: 2, player2Score: 0 }, organizerCtx);

    const feedersOfPlayed = wbRound1AfterPlay.filter(m => m.nextMatchId?.toString() === wbRound2[0]._id.toString());
    const feedersOfUnplayed = wbRound1AfterPlay.filter(m => m.nextMatchId?.toString() === wbRound2[1]._id.toString());
    assert(feedersOfPlayed.length === 2 && feedersOfUnplayed.length === 2, `Confirmed real feeder split: 2 WB R1 matches feed the now-played WB R2 match, 2 feed the still-unplayed one (got ${feedersOfPlayed.length}/${feedersOfUnplayed.length})`);

    for (const m of feedersOfPlayed) {
      const fresh = await Match.findById(m._id);
      assert(await resolvers.Match.canUndo(fresh, null, { loaders: createLoaders() }) === false, `WB R1 match feeding the NOW-PLAYED WB R2 match is no longer undo-able`);
      const attempted = await resolvers.Mutation.undoMatchResult(null, { matchId: fresh._id.toString() }, { ...organizerCtx, loaders: createLoaders() }).then(() => null).catch(e => e);
      assert(attempted instanceof Error, `A real undoMatchResult call on it is actually blocked (throws), not silently allowed`);
    }
    for (const m of feedersOfUnplayed) {
      const fresh = await Match.findById(m._id);
      assert(await resolvers.Match.canUndo(fresh, null, { loaders: createLoaders() }) === true, `WB R1 match feeding the STILL-UNPLAYED WB R2 match remains undo-able`);
    }

    // Actually undo one of the still-eligible ones and confirm the real
    // reversal: PENDING again, score/winner cleared, both players' win/loss
    // stats reversed.
    const toUndo = feedersOfUnplayed[0];
    const p1BeforeWins = (await Player.findById(toUndo.player1Id)).wins;
    const p2BeforeLosses = (await Player.findById(toUndo.player2Id)).losses;

    const undone = await resolvers.Mutation.undoMatchResult(null, { matchId: toUndo._id.toString() }, { ...organizerCtx, loaders: createLoaders() });
    assert(undone.status === "PENDING", `Undone match's real status is PENDING (got ${undone.status})`);
    assert(undone.winnerId == null, "Undone match's real winnerId is cleared");
    assert(undone.player1Score === 0 && undone.player2Score === 0, `Undone match's real score is cleared to 0-0 (got ${undone.player1Score}-${undone.player2Score})`);

    const p1After = await Player.findById(toUndo.player1Id);
    const p2After = await Player.findById(toUndo.player2Id);
    assert(p1After.wins === p1BeforeWins - 1, `Winner's real win count reversed (${p1BeforeWins} -> ${p1After.wins})`);
    assert(p2After.losses === p2BeforeLosses - 1, `Loser's real loss count reversed (${p2BeforeLosses} -> ${p2After.losses})`);

    console.log("\n=== TEST 2: undoing a natural (no-reset) Grand Final un-applies auto placements, except a manually-set one ===");

    // Re-play the whole bracket to completion cleanly (a fresh 8-entrant
    // tournament) -- player1 always wins, so Grand Finals goes straight, no
    // reset. Playing round-by-round exactly like the other test scripts'
    // playBracketToCompletion helper.
    const tournament2 = await Tournament.create({
      name: "Undo Match Test GF",
      game: "Test Game",
      format: "Standard Bracket",
      organizers: [organizer._id],
      startDate: new Date(),
      entrantCount: 8,
    });
    createdTournamentIds.push(tournament2._id);
    const players2 = [];
    for (let i = 1; i <= 8; i++) {
      const p = await makeTestPlayer(`UndoMatchGF${i}`);
      createdPlayerTags.push(`UndoMatchGF${i}`);
      players2.push(p);
    }
    await Entrant.insertMany(players2.map(p => ({ playerId: p._id, tournamentId: tournament2._id })));
    const bracket2 = await resolvers.Mutation.generateBracket(null, { tournamentId: tournament2._id.toString(), seedingMethod: "RANDOM" }, organizerCtx);

    async function playRound(bracketId, side, round) {
      const ready = await Match.find({ bracketId, bracketSide: side, bracketRound: round, status: "PENDING", player1Id: { $ne: null }, player2Id: { $ne: null } });
      for (const m of ready) await resolvers.Mutation.reportResult(null, { matchId: m._id.toString(), player1Score: 2, player2Score: 0 }, organizerCtx);
      return ready.length;
    }
    for (let round = 1; round <= 6; round++) {
      const wb = await playRound(bracket2._id, "WINNERS", round);
      const lb = await playRound(bracket2._id, "LOSERS", round);
      if (wb === 0 && lb === 0) break;
    }
    const gf2 = await Match.findOne({ bracketId: bracket2._id, bracketSide: "GRAND_FINAL" });

    // Manually set the Grand Final loser's placement BEFORE undoing --
    // should survive the undo untouched.
    const gfLoserId = gf2.player2Id;
    const gfLoserEntrant = await Entrant.findOne({ tournamentId: tournament2._id, playerId: gfLoserId });
    await resolvers.Mutation.setPlacement(null, { entrantId: gfLoserEntrant._id.toString(), placement: 999 }, organizerCtx);

    if (gf2.status !== "COMPLETED") {
      await resolvers.Mutation.reportResult(null, { matchId: gf2._id.toString(), player1Score: 2, player2Score: 0 }, organizerCtx);
    }
    const gf2Fresh = await Match.findById(gf2._id);
    assert(gf2Fresh.status === "COMPLETED", "Real Grand Final is COMPLETED (no reset — player1/winners-side always wins under this test's convention)");
    assert(await resolvers.Match.canUndo(gf2Fresh, null, { loaders: createLoaders() }) === true, "A natural (no-reset) completed Grand Final with nothing downstream is undo-able");

    const winnerEntrant = await Entrant.findOne({ tournamentId: tournament2._id, playerId: gf2Fresh.player1Id });
    const winnerPlacementBefore = winnerEntrant.placement;
    assert(winnerPlacementBefore === 1, `Before undo: real Grand Final winner's auto-applied placement is 1st (got ${winnerPlacementBefore})`);

    const gfLoserBefore = await Entrant.findById(gfLoserEntrant._id);
    assert(gfLoserBefore.placement === 999 && gfLoserBefore.placementSetManually === true, "Before undo: the manually-set placement (999) and its manual flag are in place");

    await resolvers.Mutation.undoMatchResult(null, { matchId: gf2Fresh._id.toString() }, { ...organizerCtx, loaders: createLoaders() });

    const winnerEntrantAfter = await Entrant.findById(winnerEntrant._id);
    assert(winnerEntrantAfter.placement == null, `After undo: the auto-applied Grand Final winner placement is un-applied back to null (got ${winnerEntrantAfter.placement})`);

    const gfLoserAfter = await Entrant.findById(gfLoserEntrant._id);
    assert(gfLoserAfter.placement === 999, `After undo: the MANUALLY-set placement (999) survives completely untouched (got ${gfLoserAfter.placement})`);

    const gfMatchAfter = await Match.findById(gf2Fresh._id);
    assert(gfMatchAfter.status === "PENDING" && gfMatchAfter.winnerId == null, "After undo: the real Grand Final match itself is back to PENDING with no winner");

    console.log("\n=== TEST 3: a Grand Final that spawned a Reset is NOT undo-able itself; the Reset (once played) is the real terminal match ===");

    const tournament3 = await Tournament.create({
      name: "Undo Match Test Reset",
      game: "Test Game",
      format: "Standard Bracket",
      organizers: [organizer._id],
      startDate: new Date(),
      entrantCount: 8,
    });
    createdTournamentIds.push(tournament3._id);
    const players3 = [];
    for (let i = 1; i <= 8; i++) {
      const p = await makeTestPlayer(`UndoMatchRST${i}`);
      createdPlayerTags.push(`UndoMatchRST${i}`);
      players3.push(p);
    }
    await Entrant.insertMany(players3.map(p => ({ playerId: p._id, tournamentId: tournament3._id })));
    const bracket3 = await resolvers.Mutation.generateBracket(null, { tournamentId: tournament3._id.toString(), seedingMethod: "RANDOM" }, organizerCtx);
    for (let round = 1; round <= 6; round++) {
      const wb = await playRound(bracket3._id, "WINNERS", round);
      const lb = await playRound(bracket3._id, "LOSERS", round);
      if (wb === 0 && lb === 0) break;
    }
    const gf3 = await Match.findOne({ bracketId: bracket3._id, bracketSide: "GRAND_FINAL" });
    // Force a reset: the losers-side finalist (player2) wins game 1.
    await resolvers.Mutation.reportResult(null, { matchId: gf3._id.toString(), player1Score: 0, player2Score: 2 }, organizerCtx);

    const resetMatch = await Match.findOne({ bracketId: bracket3._id, bracketSide: "GRAND_FINAL_RESET" });
    assert(!!resetMatch, "Real Grand Final Reset match was actually created after the losers-side finalist won game 1");

    const gf3Fresh = await Match.findById(gf3._id);
    assert(gf3Fresh.status === "COMPLETED", "The real Grand Final itself is COMPLETED (game 1's result)");
    assert(await resolvers.Match.canUndo(gf3Fresh, null, { loaders: createLoaders() }) === false, "The Grand Final is NOT undo-able once a Reset exists, even though it has no nextMatchId of its own");
    const gfUndoAttempt = await resolvers.Mutation.undoMatchResult(null, { matchId: gf3Fresh._id.toString() }, { ...organizerCtx, loaders: createLoaders() }).then(() => null).catch(e => e);
    assert(gfUndoAttempt instanceof Error, "A real undoMatchResult call on the Grand Final is actually blocked while the Reset exists");

    assert(await resolvers.Match.canUndo(resetMatch, null, { loaders: createLoaders() }) === false, "The Reset match itself is not undo-able yet while still PENDING (nothing to undo)");

    await resolvers.Mutation.reportResult(null, { matchId: resetMatch._id.toString(), player1Score: 2, player2Score: 0 }, organizerCtx);
    const resetFreshAfterPlay = await Match.findById(resetMatch._id);
    assert(await resolvers.Match.canUndo(resetFreshAfterPlay, null, { loaders: createLoaders() }) === true, "Once played, the Reset match IS the real current terminal match and IS undo-able");

    const resetWinnerId = resetFreshAfterPlay.winnerId;
    const resetWinnerWinsBefore = (await Player.findById(resetWinnerId)).wins;
    await resolvers.Mutation.undoMatchResult(null, { matchId: resetFreshAfterPlay._id.toString() }, { ...organizerCtx, loaders: createLoaders() });
    const resetAfterUndo = await Match.findById(resetMatch._id);
    assert(resetAfterUndo.status === "PENDING", "After undo: the real Reset match is back to PENDING");
    const resetWinnerAfter = await Player.findById(resetWinnerId);
    assert(resetWinnerAfter.wins === resetWinnerWinsBefore - 1, "After undo: the Reset winner's real win count is reversed");

    console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURE(S)`}`);
  } finally {
    console.log("\nCleaning up test data...");
    for (const tournamentId of createdTournamentIds) {
      const tournamentDoc = await Tournament.findById(tournamentId);
      const { Bracket } = await import("../models/Bracket");
      const brackets = await Bracket.find({ tournamentId });
      for (const b of brackets) await Match.deleteMany({ bracketId: b._id });
      await Bracket.deleteMany({ tournamentId });
      await Entrant.deleteMany({ tournamentId });
      await Tournament.findByIdAndDelete(tournamentId);
    }
    const orgPlayers = await Player.find({ tag: { $in: createdPlayerTags } });
    const orgUserIds = orgPlayers.map(p => p.userId).filter(Boolean);
    await Player.deleteMany({ tag: { $in: createdPlayerTags } });
    await User.deleteMany({ _id: { $in: orgUserIds } });

    const leftoverTournaments = await Tournament.countDocuments({ name: /^Undo Match Test/i });
    const leftoverPlayers = await Player.countDocuments({ tag: { $in: createdPlayerTags } });
    console.log(`Verification -- leftover tournaments: ${leftoverTournaments}, leftover players: ${leftoverPlayers}`);
    console.log("Cleanup done.");
  }

  process.exit(failures === 0 ? 0 : 1);
}

main();
