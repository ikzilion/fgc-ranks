// scripts/loadTestModelBScale.mjs
//
// Real, DB-backed load/scale test for Pool format Model B. NOT a correctness
// test (Phases 1-6 / scripts/testModelBAdvanceRound.mjs already proved
// correctness at small scale) -- this exercises the REAL
// generateModelBPools + advanceModelBRound resolvers (graphql/resolvers/
// index.ts) against the real MongoDB Atlas database at real EVO scale
// (SF6 EVO Japan: 7,683 entrants, 512 Round 1 pools), to answer:
//
//   1. Wall-clock time per generateModelBPools/advanceModelBRound call vs
//      the real Vercel Hobby-plan hard ceiling (300,000ms -- no
//      vercel.json/vercel.ts exists in this repo, so no maxDuration
//      override; the platform default ceiling is the real pass/fail bar).
//   2. Documents written per call (Pool/Bracket/Match), and whether write
//      time scales linearly or super-linearly with pool count.
//   3. The actual breaking point -- the entrant/pool count where a single
//      generateModelBPools call first risks/exceeds the ceiling.
//   4. Whether Phase 1/2's pool-count math and Phase 5's extractPoolSurvivors
//      dedup still hold at real scale (checked across EVERY pool in a
//      round, not spot-checked).
//
// This does NOT attempt to fix/redesign anything it finds -- report-only.
//
// Same .env.local / connectToDatabase / direct-resolver-call / try-finally
// cleanup conventions as scripts/testModelBAdvanceRound.mjs.
//
// Run: npx tsx scripts/loadTestModelBScale.mjs

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
const { Notification } = await import("../models/Notification");
const { computeModelBInitialPoolCount } = await import("../lib/bracket");
const { resolvers } = await import("../graphql/resolvers/index");
const { createLoaders } = await import("../graphql/loaders");

const HOBBY_CEILING_MS = 300_000;
const WARN_THRESHOLD_MS = 150_000;

function pct(ms) {
  return `${((ms / HOBBY_CEILING_MS) * 100).toFixed(2)}%`;
}
function fmtMs(ms) {
  return `${ms}ms (${(ms / 1000).toFixed(1)}s)`;
}
function level(ms) {
  if (ms > HOBBY_CEILING_MS) return "FAIL (exceeds 300s Hobby ceiling)";
  if (ms > WARN_THRESHOLD_MS) return "WARN (>50% of ceiling)";
  return "OK";
}

// ─── Setup helpers ─────────────────────────────────────────────────────

const PASSWORD_HASH_PROMISE = bcrypt.hash("TestPass123!", 10);

async function makeTestPlayer(tag) {
  const passwordHash = await PASSWORD_HASH_PROMISE;
  const email = `${tag.toLowerCase()}@example.com`;
  const user = await User.create({ email, passwordHash });
  const player = await Player.create({ userId: user._id, tag });
  await User.findByIdAndUpdate(user._id, { playerId: player._id });
  return player;
}

// Bare synthetic ObjectIds, no real Player/User behind them -- confirmed
// safe: Player.findByIdAndUpdate on a nonexistent ID is a no-op (returns
// null, no throw), so reportResult's win/loss stat increments are harmless
// no-ops for these, and there's nothing to clean up for them afterward.
function synthesizeEntrants(tournamentId, count) {
  return Array.from({ length: count }, () => ({ playerId: new Types.ObjectId(), tournamentId }));
}

async function mapConcurrent(items, worker, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  async function runner() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, runner));
  return results;
}

async function countDocsForTournament(tournamentId) {
  const [pools, brackets, matches] = await Promise.all([
    Pool.countDocuments({ tournamentId }),
    Bracket.countDocuments({ tournamentId }),
    Match.countDocuments({ tournamentId }),
  ]);
  return { pools, brackets, matches };
}

// Deletes every document a test tournament could have created, INCLUDING
// Notifications (reportResult creates 2 per match, targeted at the match's
// synthetic player1Id/player2Id -- Notification has no tournamentId field,
// so they're found via the distinct real player IDs actually used in this
// tournament's Matches instead, which is safe/exact since every synthetic
// ObjectId here is freshly minted and never collides with real data).
async function cleanupTournament(tournamentId, orgTags) {
  const [p1, p2] = await Promise.all([
    Match.distinct("player1Id", { tournamentId }),
    Match.distinct("player2Id", { tournamentId }),
  ]);
  const allPlayerIds = [...new Set([...p1, ...p2].filter(Boolean).map(String))];
  if (allPlayerIds.length) await Notification.deleteMany({ playerId: { $in: allPlayerIds } });

  await Match.deleteMany({ tournamentId });
  await Bracket.deleteMany({ tournamentId });
  await Pool.deleteMany({ tournamentId });
  await Entrant.deleteMany({ tournamentId });
  await Tournament.findByIdAndDelete(tournamentId);

  if (orgTags && orgTags.length) {
    const orgPlayers = await Player.find({ tag: { $in: orgTags } });
    const orgUserIds = orgPlayers.map(p => p.userId).filter(Boolean);
    await Player.deleteMany({ tag: { $in: orgTags } });
    await User.deleteMany({ _id: { $in: orgUserIds } });
  }
}

async function verifyCleanup(tournamentId, orgTags) {
  const counts = await countDocsForTournament(tournamentId);
  const tExists = !!(await Tournament.exists({ _id: tournamentId }));
  const entrants = await Entrant.countDocuments({ tournamentId });
  const orgPlayersLeft = orgTags?.length ? await Player.countDocuments({ tag: { $in: orgTags } }) : 0;
  return { ...counts, entrants, tournamentExists: tExists, orgPlayersLeft };
}

// ─── Deterministic play-through (player1 always wins), parallelized ─────
// Same convention as scripts/testModelBAdvanceRound.mjs's playRound /
// playBracketToCompletion -- reimplemented here with concurrency (matches
// within one round+side are structurally independent, and different pools'
// brackets are entirely independent of each other), since this file needs
// to play tens of thousands of real matches across hundreds of real pools.

async function playRoundConcurrent(organizerCtx, bracketId, bracketSide, bracketRound, concurrency) {
  const ready = await Match.find({
    bracketId,
    bracketSide,
    bracketRound,
    status: "PENDING",
    player1Id: { $ne: null },
    player2Id: { $ne: null },
  })
    .select("_id")
    .lean();
  if (ready.length === 0) return 0;
  await mapConcurrent(
    ready,
    async m => {
      await resolvers.Mutation.reportResult(null, { matchId: m._id.toString(), player1Score: 2, player2Score: 0 }, organizerCtx);
    },
    concurrency
  );
  return ready.length;
}

async function playBracketToCompletion(organizerCtx, bracketId, matchConcurrency) {
  let total = 0;
  for (let round = 1; round <= 14; round++) {
    const wbPlayed = await playRoundConcurrent(organizerCtx, bracketId, "WINNERS", round, matchConcurrency);
    const lbPlayed = await playRoundConcurrent(organizerCtx, bracketId, "LOSERS", round, matchConcurrency);
    total += wbPlayed + lbPlayed;
    if (wbPlayed === 0 && lbPlayed === 0) break;
  }
  const gf = await Match.findOne({ bracketId, bracketSide: "GRAND_FINAL" });
  if (gf && gf.status === "PENDING" && gf.player1Id && gf.player2Id) {
    await resolvers.Mutation.reportResult(null, { matchId: gf._id.toString(), player1Score: 2, player2Score: 0 }, organizerCtx);
    total++;
  }
  return total;
}

async function playFinalsCutoffToCompletion(organizerCtx, bracketId, matchConcurrency) {
  let total = 0;
  for (let round = 1; round <= 14; round++) {
    const wbPlayed = await playRoundConcurrent(organizerCtx, bracketId, "WINNERS", round, matchConcurrency);
    const lbPlayed = await playRoundConcurrent(organizerCtx, bracketId, "LOSERS", round, matchConcurrency);
    total += wbPlayed + lbPlayed;
    if (wbPlayed === 0 && lbPlayed === 0) break;
  }
  return total;
}

// Plays every pool of a round concurrently (pool-level concurrency) --
// each pool's own rounds are still played sequentially (structurally
// required), but different pools are fully independent.
async function playRoundAcrossPools(organizerCtx, bracketIds, isFinalsCutoff, poolConcurrency, matchConcurrency, label) {
  const start = Date.now();
  let totalMatches = 0;
  let done = 0;
  await mapConcurrent(
    bracketIds,
    async bracketId => {
      const played = isFinalsCutoff
        ? await playFinalsCutoffToCompletion(organizerCtx, bracketId, matchConcurrency)
        : await playBracketToCompletion(organizerCtx, bracketId, matchConcurrency);
      totalMatches += played;
      done++;
      if (done % 50 === 0 || done === bracketIds.length) {
        const elapsed = (Date.now() - start) / 1000;
        console.log(`    [${label}] ${done}/${bracketIds.length} pools played, ${totalMatches} matches so far, ${elapsed.toFixed(1)}s elapsed`);
      }
    },
    poolConcurrency
  );
  return { totalMatches, ms: Date.now() - start };
}

// ─── Correctness invariants at real scale ────────────────────────────────

function checkRound1PoolMath(entrantCount, round1Pools) {
  const expectedPoolCount = computeModelBInitialPoolCount(entrantCount);
  const poolCountOk = expectedPoolCount === round1Pools.length;
  const base = Math.floor(entrantCount / round1Pools.length);
  const countsOk = round1Pools.every(p => p.entrantIds.length === base || p.entrantIds.length === base + 1);
  const sum = round1Pools.reduce((s, p) => s + p.entrantIds.length, 0);
  const sumOk = sum === entrantCount;
  const result = { entrantCount, expectedPoolCount, actualPoolCount: round1Pools.length, poolCountOk, countsOk, sumOk, poolsChecked: round1Pools.length };
  console.log(
    `  [invariant] Round 1 pool math @ ${entrantCount} entrants: expected ${expectedPoolCount} pools, got ${round1Pools.length} (${poolCountOk ? "OK" : "FAIL"}); every pool's entrant count within {${base},${base + 1}}: ${countsOk ? "OK" : "FAIL"}; sum === entrantCount: ${sumOk ? "OK" : "FAIL"} (checked all ${round1Pools.length} pools)`
  );
  return result;
}

// Validates extractPoolSurvivors' dedup logic across EVERY pool of a round
// in aggregate: resolves the REAL newPools (advanceModelBRound's real
// output) back to real playerIds and confirms no identity appears twice
// across the whole round's worth of survivors.
async function checkAdvanceDedupInvariant(previousPoolCount, newPools, roundLabel) {
  if (newPools.length === 0) {
    console.log(`  [invariant] ${roundLabel}: advanceModelBRound returned no new pools (Finals bracket generated) -- nothing to dedup-check here`);
    return { round: roundLabel, poolsChecked: 0, skipped: true };
  }
  const allEntrantIds = newPools.flatMap(p => p.entrantIds.map(String));
  const entrants = await Entrant.find({ _id: { $in: allEntrantIds } })
    .select("playerId")
    .lean();
  const playerIds = entrants.map(e => e.playerId.toString());
  const uniquePlayerIds = new Set(playerIds);
  const dedupOk = uniquePlayerIds.size === playerIds.length;
  const resolveOk = entrants.length === allEntrantIds.length;
  console.log(
    `  [invariant] ${roundLabel}: ${previousPoolCount} source pools -> ${newPools.length} new pools checked, ${allEntrantIds.length} survivor entrants, ${uniquePlayerIds.size} unique real players, every Entrant resolved: ${resolveOk ? "OK" : "FAIL"}, NO duplicate identities: ${dedupOk ? "OK" : "FAIL"}`
  );
  return { round: roundLabel, poolsChecked: newPools.length, sourcePoolCount: previousPoolCount, totalSurvivorEntrants: allEntrantIds.length, uniquePlayerIds: uniquePlayerIds.size, dedupOk, resolveOk };
}

// ─── Full real lifecycle: generate -> play -> advance, every round ───────

async function runFullLifecycle(entrantCount, tagPrefix, { poolConcurrency, matchConcurrency }) {
  console.log(`\n=== FULL LIFECYCLE: ${entrantCount} entrants (tag ${tagPrefix}) ===`);
  const organizer = await makeTestPlayer(`${tagPrefix}TO`);
  const organizerCtx = { playerId: organizer._id.toString(), role: "USER" };
  const orgTags = [`${tagPrefix}TO`];

  const tournament = await Tournament.create({
    name: `LOADTEST ${tagPrefix} ${entrantCount}`,
    game: "LoadTest Game",
    format: "Pools + Bracket",
    poolModel: "B",
    organizers: [organizer._id],
    startDate: new Date(),
    entrantCount,
  });

  const report = { entrantCount, tournamentId: tournament._id.toString(), rounds: [], invariants: [], round1PoolMath: null };

  console.log(`  Inserting ${entrantCount} entrants...`);
  const insertStart = Date.now();
  await Entrant.insertMany(synthesizeEntrants(tournament._id, entrantCount), { ordered: false });
  console.log(`  Entrant.insertMany: ${Date.now() - insertStart}ms`);

  // ── Round 1: generateModelBPools ──
  let t0 = Date.now();
  let currentPools = await resolvers.Mutation.generateModelBPools(null, { tournamentId: tournament._id.toString() }, organizerCtx);
  let genMs = Date.now() - t0;
  let docCounts = await countDocsForTournament(tournament._id);
  report.rounds.push({
    round: 1,
    kind: "generateModelBPools",
    poolCount: currentPools.length,
    ms: genMs,
    pctOfCeiling: pct(genMs),
    level: level(genMs),
    docsWritten: docCounts,
  });
  console.log(`  Round 1 generateModelBPools: ${currentPools.length} pools, ${fmtMs(genMs)}, ${pct(genMs)} of 300s ceiling [${level(genMs)}]`);
  console.log(`    docs written: ${docCounts.pools} pools, ${docCounts.brackets} brackets, ${docCounts.matches} matches`);

  report.round1PoolMath = checkRound1PoolMath(entrantCount, currentPools);

  let roundNumber = 1;
  while (true) {
    const isFinalsCutoff = currentPools.length === 1 && currentPools[0].isFinalsCutoff === true;
    const bracketDocs = await Bracket.find({ tournamentId: tournament._id, poolId: { $in: currentPools.map(p => p._id) } })
      .select("_id")
      .lean();
    const bracketIds = bracketDocs.map(b => b._id);

    console.log(`  Playing round ${roundNumber} (${bracketIds.length} pools${isFinalsCutoff ? ", Finals-cutoff" : ""})...`);
    const playResult = await playRoundAcrossPools(organizerCtx, bracketIds, isFinalsCutoff, poolConcurrency, matchConcurrency, `R${roundNumber}`);
    console.log(`  Round ${roundNumber} play-through DONE: ${playResult.totalMatches} matches reported in ${(playResult.ms / 1000).toFixed(1)}s (not measured against the ceiling -- real matches are reported one at a time over an event, not in one call)`);

    const beforeAdvance = await countDocsForTournament(tournament._id);
    t0 = Date.now();
    const newPools = await resolvers.Mutation.advanceModelBRound(null, { tournamentId: tournament._id.toString() }, { ...organizerCtx, loaders: createLoaders() });
    const advMs = Date.now() - t0;
    const afterAdvance = await countDocsForTournament(tournament._id);
    const delta = {
      pools: afterAdvance.pools - beforeAdvance.pools,
      brackets: afterAdvance.brackets - beforeAdvance.brackets,
      matches: afterAdvance.matches - beforeAdvance.matches,
    };

    report.rounds.push({
      round: roundNumber,
      kind: "advanceModelBRound",
      fromPoolCount: currentPools.length,
      toPoolCount: newPools.length,
      ms: advMs,
      pctOfCeiling: pct(advMs),
      level: level(advMs),
      docsWritten: delta,
    });
    console.log(`  advanceModelBRound (round ${roundNumber} -> ${roundNumber + 1}): ${fmtMs(advMs)}, ${pct(advMs)} of 300s ceiling [${level(advMs)}], ${newPools.length} new pools, docs +${delta.pools}p/+${delta.brackets}b/+${delta.matches}m`);

    const invariant = await checkAdvanceDedupInvariant(currentPools.length, newPools, `round ${roundNumber} -> ${roundNumber + 1}`);
    report.invariants.push(invariant);

    const freshTournament = await Tournament.findById(tournament._id).select("mainBracketId");
    if (freshTournament.mainBracketId) {
      report.finalsBracketId = freshTournament.mainBracketId.toString();
      console.log(`  Real Finals bracket generated (Tournament.mainBracketId set) -- Model B round-to-round advancement complete.`);
      break;
    }
    currentPools = newPools;
    roundNumber++;
  }

  return { report, tournamentId: tournament._id, orgTags };
}

// ─── Breaking-point sweep: generateModelBPools-only timing ───────────────

async function sweepPoint(entrantCount, index) {
  const tag = `LTSweep${index}`;
  const organizer = await makeTestPlayer(`${tag}TO`);
  const organizerCtx = { playerId: organizer._id.toString(), role: "USER" };
  const tournament = await Tournament.create({
    name: `LOADTEST Sweep ${entrantCount}`,
    game: "LoadTest Game",
    format: "Pools + Bracket",
    poolModel: "B",
    organizers: [organizer._id],
    startDate: new Date(),
    entrantCount,
  });
  await Entrant.insertMany(synthesizeEntrants(tournament._id, entrantCount), { ordered: false });

  const t0 = Date.now();
  const pools = await resolvers.Mutation.generateModelBPools(null, { tournamentId: tournament._id.toString() }, organizerCtx);
  const ms = Date.now() - t0;
  const docCounts = await countDocsForTournament(tournament._id);

  await cleanupTournament(tournament._id, [`${tag}TO`]);
  const verify = await verifyCleanup(tournament._id, [`${tag}TO`]);

  const result = {
    entrantCount,
    poolCount: pools.length,
    ms,
    pctOfCeiling: pct(ms),
    level: level(ms),
    msPerPool: ms / pools.length,
    docsWritten: docCounts,
    cleanupVerified: verify.pools === 0 && verify.brackets === 0 && verify.matches === 0 && verify.entrants === 0 && !verify.tournamentExists && verify.orgPlayersLeft === 0,
  };
  console.log(
    `  [sweep] ${entrantCount} entrants -> ${pools.length} pools: ${fmtMs(ms)}, ${pct(ms)} of ceiling [${level(ms)}], ${result.msPerPool.toFixed(2)}ms/pool, cleanup verified: ${result.cleanupVerified}`
  );
  return result;
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  await connectToDatabase();

  const cleanupRegistry = []; // { tournamentId, orgTags }
  const finalReport = { smoke: null, fullLifecycle: null, sweep: [], cleanupVerification: [] };

  try {
    // ── 1. Smoke test: small scale, full lifecycle mechanics ──
    console.log("############################################");
    console.log("# 1. SMOKE TEST (130 entrants, full lifecycle)");
    console.log("############################################");
    const smoke = await runFullLifecycle(130, "LTSmoke", { poolConcurrency: 8, matchConcurrency: 4 });
    cleanupRegistry.push({ tournamentId: smoke.tournamentId, orgTags: smoke.orgTags });
    finalReport.smoke = smoke.report;
    console.log("\nSmoke test report:", JSON.stringify(smoke.report, null, 2));

    // Clean up the smoke test immediately so it doesn't linger during the
    // (much longer) real-scale run below.
    await cleanupTournament(smoke.tournamentId, smoke.orgTags);
    const smokeVerify = await verifyCleanup(smoke.tournamentId, smoke.orgTags);
    finalReport.cleanupVerification.push({ label: "smoke", ...smokeVerify });
    console.log("Smoke test cleanup verification:", smokeVerify);
    cleanupRegistry.length = 0; // already cleaned

    if (process.env.SMOKE_ONLY === "1") {
      console.log("\nSMOKE_ONLY=1 set -- stopping after smoke test.");
      return;
    }

    // ── 2. Real EVO-scale full lifecycle: 7,683 entrants ──
    console.log("\n############################################");
    console.log("# 2. FULL LIFECYCLE @ SF6 EVO JAPAN SCALE (7,683 entrants)");
    console.log("############################################");
    const full = await runFullLifecycle(7683, "LTEvo", { poolConcurrency: 16, matchConcurrency: 6 });
    cleanupRegistry.push({ tournamentId: full.tournamentId, orgTags: full.orgTags });
    finalReport.fullLifecycle = full.report;
    console.log("\nFull lifecycle report:", JSON.stringify(full.report, null, 2));

    await cleanupTournament(full.tournamentId, full.orgTags);
    const fullVerify = await verifyCleanup(full.tournamentId, full.orgTags);
    finalReport.cleanupVerification.push({ label: "fullLifecycle-7683", ...fullVerify });
    console.log("Full lifecycle cleanup verification:", fullVerify);
    cleanupRegistry.length = 0;

    // ── 3. Breaking-point sweep: generateModelBPools timing only ──
    console.log("\n############################################");
    console.log("# 3. BREAKING-POINT SWEEP (generateModelBPools timing only)");
    console.log("############################################");
    const sweepCounts = [500, 1000, 2000, 4000, 8000, 16000, 32000];
    for (let i = 0; i < sweepCounts.length; i++) {
      const point = await sweepPoint(sweepCounts[i], i);
      finalReport.sweep.push(point);
    }

    console.log("\nSweep summary:");
    console.table(finalReport.sweep.map(p => ({ entrants: p.entrantCount, pools: p.poolCount, ms: p.ms, msPerPool: p.msPerPool.toFixed(2), pctCeiling: p.pctOfCeiling, level: p.level })));

    // Simple linear extrapolation (ms vs poolCount) to estimate the
    // crossover pool count where a single call would hit the 300s ceiling,
    // reported as a clearly-labeled extrapolation, not a measurement.
    const pts = finalReport.sweep;
    const n = pts.length;
    const sumX = pts.reduce((s, p) => s + p.poolCount, 0);
    const sumY = pts.reduce((s, p) => s + p.ms, 0);
    const sumXY = pts.reduce((s, p) => s + p.poolCount * p.ms, 0);
    const sumXX = pts.reduce((s, p) => s + p.poolCount * p.poolCount, 0);
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    const extrapolatedCrossoverPoolCount = (HOBBY_CEILING_MS - intercept) / slope;
    finalReport.extrapolation = { slopeMsPerPool: slope, interceptMs: intercept, extrapolatedCrossoverPoolCount };
    console.log(`\nLinear fit: ms ~= ${slope.toFixed(3)} * poolCount + ${intercept.toFixed(1)}`);
    console.log(`Extrapolated crossover (ms = 300,000 ceiling): ~${Math.round(extrapolatedCrossoverPoolCount)} pools (EXTRAPOLATION, not directly measured, if no sweep point actually exceeded the ceiling)`);

    console.log("\n\n========== FINAL JSON REPORT ==========");
    console.log(JSON.stringify(finalReport, null, 2));
  } finally {
    // Defensive: clean up anything still registered (e.g. if the sweep or
    // full-lifecycle run threw mid-way before its own inline cleanup ran).
    if (cleanupRegistry.length > 0) {
      console.log("\nRunning defensive final cleanup for any un-cleaned tournaments...");
      for (const { tournamentId, orgTags } of cleanupRegistry) {
        await cleanupTournament(tournamentId, orgTags);
        const v = await verifyCleanup(tournamentId, orgTags);
        finalReport.cleanupVerification.push({ label: `defensive-${tournamentId}`, ...v });
        console.log(`  Defensive cleanup of ${tournamentId}:`, v);
      }
    }

    // Global sweep: catch anything tagged LOADTEST that somehow survived
    // (e.g. a sweep point that threw before its own cleanup call ran).
    const leftoverTournaments = await Tournament.find({ name: /^LOADTEST /i }).select("_id name").lean();
    if (leftoverTournaments.length > 0) {
      console.log(`\nWARNING: found ${leftoverTournaments.length} leftover LOADTEST tournament(s) -- cleaning up now:`, leftoverTournaments.map(t => t.name));
      for (const t of leftoverTournaments) {
        await cleanupTournament(t._id, []);
      }
    }
    const leftoverOrgs = await Player.find({ tag: /^LT(Smoke|Evo|Sweep)/i }).select("_id tag").lean();
    if (leftoverOrgs.length > 0) {
      console.log(`WARNING: found ${leftoverOrgs.length} leftover test organizer Player doc(s) -- cleaning up now:`, leftoverOrgs.map(p => p.tag));
      const userIds = leftoverOrgs.map(p => p.userId).filter(Boolean);
      await Player.deleteMany({ _id: { $in: leftoverOrgs.map(p => p._id) } });
      await User.deleteMany({ _id: { $in: userIds } });
    }

    const finalGlobalCheck = {
      leftoverTournaments: await Tournament.countDocuments({ name: /^LOADTEST /i }),
      leftoverOrgPlayers: await Player.countDocuments({ tag: /^LT(Smoke|Evo|Sweep)/i }),
    };
    console.log("\n========== FINAL GLOBAL CLEANUP VERIFICATION ==========");
    console.log(finalGlobalCheck);
    if (finalGlobalCheck.leftoverTournaments === 0 && finalGlobalCheck.leftoverOrgPlayers === 0) {
      console.log("VERIFIED: zero leftover load-test documents.");
    } else {
      console.log("FAILURE: leftover documents remain after cleanup -- see above.");
    }
  }

  process.exit(0);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
