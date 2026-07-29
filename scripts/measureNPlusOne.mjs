// Before/after query-count measurement for the 4 N+1 fixes made during the
// July 29, 2026 performance audit (NewsPost.author, Game.tournamentCount,
// Event.tournamentCount+gameCount, Tournament.address/logoUrl/twitchUrl).
// Same methodology as the existing Phase 7 DataLoader fix (mongoose debug
// hook counting real queries against real production data), executed
// in-process against the real ApolloServer/typeDefs/resolvers/loaders --
// not a mock.
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

process.exit(0);
