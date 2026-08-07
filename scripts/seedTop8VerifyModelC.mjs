// scripts/seedTop8VerifyModelC.mjs
//
// Rebuilds a Pool format Model C tournament (reusing real StressPlayer
// accounts, same convention as scripts/seedStressTest700ModelC.mjs) to
// verify the Top 8 tab / activeTab auto-follow fix (Aug 1, 2026). Unlike
// that script, this one deliberately STOPS the main bracket one round
// short of crossing the liveCount<=8 threshold and leaves the tournament
// LIVE (not ENDED) -- the remaining handful of matches get played via real
// UI clicks in a browser afterward, so the activeTab-auto-follow fix can be
// observed actually happening in a real page, not just traced in a script.
//
// Run: npx tsx scripts/seedTop8VerifyModelC.mjs

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
if (!process.env.MONGODB_URI) throw new Error("Missing MONGODB_URI");

const { connectToDatabase } = await import("../lib/db");
const { Player } = await import("../models/Player");
const { Tournament } = await import("../models/Tournament");
const { Entrant } = await import("../models/Entrant");
const { Match } = await import("../models/Match");
const { Bracket } = await import("../models/Bracket");
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

async function playRound(organizerCtx, bracketId, bracketSide, bracketRound) {
  const ready = await Match.find({
    bracketId, bracketSide, bracketRound, status: "PENDING",
    player1Id: { $ne: null }, player2Id: { $ne: null },
  }).select("_id player1Id player2Id").lean();
  for (const m of ready) {
    const player1Wins = m.player1Id.toString() < m.player2Id.toString();
    await resolvers.Mutation.reportResult(null, { matchId: m._id.toString(), player1Score: player1Wins ? 2 : 0, player2Score: player1Wins ? 0 : 2 }, organizerCtx);
  }
  return ready.length;
}

async function playBracketToCompletion(organizerCtx, bracketId) {
  for (let round = 1; round <= 14; round++) {
    const wb = await playRound(organizerCtx, bracketId, "WINNERS", round);
    const lb = await playRound(organizerCtx, bracketId, "LOSERS", round);
    if (wb === 0 && lb === 0) break;
  }
  const gf = await Match.findOne({ bracketId, bracketSide: "GRAND_FINAL" });
  if (gf && gf.status === "PENDING" && gf.player1Id && gf.player2Id) {
    const player1Wins = gf.player1Id.toString() < gf.player2Id.toString();
    await resolvers.Mutation.reportResult(null, { matchId: gf._id.toString(), player1Score: player1Wins ? 2 : 0, player2Score: player1Wins ? 0 : 2 }, organizerCtx);
  }
}

function computeLiveEntrantCount(seedOrder, matchesLean) {
  const losses = new Map();
  for (const m of matchesLean) {
    if (m.status !== "COMPLETED" || !m.winnerId) continue;
    const loserId = m.player1Id?.toString() === m.winnerId.toString() ? m.player2Id?.toString() : m.player1Id?.toString();
    if (!loserId) continue;
    losses.set(loserId, (losses.get(loserId) ?? 0) + 1);
  }
  return seedOrder.filter(id => (losses.get(id) ?? 0) < 2).length;
}

async function main() {
  await connectToDatabase();
  const t0 = Date.now();

  // Organizer is SimPlayer02, not ikzilion -- this script needs to log in
  // as the organizer via Playwright afterward to click real report-result
  // buttons, and ikzilion's real password isn't something to guess/use.
  // SimPlayer02's password (TestPass123!) is already documented (Notion,
  // scripts/seedBracketSimulation.js) and confirmed working.
  const organizer = await Player.findOne({ tag: "SimPlayer02" });
  if (!organizer) throw new Error("Organizer 'SimPlayer02' not found");
  const stressPlayers = await Player.find({ tag: /^StressPlayer/i }).sort({ tag: 1 }).limit(300);
  console.log(`Using ${stressPlayers.length} StressPlayer accounts + organizer (${organizer.tag}).`);

  const tournament = await Tournament.create({
    name: "Top 8 Auto-Follow Verify (Model C)",
    game: "Street Fighter 6",
    format: "Pools + Bracket",
    poolModel: "C",
    organizers: [organizer._id],
    startDate: new Date(),
    entrantCount: stressPlayers.length + 1,
  });
  console.log(`Created tournament ${tournament._id}`);

  const allPlayerIds = [organizer._id, ...stressPlayers.map(p => p._id)];
  await Entrant.insertMany(allPlayerIds.map(playerId => ({ playerId, tournamentId: tournament._id })), { ordered: false });
  console.log(`Inserted ${allPlayerIds.length} entrants.`);

  await Tournament.findByIdAndUpdate(tournament._id, { status: "LIVE" });
  const organizerCtx = { playerId: organizer._id.toString(), role: "USER" };

  const pools = await resolvers.Mutation.generatePools(null, { tournamentId: tournament._id.toString(), poolCount: 40 }, organizerCtx);
  console.log(`generatePools: ${pools.length} pools created (targeting ${pools.length * 2} finalists).`);

  const poolBrackets = await Bracket.find({ tournamentId: tournament._id, poolId: { $in: pools.map(p => p._id) } }).select("_id").lean();
  let poolsPlayed = 0;
  await mapConcurrent(poolBrackets, async b => {
    await playBracketToCompletion(organizerCtx, b._id);
    poolsPlayed++;
    if (poolsPlayed % 10 === 0 || poolsPlayed === poolBrackets.length) console.log(`  ${poolsPlayed}/${poolBrackets.length} pool brackets decided...`);
  }, 8);

  const mainBracketDoc = await resolvers.Mutation.generateMainBracket(null, { tournamentId: tournament._id.toString(), seedingMethod: "RANDOM" }, { ...organizerCtx, loaders: createLoaders() });
  const mainBracketId = mainBracketDoc._id;
  const seedOrder = mainBracketDoc.seedOrder.map(id => id.toString());
  console.log(`generateMainBracket: size ${mainBracketDoc.size}, ${seedOrder.length} finalists seeded.\n`);

  console.log("Round-by-round liveCount trace (stopping just before liveCount <= 8):");
  for (let round = 1; round <= 14; round++) {
    const allMatchesBefore = await Match.find({ bracketId: mainBracketId }).select("player1Id player2Id winnerId status").lean();
    const liveCountBefore = computeLiveEntrantCount(seedOrder, allMatchesBefore);
    if (liveCountBefore <= 8) {
      console.log(`  Stopping BEFORE round ${round}: liveCount is already ${liveCountBefore} (<=8) -- would cross here. Backing off is not needed, already stopped in time last round.`);
      break;
    }

    // Peek: would this round's plays push liveCount to <=8? If likely close,
    // play only the WINNERS side first and re-check before playing LOSERS,
    // so we can stop with just 1-2 real PENDING matches left for the UI
    // click-through demo instead of overshooting.
    const wbPlayed = await playRound(organizerCtx, mainBracketId, "WINNERS", round);
    const afterWb = await Match.find({ bracketId: mainBracketId }).select("player1Id player2Id winnerId status").lean();
    const liveCountAfterWb = computeLiveEntrantCount(seedOrder, afterWb);
    console.log(`  Round ${round}: WB played ${wbPlayed} -> liveCount=${liveCountAfterWb}`);
    if (liveCountAfterWb <= 8) {
      console.log(`  liveCount crossed <=8 mid-round after just the WINNERS side -- leaving LOSERS round ${round} UNPLAYED for the UI demo.`);
      break;
    }

    const lbPlayed = await playRound(organizerCtx, mainBracketId, "LOSERS", round);
    const afterLb = await Match.find({ bracketId: mainBracketId }).select("player1Id player2Id winnerId status").lean();
    const liveCountAfterLb = computeLiveEntrantCount(seedOrder, afterLb);
    console.log(`  Round ${round}: LB played ${lbPlayed} -> liveCount=${liveCountAfterLb}`);
    if (wbPlayed === 0 && lbPlayed === 0) break;
    if (liveCountAfterLb <= 8) {
      console.log(`  liveCount crossed <=8 after this round -- should have stopped sooner, but leaving as-is.`);
      break;
    }
  }

  const finalMatches = await Match.find({ bracketId: mainBracketId }).select("player1Id player2Id winnerId status bracketSide bracketRound").lean();
  const finalLiveCount = computeLiveEntrantCount(seedOrder, finalMatches);
  const readyToPlay = finalMatches.filter(m => m.status === "PENDING" && m.player1Id && m.player2Id);
  console.log(`\nStopped with liveCount=${finalLiveCount} (mainStartCount=${seedOrder.length}).`);
  console.log(`showTop24 right now: ${seedOrder.length >= 48 && finalLiveCount <= 24}`);
  console.log(`showTop8 right now: ${seedOrder.length >= 16 && finalLiveCount <= 8} (should be false -- that's the point)`);
  console.log(`Real PENDING matches ready to report (do these via the UI to cross the threshold): ${readyToPlay.length}`);
  console.log(readyToPlay.map(m => `  ${m.bracketSide} R${m.bracketRound}: ${m._id}`).join("\n"));

  console.log(`\nDONE in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log(`Tournament ID: ${tournament._id}`);
  console.log(`URL: https://www.fgc-ranks.com/tournaments/${tournament._id}`);
  console.log(`Organizer: ${organizer.tag} -- log in as this account to see the report-result buttons`);

  process.exit(0);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
