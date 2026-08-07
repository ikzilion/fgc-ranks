// scripts/seedShowcaseStandard.mjs
//
// Small (32-entrant) showcase tournament for the "Standard Bracket" format
// -- lets a soon-to-be TO browse a real, fully-decided bracket of this
// format without wading through the existing 701-entrant scale-reference
// tournament. Marked isExample: true so it's badged on the public
// Tournaments list/detail page, but otherwise a completely normal, public,
// fully-playable tournament -- same convention as the 701-entrant stress
// tests (scripts/seedStressTest700ModelA.mjs etc.): direct-to-Mongo via
// connectToDatabase(), calling the REAL generateBracket/reportResult
// resolvers (graphql/resolvers/index.ts), reusing the existing StressPlayer
// Player docs already in the DB (no new players created) plus ikzilion as
// organizer+entrant.
//
// Run: npx tsx scripts/seedShowcaseStandard.mjs

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

const ENTRANT_COUNT = 32; // 31 StressPlayer + ikzilion

const { connectToDatabase } = await import("../lib/db");
const { Player } = await import("../models/Player");
const { Tournament } = await import("../models/Tournament");
const { Entrant } = await import("../models/Entrant");
const { Match } = await import("../models/Match");
const { Bracket } = await import("../models/Bracket");
const { resolvers } = await import("../graphql/resolvers/index");

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
    name: "Showcase: Standard Bracket",
    game: "Street Fighter 6",
    format: "Standard Bracket",
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

  const bracket = await resolvers.Mutation.generateBracket(
    null,
    { tournamentId: tournament._id.toString(), seedingMethod: "RANDOM" },
    organizerCtx
  );
  console.log(`generateBracket: size ${bracket.size}.`);

  // Deterministic "lower playerId wins" convention -- same rule used across
  // every stress/load-test script in this repo. Under this rule the global
  // minimum-ID player never loses, so they always represent the Winners
  // side in the Grand Final and win it outright -- a bracket reset is never
  // triggered, matching precedent (seedStressTest700ModelA/C.mjs never
  // handle GRAND_FINAL_RESET either). Still explicitly verified after the
  // fact rather than assumed -- see the follow-up verification pass.
  let totalPlayed = 0;
  for (let round = 1; round <= 40; round++) {
    let playedThisRound = 0;
    for (const side of ["WINNERS", "LOSERS"]) {
      const ready = await Match.find({
        bracketId: bracket.id,
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
    totalPlayed += playedThisRound;
    console.log(`  Round ${round}: ${playedThisRound} matches played.`);
    if (playedThisRound === 0) break;
  }

  const gf = await Match.findOne({ bracketId: bracket.id, bracketSide: "GRAND_FINAL" });
  if (gf && gf.status === "PENDING" && gf.player1Id && gf.player2Id) {
    const player1Wins = gf.player1Id.toString() < gf.player2Id.toString();
    await resolvers.Mutation.reportResult(
      null,
      { matchId: gf._id.toString(), player1Score: player1Wins ? 2 : 0, player2Score: player1Wins ? 0 : 2 },
      organizerCtx
    );
    totalPlayed++;
    console.log("Grand Final reported.");
  }

  // Handle a bracket-reset Grand Final if one was somehow created (defensive
  // -- the deterministic convention above should make this impossible, but
  // this is the exact failure mode the task's history warns about, so don't
  // assume, check).
  const gfReset = await Match.findOne({ bracketId: bracket.id, bracketSide: "GRAND_FINAL_RESET" });
  if (gfReset && gfReset.status === "PENDING" && gfReset.player1Id && gfReset.player2Id) {
    const player1Wins = gfReset.player1Id.toString() < gfReset.player2Id.toString();
    await resolvers.Mutation.reportResult(
      null,
      { matchId: gfReset._id.toString(), player1Score: player1Wins ? 2 : 0, player2Score: player1Wins ? 0 : 2 },
      organizerCtx
    );
    totalPlayed++;
    console.log("Grand Final Reset reported.");
  }

  await Tournament.findByIdAndUpdate(tournament._id, { status: "ENDED" });

  const finalMatchCount = await Match.countDocuments({ tournamentId: tournament._id });
  const finalEntrantCount = await Entrant.countDocuments({ tournamentId: tournament._id });
  console.log(`\nDONE in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log(`Tournament ID: ${tournament._id}`);
  console.log(`Final counts: ${finalMatchCount} matches (${totalPlayed} reported), ${finalEntrantCount} entrants, status ENDED.`);
  console.log(`URL: https://www.fgc-ranks.com/tournaments/${tournament._id}`);

  process.exit(0);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
