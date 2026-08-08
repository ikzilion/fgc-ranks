// scripts/seedShowcaseModelA.mjs
//
// Small (56-entrant) showcase tournament for Pool format Model A
// (round-robin pools) -- lets a soon-to-be TO browse a real, fully-decided
// bracket of this format without wading through the existing 701-entrant
// scale-reference tournament (scripts/seedStressTest700ModelA.mjs, which
// this script mirrors at a much smaller, human-digestible scale). Marked
// isExample: true so it's badged on the public Tournaments list/detail
// page, but otherwise a completely normal, public, fully-playable
// tournament. Direct-to-Mongo via connectToDatabase(), calling the REAL
// generatePools/reportResult/generateMainBracket resolvers, reusing the
// existing StressPlayer Player docs already in the DB (no new players
// created) plus ikzilion as organizer+entrant. Sized at 56 (not the
// original 24) so the main bracket clears the 16-entrant floor needed for
// the Top 8 tab to appear -- see ENTRANT_COUNT below.
//
// Run: npx tsx scripts/seedShowcaseModelA.mjs

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

// 56, not 24 -- suggestPoolCount(56) = round(56/7) = 8 pools of 7 (the
// platform's natural pool-size target), advancing 2 finalists/pool = 16 to
// the main bracket. That clears the >=16-entrant floor lib/bracketTierView.tsx
// (via PoolsSection.tsx's showTop8) requires before a Top 8 tab can ever
// appear -- the original 24-entrant size produced only 3 pools / 6
// finalists, so its main bracket structurally could never reach the
// threshold no matter how the bracket played out, silently omitting the Top
// 8 tab from this showcase (found investigating a report that Model C's
// showcase never displayed one, Aug 7, 2026 -- Model A had the identical
// gap, confirmed not format-specific).
const ENTRANT_COUNT = 56; // 55 StressPlayer + ikzilion

const { connectToDatabase } = await import("../lib/db");
const { Player } = await import("../models/Player");
const { Tournament } = await import("../models/Tournament");
const { Entrant } = await import("../models/Entrant");
const { Match } = await import("../models/Match");
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

async function main() {
  await connectToDatabase();
  const t0 = Date.now();

  const organizer = await Player.findOne({ tag: "ikzilion" });
  if (!organizer) throw new Error("Organizer 'ikzilion' not found -- expected to already exist");
  const stressPlayers = await Player.find({ tag: /^StressPlayer/i }).sort({ tag: 1 }).limit(ENTRANT_COUNT - 1);
  if (stressPlayers.length !== ENTRANT_COUNT - 1) {
    throw new Error(`Expected ${ENTRANT_COUNT - 1} StressPlayer docs, found ${stressPlayers.length}`);
  }
  console.log(`Found organizer (${organizer.tag}) and ${stressPlayers.length} StressPlayer accounts.`);

  const tournament = await Tournament.create({
    name: "Showcase: Pool Stage Model A",
    game: "Street Fighter 6",
    format: "Pools + Bracket",
    poolModel: "A",
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

  const pools = await resolvers.Mutation.generatePools(null, { tournamentId: tournament._id.toString() }, organizerCtx);
  console.log(`generatePools: ${pools.length} round-robin pools created.`);

  const allMatches = await Match.find({ poolId: { $in: pools.map(p => p._id) }, status: "PENDING" }).select("_id player1Id player2Id").lean();
  console.log(`Playing ${allMatches.length} round-robin matches...`);
  let played = 0;
  await mapConcurrent(
    allMatches,
    async m => {
      const player1Wins = m.player1Id.toString() < m.player2Id.toString();
      await resolvers.Mutation.reportResult(
        null,
        { matchId: m._id.toString(), player1Score: player1Wins ? 2 : 0, player2Score: player1Wins ? 0 : 2 },
        organizerCtx
      );
      played++;
    },
    8
  );
  console.log(`All ${played} round-robin matches reported.`);

  const mainBracket = await resolvers.Mutation.generateMainBracket(
    null,
    { tournamentId: tournament._id.toString(), seedingMethod: "RANDOM" },
    { ...organizerCtx, loaders: createLoaders() }
  );
  console.log(`generateMainBracket: size ${mainBracket.size}, ${pools.length * 2} finalists seeded.`);

  let mainPlayed = 0;
  for (let round = 1; round <= 40; round++) {
    let playedThisRound = 0;
    for (const side of ["WINNERS", "LOSERS"]) {
      const ready = await Match.find({
        bracketId: mainBracket.id,
        bracketSide: side,
        bracketRound: round,
        status: "PENDING",
        player1Id: { $ne: null },
        player2Id: { $ne: null },
      }).select("_id player1Id player2Id").lean();
      for (const m of ready) {
        const player1Wins = m.player1Id.toString() < m.player2Id.toString();
        await resolvers.Mutation.reportResult(
          null,
          { matchId: m._id.toString(), player1Score: player1Wins ? 2 : 0, player2Score: player1Wins ? 0 : 2 },
          organizerCtx
        );
        playedThisRound++;
      }
    }
    mainPlayed += playedThisRound;
    console.log(`  Main bracket round ${round}: ${playedThisRound} matches played.`);
    if (playedThisRound === 0) break;
  }

  const gf = await Match.findOne({ bracketId: mainBracket.id, bracketSide: "GRAND_FINAL" });
  if (gf && gf.status === "PENDING" && gf.player1Id && gf.player2Id) {
    const player1Wins = gf.player1Id.toString() < gf.player2Id.toString();
    await resolvers.Mutation.reportResult(
      null,
      { matchId: gf._id.toString(), player1Score: player1Wins ? 2 : 0, player2Score: player1Wins ? 0 : 2 },
      organizerCtx
    );
    mainPlayed++;
    console.log("Grand Final reported -- main bracket decided.");
  }

  // Defensive: handle a bracket-reset Grand Final if one was somehow
  // created (the deterministic lower-ID-wins convention should make this
  // impossible -- see seedShowcaseStandard.mjs's reasoning -- but check
  // rather than assume).
  const gfReset = await Match.findOne({ bracketId: mainBracket.id, bracketSide: "GRAND_FINAL_RESET" });
  if (gfReset && gfReset.status === "PENDING" && gfReset.player1Id && gfReset.player2Id) {
    const player1Wins = gfReset.player1Id.toString() < gfReset.player2Id.toString();
    await resolvers.Mutation.reportResult(
      null,
      { matchId: gfReset._id.toString(), player1Score: player1Wins ? 2 : 0, player2Score: player1Wins ? 0 : 2 },
      organizerCtx
    );
    mainPlayed++;
    console.log("Grand Final Reset reported.");
  }

  await Tournament.findByIdAndUpdate(tournament._id, { status: "ENDED" });

  const finalPoolCount = await Pool.countDocuments({ tournamentId: tournament._id });
  const finalMatchCount = await Match.countDocuments({ tournamentId: tournament._id });
  const finalEntrantCount = await Entrant.countDocuments({ tournamentId: tournament._id });
  console.log(`\nDONE in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log(`Tournament ID: ${tournament._id}`);
  console.log(`Final counts: ${finalPoolCount} pools, ${finalMatchCount} matches (${mainPlayed} main bracket reported), ${finalEntrantCount} entrants, status ENDED.`);
  console.log(`URL: https://www.fgc-ranks.com/tournaments/${tournament._id}`);

  process.exit(0);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
