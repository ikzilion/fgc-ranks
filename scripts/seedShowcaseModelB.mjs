// scripts/seedShowcaseModelB.mjs
//
// Showcase tournament for Pool format Model B (EVO-style massive-scale
// continuous carry-over pools) at 128 entrants -- the format's hard
// MODEL_B_MIN_ENTRANTS floor (lib/bracket.ts: generateModelBPools/
// generateModelBTournament both throw below it, since Model B's own math
// collapses to Model C-equivalent behavior below that scale). Every other
// showcase tournament in this batch uses 16-32 entrants; Model B can't go
// that low and still be a genuine Model B bracket, so 128 is used instead
// (decision confirmed with the user, Aug 6, 2026) -- still far smaller than
// the existing 701-entrant scale-reference tournament
// (scripts/loadTestModelBScale.mjs's own 130-entrant smoke test used a
// near-identical scale for the same structural reason).
//
// Direct-to-Mongo via connectToDatabase(), calling the REAL
// generateModelBPools/advanceModelBRound/reportResult resolvers (graphql/
// resolvers/index.ts), reusing the existing StressPlayer Player docs
// already in the DB (no new players created) plus ikzilion as
// organizer+entrant. Marked isExample: true.
//
// Round-to-round play/advance loop structure reused from
// scripts/loadTestModelBScale.mjs's runFullLifecycle -- but that script
// ALWAYS deletes its tournaments afterward (a load/timing test) and its
// loop breaks the instant Tournament.mainBracketId is set, without playing
// the newly-generated real Finals bracket at all (irrelevant for a timing
// measurement that's about to be torn down). This script's whole point is
// the opposite -- persist a genuinely finished tournament -- so after the
// loop it explicitly ALSO plays that real Finals bracket to completion and
// only then marks the tournament ENDED. This is exactly the class of
// mistake this project has hit before (a disposable finishing script once
// force-ended a tournament without confirming the bracket was actually
// decided, resulting in zero placements) -- don't repeat it.
//
// Run: npx tsx scripts/seedShowcaseModelB.mjs

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

const ENTRANT_COUNT = 128; // 127 StressPlayer + ikzilion -- MODEL_B_MIN_ENTRANTS
const STRESS_PLAYER_OFFSET = 48; // disjoint from the other 2 small showcase scripts' slices (not required, just tidy)

const { connectToDatabase } = await import("../lib/db");
const { Player } = await import("../models/Player");
const { Tournament } = await import("../models/Tournament");
const { Entrant } = await import("../models/Entrant");
const { Match } = await import("../models/Match");
const { Bracket } = await import("../models/Bracket");
const { Pool } = await import("../models/Pool");
const { resolvers } = await import("../graphql/resolvers/index");

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

// Deterministic "lower playerId wins" convention -- same rule
// seedStressTest700ModelA/C.mjs use. Verified safe against ever needing a
// Grand Final Reset: lib/bracket.ts's buildDoubleEliminationBracket always
// assigns Grand Final player1 = winners-side finalist, player2 =
// losers-side finalist ("Convention: ... advanceBracketMatch relies on this
// order to detect a reset" -- lib/bracket.ts ~line 390), and a reset only
// fires when player2 wins game 1. Under a GLOBAL total order where the
// lower-ID player always wins every match they're in, the minimum-ID
// entrant never loses, so they never drop to the Losers bracket and always
// represent the Winners side at every stage including the Grand Final --
// meaning player1 (WB side) always wins it directly. This is a general
// property of the convention itself (any bracket shape), not specific to
// Model B's repooled brackets, but it's still explicitly verified after the
// fact below rather than just assumed.
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
  await mapConcurrent(
    ready,
    async m => reportDeterministic(organizerCtx, m._id, m.player1Id, m.player2Id),
    concurrency
  );
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
  // Defensive check, not expected to ever fire (see the reasoning above) --
  // this project has a documented history of a finishing script wrongly
  // assuming a bracket was decided, so verify rather than assume.
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

async function playRoundAcrossPools(organizerCtx, bracketIds, isFinalsCutoff, poolConcurrency, matchConcurrency) {
  let totalMatches = 0;
  await mapConcurrent(
    bracketIds,
    async bracketId => {
      const played = isFinalsCutoff
        ? await playFinalsCutoffToCompletion(organizerCtx, bracketId, matchConcurrency)
        : await playBracketToCompletion(organizerCtx, bracketId, matchConcurrency);
      totalMatches += played;
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
  const stressPlayers = await Player.find({ tag: /^StressPlayer/i })
    .sort({ tag: 1 })
    .skip(STRESS_PLAYER_OFFSET)
    .limit(ENTRANT_COUNT - 1);
  if (stressPlayers.length !== ENTRANT_COUNT - 1) {
    throw new Error(`Expected ${ENTRANT_COUNT - 1} StressPlayer docs, found ${stressPlayers.length}`);
  }
  console.log(`Found organizer (${organizer.tag}) and ${stressPlayers.length} StressPlayer accounts.`);

  const tournament = await Tournament.create({
    name: "Showcase: Pool Stage Model B",
    game: "Street Fighter 6",
    format: "Pools + Bracket",
    poolModel: "B",
    organizers: [organizer._id],
    startDate: new Date(),
    entrantCount: ENTRANT_COUNT,
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

  // ── Round 1 ──
  let currentPools = await resolvers.Mutation.generateModelBPools(null, { tournamentId: tournament._id.toString() }, organizerCtx);
  console.log(`generateModelBPools: ${currentPools.length} Round 1 pools created.`);

  let roundNumber = 1;
  while (true) {
    const isFinalsCutoff = currentPools.length === 1 && currentPools[0].isFinalsCutoff === true;
    const bracketDocs = await Bracket.find({ tournamentId: tournament._id, poolId: { $in: currentPools.map(p => p._id) } })
      .select("_id")
      .lean();
    const bracketIds = bracketDocs.map(b => b._id);

    const playedCount = await playRoundAcrossPools(organizerCtx, bracketIds, isFinalsCutoff, 8, 4);
    console.log(`Round ${roundNumber} (${bracketIds.length} pool${isFinalsCutoff ? ", Finals-cutoff" : ""}${bracketIds.length === 1 ? "" : "s"}): ${playedCount} matches played.`);

    const newPools = await resolvers.Mutation.advanceModelBRound(null, { tournamentId: tournament._id.toString() }, organizerCtx);

    const freshTournament = await Tournament.findById(tournament._id).select("mainBracketId");
    if (freshTournament.mainBracketId) {
      console.log(`Real Finals bracket generated (Tournament.mainBracketId = ${freshTournament.mainBracketId}) -- playing it to completion...`);
      const finalsMatches = await playBracketToCompletion(organizerCtx, freshTournament.mainBracketId, 4);
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
