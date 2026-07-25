// scripts/testModelBAdvanceRound.mjs
//
// Functional verification for Pool format Model B, Phase 5: the new
// advanceModelBRound mutation (graphql/resolvers/index.ts) that advances a
// LIVE Model B tournament round-to-round using REAL match results. Same
// approach as scripts/testModelBPoolsFeature.mjs / testMatchDeleteCascade.mjs
// — calls the REAL GraphQL resolver functions against real data in the
// actual database, driven by a fully DETERMINISTIC "player1 always wins"
// scoring rule (same convention testMatchDeleteCascade.mjs established) so
// every match's outcome, and therefore every real advancer this phase's new
// logic (lib/bracket.ts's extractPoolSurvivors) reads off, can be
// HAND-DERIVED and cross-checked exactly, not just checked for "didn't
// crash".
//
// Since Model B's real bracket shapes (Round 1's flat pools, Round 2+'s
// repooled brackets, the Finals-cutoff bracket) are too varied to predict by
// manual seed-position arithmetic, this test instead reimplements a small,
// GENERIC bracket-graph simulator (simulateBracket) that walks a bracket's
// freshly-generated (unplayed) match drafts under the SAME player1-always-
// wins rule, propagating winners/losers via nextMatchId/nextLoserMatchId --
// entirely independently of lib/bracket.ts's own progression code
// (advanceBracketMatch), so its predictions are a genuine cross-check, not a
// restatement of the code under test. deriveSurvivors then reads a pool's
// real "3 advancers" off those SIMULATED results using the same structural
// approach extractPoolSurvivors itself uses (Grand Final convention, the
// Winners-side match feeding it, ranked-by-depth further Losers losers,
// deduped) -- reimplemented from scratch in this file, not imported.
//
// TEST 1 runs a 128-entrant Model B tournament through its ENTIRE real
// lifecycle: Round 1 (16 flat pools) -> [advance] -> Round 2 (4 repooled
// pools, MERGE stage) -> [advance] -> a Semifinal Finals-cutoff pool (24
// entrants, FINAL_CONSOLIDATION + splitsIntoFinals) -> [advance] -> the real
// Finals bracket (Tournament.mainBracketId). Round 1 -> Round 2's hand-off is
// verified EXACTLY (every new pool's Bracket.seedOrder must match the
// hand-derived real advancers precisely, in order). Round 2 -> Semifinal and
// Semifinal -> Finals are verified by real-identity membership (every
// hand-derived expected advancer is present, no duplicates, no phantom
// IDs) -- exact per-slot ranking beyond each pool's top 2 (WB champion +
// Winners-Final loser/Losers-bracket champion) depends on ranking ties this
// test doesn't attempt to fully resolve, but every guaranteed top-priority
// advancer is checked precisely.
//
// TEST 2 confirms advanceModelBRound rejects an incomplete round -- both
// when NO pool has been played yet, and when only SOME of the round's pools
// have finished.
//
// Run: npx tsx scripts/testModelBAdvanceRound.mjs

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
const { extractPoolSurvivors } = await import("../lib/bracket");
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

// ─── Deterministic play ───────────────────────────────────────────────────

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
    await resolvers.Mutation.reportResult(null, { matchId: match._id.toString(), player1Score: 2, player2Score: 0 }, organizerCtx);
  }
  return ready.length;
}

// Plays a normal bracket (with its own Grand Final) to completion. Player1
// always wins, so the winners-side finalist always takes the Grand Final
// straight -- no reset is ever triggered by this determinism (reset-path
// coverage already lives in scripts/testPoolsFeature.mjs).
async function playBracketToCompletion(organizerCtx, bracketId) {
  for (let round = 1; round <= 12; round++) {
    const wbPlayed = await playRound(organizerCtx, bracketId, "WINNERS", round);
    const lbPlayed = await playRound(organizerCtx, bracketId, "LOSERS", round);
    if (wbPlayed === 0 && lbPlayed === 0) break;
  }
  const gf = await Match.findOne({ bracketId, bracketSide: "GRAND_FINAL" });
  if (gf && gf.status === "PENDING" && gf.player1Id && gf.player2Id) {
    await resolvers.Mutation.reportResult(null, { matchId: gf._id.toString(), player1Score: 2, player2Score: 0 }, organizerCtx);
  }
}

// A Model B Finals-cutoff pool has NO Grand Final by design -- just plays
// every Winners/Losers round to completion.
async function playFinalsCutoffToCompletion(organizerCtx, bracketId) {
  for (let round = 1; round <= 12; round++) {
    const wbPlayed = await playRound(organizerCtx, bracketId, "WINNERS", round);
    const lbPlayed = await playRound(organizerCtx, bracketId, "LOSERS", round);
    if (wbPlayed === 0 && lbPlayed === 0) break;
  }
}

// ─── Independent hand-derivation ───────────────────────────────────────────
//
// Reimplemented from scratch -- does NOT call lib/bracket.ts's
// advanceBracketMatch or extractPoolSurvivors. Walks a bracket's freshly-
// generated (all-PENDING) match drafts, resolving every match whose both
// slots are known under a pure "player1 always wins" rule, and propagating
// winners/losers forward via nextMatchId/nextLoserMatchId exactly the way
// buildMatch's own wireFeeder wrote them -- until nothing more resolves.

function simulateBracket(freshMatches) {
  const byId = new Map(
    freshMatches.map(m => [
      m._id.toString(),
      {
        player1Id: m.player1Id ? m.player1Id.toString() : null,
        player2Id: m.player2Id ? m.player2Id.toString() : null,
        nextMatchId: m.nextMatchId ? m.nextMatchId.toString() : null,
        nextMatchSlot: m.nextMatchSlot,
        nextLoserMatchId: m.nextLoserMatchId ? m.nextLoserMatchId.toString() : null,
        nextLoserMatchSlot: m.nextLoserMatchSlot,
      },
    ])
  );
  const results = new Map(); // matchId -> { winnerId, loserId }
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [id, m] of byId) {
      if (results.has(id)) continue;
      if (!m.player1Id || !m.player2Id) continue;
      const winnerId = m.player1Id;
      const loserId = m.player2Id;
      results.set(id, { winnerId, loserId });
      progressed = true;
      if (m.nextMatchId) {
        const target = byId.get(m.nextMatchId);
        if (target) target[m.nextMatchSlot === 1 ? "player1Id" : "player2Id"] = winnerId;
      }
      if (m.nextLoserMatchId) {
        const target = byId.get(m.nextLoserMatchId);
        if (target) target[m.nextLoserMatchSlot === 1 ? "player1Id" : "player2Id"] = loserId;
      }
    }
  }
  return results;
}

// Mirrors extractPoolSurvivors's own structural approach (Grand Final
// convention, the Winners-side match feeding it, ranked-by-depth further
// Losers losers, deduped since the Winners-Final loser can perfectly
// normally go on to win their own pool's Losers Finals too) -- but reading
// off `results` (this file's own independent simulation), not live DB state.
function deriveSurvivors(freshMatches, results) {
  const grandFinal = freshMatches.find(m => m.bracketSide === "GRAND_FINAL");
  const gfResult = results.get(grandFinal._id.toString());
  const winnersChampionId = gfResult.winnerId;
  const lbChampionId = gfResult.loserId;

  const wbFinalsMatch = freshMatches.find(m => m.bracketSide === "WINNERS" && m.nextMatchId?.toString() === grandFinal._id.toString());
  const wbFinalsLoserId = results.get(wbFinalsMatch._id.toString()).loserId;

  const loserSideMatches = freshMatches.filter(m => m.bracketSide === "LOSERS");
  const totalLBRounds = loserSideMatches.reduce((max, m) => Math.max(max, m.bracketRound), 0);
  const rankedFurtherLosers = [...loserSideMatches]
    .sort((a, b) => {
      const depthA = totalLBRounds - a.bracketRound;
      const depthB = totalLBRounds - b.bracketRound;
      return depthA !== depthB ? depthA - depthB : a.bracketPosition - b.bracketPosition;
    })
    .map(m => results.get(m._id.toString()).loserId);

  const seen = new Set();
  const losersSurvivorIds = [wbFinalsLoserId, lbChampionId, ...rankedFurtherLosers].filter(id => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  return { winnersChampionId, wbFinalsLoserId, lbChampionId, losersSurvivorIds };
}

async function main() {
  await connectToDatabase();
  const createdTournamentIds = [];

  try {
    // ═══════════════════════════════════════════════════════════════════
    // TEST 1: 128-entrant Model B tournament, full real lifecycle.
    // ═══════════════════════════════════════════════════════════════════
    console.log("\n=== TEST 1: Model B full advancement, 128 entrants ===");

    const organizer = await makeTestPlayer("ModelBAdvanceTO");
    const organizerCtx = { playerId: organizer._id.toString(), role: "USER" };

    const tournament = await Tournament.create({
      name: "Model B Advance Test",
      game: "Test Game",
      format: "Pools + Bracket",
      poolModel: "B",
      organizers: [organizer._id],
      startDate: new Date(),
      entrantCount: 128,
    });
    createdTournamentIds.push(tournament._id);
    await Entrant.insertMany(synthesizeEntrants(tournament._id, 128));

    // ── Round 1: generate, predict each pool's real advancers BEFORE
    // playing, then play for real and confirm the DB's actual Grand Final
    // matches the prediction. ──
    const round1Pools = await resolvers.Mutation.generateModelBPools(null, { tournamentId: tournament._id.toString() }, organizerCtx);
    assert(round1Pools.length === 16, `Round 1 has 16 pools (128 entrants, ~15/pool target, power-of-2) -- got ${round1Pools.length}`);
    assert(round1Pools.every(p => p.entrantIds.length === 8), "Every Round 1 pool has exactly 8 entrants (128/16, even split)");

    const round1Survivors = new Map();
    for (const pool of round1Pools) {
      const bracket = await Bracket.findOne({ poolId: pool._id });
      const freshMatches = await Match.find({ bracketId: bracket._id }).lean();
      const predicted = deriveSurvivors(freshMatches, simulateBracket(freshMatches));

      await playBracketToCompletion(organizerCtx, bracket._id);

      const gf = await Match.findOne({ bracketId: bracket._id, bracketSide: "GRAND_FINAL" });
      assert(gf.player1Id.toString() === predicted.winnersChampionId, `Pool ${pool.poolNumber}: real Grand Final winners-side finalist matches the hand-derived prediction`);
      assert(gf.player2Id.toString() === predicted.lbChampionId, `Pool ${pool.poolNumber}: real Grand Final losers-side finalist matches the hand-derived prediction`);

      round1Survivors.set(pool._id.toString(), predicted);
    }

    assert(
      (await resolvers.Tournament.modelBCurrentRoundComplete({ _id: tournament._id, poolModel: "B", mainBracketId: null })) === true,
      "modelBCurrentRoundComplete is true once every Round 1 pool finishes"
    );

    // ── Advance #1: Round 1 -> Round 2 (MERGE stage, 16 pools -> 4). Every
    // new pool's Bracket.seedOrder must match the hand-derived real
    // advancers EXACTLY, in order (winnersSurvivorIds then losersSurvivorIds,
    // per buildNewPoolFromGroup's own construction). ──
    const round2Pools = await resolvers.Mutation.advanceModelBRound(null, { tournamentId: tournament._id.toString() }, organizerCtx);
    assert(round2Pools.length === 4, `Advance #1 creates 4 Round-2 pools (16/4 merge) -- got ${round2Pools.length}`);
    assert(round2Pools.every(p => p.roundNumber === 2), "Every Round-2 pool has roundNumber 2");
    assert(round2Pools.every(p => p.entrantIds.length === 12), "Every Round-2 pool has 12 entrants (4 source pools x 3 real advancers)");

    const sortedRound1 = [...round1Pools].sort((a, b) => a.poolNumber - b.poolNumber);
    const sortedRound2 = [...round2Pools].sort((a, b) => a.poolNumber - b.poolNumber);

    for (let g = 0; g < 4; g++) {
      const group = sortedRound1.slice(g * 4, g * 4 + 4).map(p => round1Survivors.get(p._id.toString()));
      const expectedSeedOrder = [...group.map(s => s.winnersChampionId), ...group.flatMap(s => s.losersSurvivorIds.slice(0, 2))];
      const bracket = await Bracket.findOne({ poolId: sortedRound2[g]._id });
      const actualSeedOrder = bracket.seedOrder.map(id => id.toString());
      assert(
        JSON.stringify(actualSeedOrder) === JSON.stringify(expectedSeedOrder),
        `Round-2 pool ${sortedRound2[g].poolNumber}: Bracket.seedOrder exactly matches the hand-derived real advancers from source pools ${sortedRound1.slice(g * 4, g * 4 + 4).map(p => p.poolNumber).join(",")}`
      );
    }

    // ── Round 2: same predict-then-play-then-confirm pattern as Round 1. ──
    const round2Survivors = new Map();
    for (const pool of round2Pools) {
      const bracket = await Bracket.findOne({ poolId: pool._id });
      const freshMatches = await Match.find({ bracketId: bracket._id }).lean();
      const predicted = deriveSurvivors(freshMatches, simulateBracket(freshMatches));

      await playBracketToCompletion(organizerCtx, bracket._id);

      const gf = await Match.findOne({ bracketId: bracket._id, bracketSide: "GRAND_FINAL" });
      assert(gf.player1Id.toString() === predicted.winnersChampionId, `Round-2 pool ${pool.poolNumber}: real Grand Final winners-side finalist matches the hand-derived prediction`);
      assert(gf.player2Id.toString() === predicted.lbChampionId, `Round-2 pool ${pool.poolNumber}: real Grand Final losers-side finalist matches the hand-derived prediction`);

      round2Survivors.set(pool._id.toString(), predicted);
    }

    // ── Advance #2: Round 2 -> Semifinal (FINAL_CONSOLIDATION,
    // splitsIntoFinals -- a Finals-cutoff pool, no Grand Final of its own).
    // Verified by real-identity membership: every pool's top-priority
    // advancers (champion, Winners-Final loser, Losers-bracket champion --
    // always kept, since this stage's losersCount of 5 is well above 2) must
    // be present, with no duplicates and no phantom IDs. ──
    const advance2 = await resolvers.Mutation.advanceModelBRound(null, { tournamentId: tournament._id.toString() }, organizerCtx);
    assert(advance2.length === 1, `Advance #2 creates exactly 1 Semifinal pool -- got ${advance2.length}`);
    const semifinalPool = advance2[0];
    assert(semifinalPool.isFinalsCutoff === true, "Semifinal pool is marked isFinalsCutoff");
    assert(semifinalPool.roundNumber === 3, `Semifinal pool has roundNumber 3 -- got ${semifinalPool.roundNumber}`);
    assert(semifinalPool.entrantIds.length === 24, `Semifinal pool has 24 real entrants -- got ${semifinalPool.entrantIds.length}`);
    assert(Array.isArray(semifinalPool.finalsCutoffFinalistSpecs) && semifinalPool.finalsCutoffFinalistSpecs.length === 8, "Semifinal pool stored exactly 8 finalist resolution specs");

    const semifinalEntrants = await Entrant.find({ _id: { $in: semifinalPool.entrantIds } });
    const semifinalPlayerIds = new Set(semifinalEntrants.map(e => e.playerId.toString()));
    assert(semifinalPlayerIds.size === 24, "Semifinal pool's 24 entrants are all distinct real players (no duplicate identities)");

    for (const pool of sortedRound2) {
      const s = round2Survivors.get(pool._id.toString());
      assert(semifinalPlayerIds.has(s.winnersChampionId), `Semifinal pool includes Round-2 pool ${pool.poolNumber}'s real champion`);
      assert(semifinalPlayerIds.has(s.wbFinalsLoserId), `Semifinal pool includes Round-2 pool ${pool.poolNumber}'s real Winners-Final loser`);
      assert(semifinalPlayerIds.has(s.lbChampionId), `Semifinal pool includes Round-2 pool ${pool.poolNumber}'s real Losers-bracket champion`);
    }

    // ── Play the Semifinal-cutoff round (no Grand Final in this pool) and
    // independently predict its 8 real Finals qualifiers directly from the
    // stored resolution specs, using this file's own simulation. ──
    const semifinalBracket = await Bracket.findOne({ poolId: semifinalPool._id });
    const semifinalFreshMatches = await Match.find({ bracketId: semifinalBracket._id }).lean();
    const semifinalResults = simulateBracket(semifinalFreshMatches);

    const predictedFinalists = semifinalPool.finalsCutoffFinalistSpecs.map(spec => {
      if (spec.kind === "PLAYER") return spec.playerId.toString();
      const r = semifinalResults.get(spec.matchId.toString());
      if (!r) throw new Error("Test bug: no simulated result for a finalist spec's match");
      return r.winnerId;
    });
    assert(predictedFinalists.length === 8, `Predicted exactly 8 real finalists from finalsCutoffFinalistSpecs -- got ${predictedFinalists.length}`);
    assert(new Set(predictedFinalists).size === 8, "Predicted finalists are all distinct");

    await playFinalsCutoffToCompletion(organizerCtx, semifinalBracket._id);
    assert(
      (await resolvers.Tournament.modelBCurrentRoundComplete({ _id: tournament._id, poolModel: "B", mainBracketId: null })) === true,
      "modelBCurrentRoundComplete is true once the Semifinal-cutoff round's matches all finish"
    );

    // ── Advance #3: Semifinal -> the real Finals bracket. ──
    const advance3 = await resolvers.Mutation.advanceModelBRound(null, { tournamentId: tournament._id.toString() }, organizerCtx);
    assert(advance3.length === 0, "Advance #3 creates no new Pool -- the real Finals bracket is exposed via Tournament.mainBracket instead");

    const finalTournament = await Tournament.findById(tournament._id);
    assert(!!finalTournament.mainBracketId, "Tournament.mainBracketId is set once the real Finals bracket is generated");

    const finalsBracket = await Bracket.findById(finalTournament.mainBracketId);
    assert(finalsBracket.poolId === null, "The real Finals bracket is NOT pool-scoped (poolId null) -- it's the tournament's own main bracket, same slot Model A/C's generateMainBracket fills");
    const finalsSeedOrder = finalsBracket.seedOrder.map(id => id.toString());
    assert(finalsSeedOrder.length === 8, `Finals bracket has exactly 8 seeded finalists -- got ${finalsSeedOrder.length}`);
    assert(
      JSON.stringify([...finalsSeedOrder].sort()) === JSON.stringify([...predictedFinalists].sort()),
      "Finals bracket's 8 real finalists exactly match the hand-derived predicted finalists (order-independent)"
    );

    const finalsGF = await Match.findOne({ bracketId: finalsBracket._id, bracketSide: "GRAND_FINAL" });
    assert(!!finalsGF, "The real Finals bracket has a Grand Final match");

    assert(
      (await resolvers.Tournament.modelBCurrentRoundComplete({ _id: tournament._id, poolModel: "B", mainBracketId: finalTournament.mainBracketId })) === false,
      "modelBCurrentRoundComplete is false once the Finals bracket exists -- nothing left to advance"
    );
    assert(
      await throwsAsync(() => resolvers.Mutation.advanceModelBRound(null, { tournamentId: tournament._id.toString() }, organizerCtx)),
      "advanceModelBRound itself also rejects once the Finals bracket already exists"
    );

    // ═══════════════════════════════════════════════════════════════════
    // TEST 2: advanceModelBRound rejects an incomplete round.
    // ═══════════════════════════════════════════════════════════════════
    console.log("\n=== TEST 2: advanceModelBRound rejects an incomplete round ===");

    const organizer2 = await makeTestPlayer("ModelBAdvanceIncompleteTO");
    const organizerCtx2 = { playerId: organizer2._id.toString(), role: "USER" };

    const tournament2 = await Tournament.create({
      name: "Model B Advance Incomplete Test",
      game: "Test Game",
      format: "Pools + Bracket",
      poolModel: "B",
      organizers: [organizer2._id],
      startDate: new Date(),
      entrantCount: 128,
    });
    createdTournamentIds.push(tournament2._id);
    await Entrant.insertMany(synthesizeEntrants(tournament2._id, 128));
    await resolvers.Mutation.generateModelBPools(null, { tournamentId: tournament2._id.toString() }, organizerCtx2);

    assert(
      (await resolvers.Tournament.modelBCurrentRoundComplete({ _id: tournament2._id, poolModel: "B", mainBracketId: null })) === false,
      "modelBCurrentRoundComplete is false before any pool has been played"
    );
    assert(
      await throwsAsync(() => resolvers.Mutation.advanceModelBRound(null, { tournamentId: tournament2._id.toString() }, organizerCtx2)),
      "Rejects advancing when no pool has been played yet"
    );

    // Play just the FIRST pool fully -- the round as a whole is still
    // incomplete (every other pool is untouched).
    const pools2 = await Pool.find({ tournamentId: tournament2._id }).sort({ poolNumber: 1 });
    const bracket2 = await Bracket.findOne({ poolId: pools2[0]._id });
    await playBracketToCompletion(organizerCtx2, bracket2._id);

    assert(
      (await resolvers.Tournament.modelBCurrentRoundComplete({ _id: tournament2._id, poolModel: "B", mainBracketId: null })) === false,
      "modelBCurrentRoundComplete is still false with only 1 of 16 pools finished"
    );
    assert(
      await throwsAsync(() => resolvers.Mutation.advanceModelBRound(null, { tournamentId: tournament2._id.toString() }, organizerCtx2)),
      "Rejects advancing when only SOME of the round's pools have finished"
    );

    // ═══════════════════════════════════════════════════════════════════
    // TEST 3: deliberately forces the Winners-Final loser to ALSO win their
    // own pool's Losers Finals -- becoming BOTH the Winners-Final loser AND
    // the Losers-bracket champion. TEST 1's "player1 always wins" rule
    // structurally never produces this specific shape: the Losers Finals
    // match always wires the established Losers-bracket survivor as player1
    // and the dropping-in Winners-Final loser as player2 (buildDropInRound's
    // own a[i]=player1/b[i]=player2 convention), so under a blanket
    // player1-always-wins rule the Winners-Final loser always LOSES that
    // match instead -- exercising only the OTHER symmetric dedup shape
    // (Winners-Final loser collides with the top-ranked further Losers
    // loser, not with the Losers-bracket champion itself). This test forces
    // the specific shape TEST 1 never hit, by overriding just that one
    // match's result.
    // ═══════════════════════════════════════════════════════════════════
    console.log("\n=== TEST 3: forced Winners-Final-loser-wins-Losers-Finals collision ===");

    const organizer3 = await makeTestPlayer("ModelBDedupTO");
    const organizerCtx3 = { playerId: organizer3._id.toString(), role: "USER" };

    const tournament3 = await Tournament.create({
      name: "Model B Dedup Collision Test",
      game: "Test Game",
      format: "Pools + Bracket",
      poolModel: "B",
      organizers: [organizer3._id],
      startDate: new Date(),
      entrantCount: 128,
    });
    createdTournamentIds.push(tournament3._id);
    await Entrant.insertMany(synthesizeEntrants(tournament3._id, 128));

    const round1Pools3 = await resolvers.Mutation.generateModelBPools(null, { tournamentId: tournament3._id.toString() }, organizerCtx3);
    assert(round1Pools3.length === 16, `TEST 3 setup: 16 Round-1 pools -- got ${round1Pools3.length}`);
    const sortedRound1_3 = [...round1Pools3].sort((a, b) => a.poolNumber - b.poolNumber);

    let riggedSurvivors = null;
    let riggedGrandFinal = null;
    let riggedWbFinalsLoserId = null;

    for (let i = 0; i < sortedRound1_3.length; i++) {
      const pool = sortedRound1_3[i];
      const bracket = await Bracket.findOne({ poolId: pool._id });

      if (i === 0) {
        // Rig pool 0 only: player1-always-wins everywhere EXCEPT the Losers
        // Finals match, where player2 (the dropping-in Winners-Final loser)
        // is forced to win instead.
        for (let round = 1; round <= 12; round++) {
          const wbPlayed = await playRound(organizerCtx3, bracket._id, "WINNERS", round);
          const readyLosers = await Match.find({
            bracketId: bracket._id,
            bracketSide: "LOSERS",
            bracketRound: round,
            status: "PENDING",
            player1Id: { $ne: null },
            player2Id: { $ne: null },
          });
          for (const m of readyLosers) {
            if (m.round === "Losers Finals") {
              await resolvers.Mutation.reportResult(null, { matchId: m._id.toString(), player1Score: 0, player2Score: 2 }, organizerCtx3);
            } else {
              await resolvers.Mutation.reportResult(null, { matchId: m._id.toString(), player1Score: 2, player2Score: 0 }, organizerCtx3);
            }
          }
          if (wbPlayed === 0 && readyLosers.length === 0) break;
        }
        const gf = await Match.findOne({ bracketId: bracket._id, bracketSide: "GRAND_FINAL" });
        if (gf && gf.status === "PENDING" && gf.player1Id && gf.player2Id) {
          await resolvers.Mutation.reportResult(null, { matchId: gf._id.toString(), player1Score: 2, player2Score: 0 }, organizerCtx3);
        }

        // Independently confirm the rig actually worked before trusting
        // anything downstream: the real Winners Finals match's real loser
        // really is the real Grand Final's real player2 (Losers-bracket
        // champion) -- the exact collision this test exists to force.
        riggedGrandFinal = await Match.findOne({ bracketId: bracket._id, bracketSide: "GRAND_FINAL" });
        const wbFinalsMatch = await Match.findOne({ bracketId: bracket._id, bracketSide: "WINNERS", nextMatchId: riggedGrandFinal._id });
        riggedWbFinalsLoserId = (
          wbFinalsMatch.winnerId.toString() === wbFinalsMatch.player1Id.toString() ? wbFinalsMatch.player2Id : wbFinalsMatch.player1Id
        ).toString();
        assert(
          riggedWbFinalsLoserId === riggedGrandFinal.player2Id.toString(),
          "TEST 3 rig confirmed: the real Winners-Final loser really is the real Grand Final's losers-side finalist (the forced collision actually happened)"
        );

        // Now call the REAL extractPoolSurvivors directly and confirm it
        // dedupes correctly rather than producing a duplicate identity.
        riggedSurvivors = await extractPoolSurvivors(bracket);
        assert(
          riggedSurvivors.winnersChampionId === riggedGrandFinal.player1Id.toString(),
          "TEST 3: extractPoolSurvivors' winnersChampionId matches the real Grand Final winners-side finalist"
        );
        assert(
          riggedSurvivors.losersSurvivorIds[0] === riggedWbFinalsLoserId,
          "TEST 3: extractPoolSurvivors' losersSurvivorIds[0] is the real (collided) Winners-Final loser / Losers-bracket champion"
        );
        assert(
          new Set(riggedSurvivors.losersSurvivorIds).size === riggedSurvivors.losersSurvivorIds.length,
          "TEST 3: extractPoolSurvivors' losersSurvivorIds has NO duplicate identities despite the forced collision"
        );
        assert(
          riggedSurvivors.losersSurvivorIds.length >= 2,
          `TEST 3: extractPoolSurvivors still returns at least 2 real losers-survivors -- a genuinely different 3rd real person backfilled the collided slot (got ${riggedSurvivors.losersSurvivorIds.length})`
        );
        assert(
          riggedSurvivors.losersSurvivorIds[1] !== riggedWbFinalsLoserId,
          "TEST 3: the backfilled 2nd losers-survivor is a genuinely DIFFERENT real person, not a repeat of the Winners-Final loser"
        );
      } else {
        await playBracketToCompletion(organizerCtx3, bracket._id);
      }
    }

    assert(
      (await resolvers.Tournament.modelBCurrentRoundComplete({ _id: tournament3._id, poolModel: "B", mainBracketId: null })) === true,
      "TEST 3: modelBCurrentRoundComplete is true once every Round-1 pool (including the rigged one) finishes"
    );

    // ── Advance for real, and confirm the rigged pool's contribution to the
    // real, persisted Round-2 pool has no duplicate identity and includes
    // the correctly backfilled 3 distinct real advancers. ──
    const round2Pools3 = await resolvers.Mutation.advanceModelBRound(null, { tournamentId: tournament3._id.toString() }, organizerCtx3);
    assert(round2Pools3.length === 4, `TEST 3: Advance #1 still creates 4 Round-2 pools despite the forced collision in pool 1 -- got ${round2Pools3.length}`);

    const sortedRound2_3 = [...round2Pools3].sort((a, b) => a.poolNumber - b.poolNumber);
    // chunkArray(4) groups source pools in array order -- pool 1 (index 0)
    // lands in the FIRST merge group, i.e. Round 2's first (lowest
    // poolNumber) pool, same grouping TEST 1 already confirmed exactly.
    const riggedGroupPool = sortedRound2_3[0];
    assert(
      riggedGroupPool.entrantIds.length === 12,
      `TEST 3: the merge group containing the rigged pool still has exactly 12 entrants -- no count regression from the collision (got ${riggedGroupPool.entrantIds.length})`
    );

    const riggedGroupEntrants = await Entrant.find({ _id: { $in: riggedGroupPool.entrantIds } });
    const riggedGroupPlayerIds = riggedGroupEntrants.map(e => e.playerId.toString());
    assert(
      new Set(riggedGroupPlayerIds).size === 12,
      "TEST 3: the merge group containing the rigged pool has 12 DISTINCT real entrants -- no duplicate identity leaked into the persisted Round-2 pool"
    );
    assert(riggedGroupPlayerIds.includes(riggedSurvivors.winnersChampionId), "TEST 3: Round 2 includes the rigged pool's real champion");
    assert(
      riggedGroupPlayerIds.includes(riggedWbFinalsLoserId),
      "TEST 3: Round 2 includes the rigged pool's real (collided) Winners-Final-loser/Losers-champion"
    );
    assert(
      riggedGroupPlayerIds.includes(riggedSurvivors.losersSurvivorIds[1]),
      "TEST 3: Round 2 includes the rigged pool's genuinely different backfilled 3rd real advancer"
    );

    console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURE(S)`}`);
  } finally {
    console.log("\nCleaning up test data...");
    for (const tournamentId of createdTournamentIds) {
      const tournamentDoc = await Tournament.findById(tournamentId);
      const pools = await Pool.find({ tournamentId });
      const brackets = await Bracket.find({ tournamentId });
      for (const b of brackets) await Match.deleteMany({ bracketId: b._id });
      for (const p of pools) await Match.deleteMany({ poolId: p._id });
      if (tournamentDoc?.mainBracketId) await Match.deleteMany({ bracketId: tournamentDoc.mainBracketId });
      await Bracket.deleteMany({ tournamentId });
      await Pool.deleteMany({ tournamentId });
      await Entrant.deleteMany({ tournamentId });
      await Tournament.findByIdAndDelete(tournamentId);
    }
    const orgTags = ["ModelBAdvanceTO", "ModelBAdvanceIncompleteTO", "ModelBDedupTO"];
    const orgPlayers = await Player.find({ tag: { $in: orgTags } });
    const orgUserIds = orgPlayers.map(p => p.userId).filter(Boolean);
    await Player.deleteMany({ tag: { $in: orgTags } });
    await User.deleteMany({ _id: { $in: orgUserIds } });
    console.log("Cleanup done.");
  }

  process.exit(failures === 0 ? 0 : 1);
}

main();
