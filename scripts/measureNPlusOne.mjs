// Before/after query-count measurement for the N+1 fixes made during the
// July 29, 2026 performance audit (NewsPost.author, Game.tournamentCount,
// Event.tournamentCount+gameCount, Tournament.address/logoUrl/twitchUrl) --
// see a-d below -- PLUS the Aug 1, 2026 Pool.bracket/Bracket.matches fix
// (see e below). Same methodology as the existing Phase 7 DataLoader fix
// (mongoose debug hook counting real queries against real production data),
// executed in-process against the real ApolloServer/typeDefs/resolvers/
// loaders -- not a mock.
//
// IMPORTANT, learned the hard way (Aug 1, 2026): a-d never touched Pool or
// Bracket at all, so this script reported "42 queries, 4.3s" as if the whole
// tournament detail page were fixed, while the real page (an 85-pool
// tournament) was still taking ~23s in production -- a completely separate,
// unbatched N+1 in Pool.bracket/Bracket.matches that this benchmark's a-d
// section structurally could not have caught, no matter how carefully it
// was run. Section e below closes that gap by running the ACTUAL detail-
// page query against the real largest Pools + Bracket tournament in the DB.
// Don't trust a query-count/timing benchmark for this page again unless it
// includes e (or an equivalent real-scale Pool/Bracket check) -- a-d passing
// is NOT evidence the tournament detail page itself is fast.
//
// Run twice: once against the CURRENT (fixed) working tree, and once after
// `git stash -- graphql/resolvers/index.ts graphql/loaders.ts` (which
// reverts just those two files to the pre-fix version already committed on
// main) to get the "before" numbers, then `git stash pop` to restore.
// Run: npx tsx scripts/measureNPlusOne.mjs

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

const mongoose = (await import("mongoose")).default;
const { connectToDatabase } = await import("../lib/db");
const { ApolloServer } = await import("@apollo/server");
const { typeDefs } = await import("../graphql/schema");
const { resolvers } = await import("../graphql/resolvers");
const { createLoaders } = await import("../graphql/loaders");

await connectToDatabase();

let queryCount = 0;
const byCollection = new Map();
mongoose.set("debug", (collectionName, method) => {
  queryCount++;
  const key = `${collectionName}.${method}`;
  byCollection.set(key, (byCollection.get(key) ?? 0) + 1);
});

const server = new ApolloServer({ typeDefs, resolvers });

async function run(label, query, variables = {}) {
  queryCount = 0;
  byCollection.clear();
  const res = await server.executeOperation({ query, variables }, { contextValue: { loaders: createLoaders() } });
  const errors = res.body.kind === "single" ? res.body.singleResult.errors : undefined;
  if (errors) {
    console.log(`  ${label}: ERRORS ${JSON.stringify(errors.map(e => e.message))}`);
    return;
  }
  const data = res.body.kind === "single" ? res.body.singleResult.data : undefined;
  const itemCount = Array.isArray(data?.[Object.keys(data)[0]]) ? data[Object.keys(data)[0]].length : 1;
  console.log(`  ${label}: ${itemCount} item(s) -> ${queryCount} DB queries [${[...byCollection.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}]`);
}

console.log("=== a. NewsPost.author (homepage newsPosts(limit:20)) ===");
await run(
  "newsPosts",
  `query { newsPosts(limit: 20) { id author { id tag } } }`
);

console.log("\n=== b. Game.tournamentCount (/games list) ===");
await run("games", `query { games { id name tournamentCount } }`);

console.log("\n=== c. Event.tournamentCount + gameCount (/events list) ===");
await run(
  "events",
  `query { events(limit: 100) { id name tournamentCount gameCount } }`
);

console.log("\n=== d. Tournament.address/logoUrl/twitchUrl (tournaments list, limit 1000) ===");
await run("tournaments (address only)", `query { tournaments(limit: 1000) { id address } }`);

console.log("\n=== d(ii). Same 3 fields together on ONE tournament (detail-page shape) ===");
const { Tournament } = await import("../models/Tournament");
const anyEventLinked = await Tournament.findOne({ eventId: { $ne: null } }).lean();
if (anyEventLinked) {
  await run(
    "tournament(id) { address logoUrl twitchUrl }",
    `query($id: ID!) { tournament(id: $id) { id address logoUrl twitchUrl } }`,
    { id: anyEventLinked._id.toString() }
  );
} else {
  console.log("  (no event-linked tournament found in this DB to test the triple-fetch shape)");
}

// === e. THE ACTUAL tournament-detail-page query (app/tournaments/[id]/
// page.tsx's GET_TOURNAMENT, reproduced verbatim below) against the REAL
// largest Pools + Bracket tournament in this DB -- added Aug 1, 2026 after
// the earlier a-d measurements above gave a false "fixed" signal (42
// queries, 4.3s) that never actually exercised Pool.bracket/Bracket.matches
// at all, while the real production tournament page for an 85-pool
// tournament was still taking ~23s. Finding the tournament with the MOST
// pools (rather than a hardcoded id that a later test-data cleanup could
// delete) keeps this benchmark meaningful as real data changes -- the whole
// point is catching this class of gap at real scale, not just re-confirming
// a small/empty case works.
const { Pool } = await import("../models/Pool");
const poolCounts = await Pool.aggregate([
  { $group: { _id: "$tournamentId", poolCount: { $sum: 1 } } },
  { $sort: { poolCount: -1 } },
  { $limit: 1 },
]);
if (poolCounts.length > 0) {
  const { _id: biggestPoolsTournamentId, poolCount } = poolCounts[0];
  const MATCH_FIELDS = `
    id round status bracketSide bracketRound bracketPosition player1Score
    player2Score isForfeit player1 { id tag } player2 { id tag }
    winner { id tag } nextMatch { id } nextLoserMatch { id } canUndo
  `;
  console.log(`\n=== e. FULL GetTournament detail-page query against the largest real Pools + Bracket tournament (${poolCount} pools, id ${biggestPoolsTournamentId}) ===`);
  await run(
    `tournament(id) { ...full detail-page shape, ${poolCount} pools }`,
    `query($id: ID!) {
      tournament(id: $id) {
        id name entrantCount
        entrants { id seed placement checkedInAt pointsEarned player { id tag avatarUrl characters } }
        bracket { id seedingMethod size matches { ${MATCH_FIELDS} } }
        pools {
          id poolNumber roundNumber isFinalsCutoff
          entrants { id player { id tag avatarUrl } }
          bracket { id seedingMethod size matches { ${MATCH_FIELDS} } }
          matches { ${MATCH_FIELDS} }
          standings { rank matchWins matchLosses gamesWon gamesLost entrant { id player { id tag avatarUrl } } }
        }
        mainBracket { id seedingMethod size seedOrder { id } matches { ${MATCH_FIELDS} } }
        allPoolsComplete modelBCurrentRoundComplete
      }
      players(limit: 200) { id tag }
    }`,
    { id: biggestPoolsTournamentId.toString() }
  );
} else {
  console.log("\n=== e. FULL GetTournament detail-page query (Pools + Bracket) ===");
  console.log("  (no Pools + Bracket tournament with any pools found in this DB -- this benchmark needs one to actually catch a Pool/Bracket-scoped N+1 regression; create one via scripts/seedPoolsSimulation.js or similar before trusting a-d's numbers as representative of the tournament detail page)");
}

process.exit(0);
