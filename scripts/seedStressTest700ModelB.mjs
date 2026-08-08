// scripts/seedStressTest700ModelB.mjs
//
// Real-scale (701-entrant) visual-inspection / scale-reference tournament
// for Pool format Model B -- the original version of this tournament
// (referenced in Notion as tournament ID 6a6d10f64991d6d367a265c9) was
// found to no longer exist in the database when this task went to relabel
// it (Aug 6, 2026), so this script recreates it from scratch, matching the
// same convention as scripts/seedStressTest700ModelA.mjs/
// seedStressTest700ModelC.mjs: direct-to-Mongo via connectToDatabase(),
// calling the REAL generateModelBPools/advanceModelBRound/reportResult
// resolvers, reusing all 700 existing StressPlayer Player docs (no new
// players created) plus ikzilion as organizer+entrant (701 real entrants).
// Marked isExample: true.
//
// Round-to-round play/advance loop reused from
// scripts/loadTestModelBScale.mjs's runFullLifecycle (which this project
// already validated at real EVO scale) -- but that script always deletes
// its tournaments afterward and its loop breaks the instant
// Tournament.mainBracketId is set, WITHOUT playing the newly-generated real
// Finals bracket (irrelevant for a timing measurement about to be torn
// down). This script's whole point is a persisted, genuinely finished
// tournament, so after the loop it explicitly ALSO plays that real Finals
// bracket to completion (same fix applied in
// scripts/seedShowcaseModelB.mjs) and only then marks the tournament ENDED.
//
// Run: npx tsx scripts/seedStressTest700ModelB.mjs

import fs from "fs";
import path from "path";

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
const { Player } = await import("../models/Player");
const { Tournament } = await import("../models/Tournament");
const { Entrant } = await import("../models/Entrant");
const { Match } = await import("../models/Match");
const { Bracket } = await import("../models/Bracket");
const { Pool } = await import("../models/Pool");
const { resolvers } = await import("../graphql/resolvers/index");
const { createLoaders } = await import("../graphql/loaders");

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

// Deterministic "lower playerId wins" convention -- verified safe against
// ever needing a Grand Final Reset (see scripts/seedShowcaseModelB.mjs's
// detailed reasoning), but still explicitly checked/handled defensively
// below rather than assumed.
async function reportDeterministic(organizerCtx, matchId, player1Id, player2Id) {
  const player1Wins = player1Id.toString() < player2Id.toString();
  await resolvers.Mutation.reportResult(
    null,
    { matchId: matchId.toString(), player1Score: player1Wins ? 2 : 0, player2Score: player1Wins ? 0 : 2 },
    organizerCtx
  );
}

async function playRoundConcurrent(organizerCtx, bracketId, bracketSide, bracketRound, concurrency) {
  const ready = await Match.find({
    bracketId,
    bracketSide,
    bracketRound,
    status: "PENDING",
    player1Id: { $ne: null },
    player2Id: { $ne: null },
  }).select("_id player1Id player2Id").lean();
  if (ready.length === 0) return 0;
  await mapConcurrent(ready, m => reportDeterministic(organizerCtx, m._id, m.player1Id, m.player2Id), concurrency);
  return ready.length;
}

async function playBracketToCompletion(organizerCtx, bracketId, matchConcurrency) {
  let total = 0;
  for (let round = 1; round <= 40; round++) {
    const wbPlayed = await playRoundConcurrent(organizerCtx, bracketId, "WINNERS", round, matchConcurrency);
    const lbPlayed = await playRoundConcurrent(organizerCtx, bracketId, "LOSERS", round, matchConcurrency);
    total += wbPlayed + lbPlayed;
    if (wbPlayed === 0 && lbPlayed === 0) break;
  }
  const gf = await Match.findOne({ bracketId, bracketSide: "GRAND_FINAL" });
  if (gf && gf.status === "PENDING" && gf.player1Id && gf.player2Id) {
    await reportDeterministic(organizerCtx, gf._id, gf.player1Id, gf.player2Id);
    total++;
  }
  const gfReset = await Match.findOne({ bracketId, bracketSide: "GRAND_FINAL_RESET" });
  if (gfReset && gfReset.status === "PENDING" && gfReset.player1Id && gfReset.player2Id) {
    await reportDeterministic(organizerCtx, gfReset._id, gfReset.player1Id, gfReset.player2Id);
    total++;
  }
  return total;
}

async function playFinalsCutoffToCompletion(organizerCtx, bracketId, matchConcurrency) {
  let total = 0;
  for (let round = 1; round <= 40; round++) {
    const wbPlayed = await playRoundConcurrent(organizerCtx, bracketId, "WINNERS", round, matchConcurrency);
    const lbPlayed = await playRoundConcurrent(organizerCtx, bracketId, "LOSERS", round, matchConcurrency);
    total += wbPlayed + lbPlayed;
    if (wbPlayed === 0 && lbPlayed === 0) break;
  }
  return total;
}

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
        console.log(`    [${label}] ${done}/${bracketIds.length} pools played, ${totalMatches} matches so far, ${((Date.now() - start) / 1000).toFixed(1)}s elapsed`);
      }
    },
    poolConcurrency
  );
  return totalMatches;
}

async function main() {
  await connectToDatabase();
  const t0 = Date.now();

  const organizer = await Player.findOne({ tag: "ikzilion" });
  if (!organizer) throw new Error("Organizer 'ikzilion' not found -- expected to already exist");
  const stressPlayers = await Player.find({ tag: /^StressPlayer/i }).sort({ tag: 1 });
  if (stressPlayers.length !== 700) throw new Error(`Expected 700 StressPlayer docs, found ${stressPlayers.length}`);
  console.log(`Found organizer (${organizer.tag}) and ${stressPlayers.length} StressPlayer accounts.`);

  const tournament = await Tournament.create({
    name: "700-Entrant Stress Test (Pools + Bracket, Model B)",
    game: "Street Fighter 6",
    format: "Pools + Bracket",
    poolModel: "B",
    organizers: [organizer._id],
    startDate: new Date(),
    entrantCount: 701,
    isExample: true,
  });
  console.log(`Created tournament ${tournament._id}`);

  const allPlayerIds = [organizer._id, ...stressPlayers.map(p => p._id)];
  await Entrant.insertMany(
    allPlayerIds.map(playerId => ({ playerId, tournamentId: tournament._id })),
    { ordered: false }
  );
  console.log(`Inserted ${allPlayerIds.length} entrants.`);

  await Tournament.findByIdAndUpdate(tournament._id, { status: "LIVE" });
  const organizerCtx = { playerId: organizer._id.toString(), role: "USER" };

  let currentPools = await resolvers.Mutation.generateModelBPools(null, { tournamentId: tournament._id.toString() }, organizerCtx);
  console.log(`generateModelBPools: ${currentPools.length} Round 1 pools created.`);

  let roundNumber = 1;
  while (true) {
    const isFinalsCutoff = currentPools.length === 1 && currentPools[0].isFinalsCutoff === true;
    const bracketDocs = await Bracket.find({ tournamentId: tournament._id, poolId: { $in: currentPools.map(p => p._id) } })
      .select("_id")
      .lean();
    const bracketIds = bracketDocs.map(b => b._id);

    console.log(`Playing round ${roundNumber} (${bracketIds.length} pools${isFinalsCutoff ? ", Finals-cutoff" : ""})...`);
    const playedCount = await playRoundAcrossPools(organizerCtx, bracketIds, isFinalsCutoff, 16, 6, `R${roundNumber}`);
    console.log(`Round ${roundNumber}: ${playedCount} matches played.`);

    const newPools = await resolvers.Mutation.advanceModelBRound(null, { tournamentId: tournament._id.toString() }, { ...organizerCtx, loaders: createLoaders() });

    const freshTournament = await Tournament.findById(tournament._id).select("mainBracketId");
    if (freshTournament.mainBracketId) {
      console.log(`Real Finals bracket generated (Tournament.mainBracketId = ${freshTournament.mainBracketId}) -- playing it to completion...`);
      const finalsMatches = await playBracketToCompletion(organizerCtx, freshTournament.mainBracketId, 6);
      console.log(`Finals bracket decided: ${finalsMatches} matches played.`);
      break;
    }
    currentPools = newPools;
    roundNumber++;
    if (roundNumber > 20) throw new Error("Internal error: Model B round advancement did not converge after 20 rounds");
  }

  await Tournament.findByIdAndUpdate(tournament._id, { status: "ENDED" });

  const finalPoolCount = await Pool.countDocuments({ tournamentId: tournament._id });
  const finalBracketCount = await Bracket.countDocuments({ tournamentId: tournament._id });
  const finalMatchCount = await Match.countDocuments({ tournamentId: tournament._id });
  const finalEntrantCount = await Entrant.countDocuments({ tournamentId: tournament._id });
  console.log(`\nDONE in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log(`Tournament ID: ${tournament._id}`);
  console.log(`Final counts: ${finalPoolCount} pools, ${finalBracketCount} brackets, ${finalMatchCount} matches, ${finalEntrantCount} entrants, status ENDED.`);
  console.log(`URL: https://www.fgc-ranks.com/tournaments/${tournament._id}`);

  process.exit(0);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
