// Before/after query-count measurement for the /players/[id] profile page's
// GraphQL query (the "player" query with tournaments{tournament{...}} and
// gameRankings). Same methodology as scripts/measureNPlusOne.mjs: an
// in-process ApolloServer (real typeDefs/resolvers/loaders, not a mock)
// against real production data, counting real DB round trips via mongoose's
// debug hook.
//
// Run against the CURRENT working tree for the "before" numbers, then again
// after applying the fix for "after".
// Run: npx tsx scripts/measurePlayerProfileQueries.mjs <playerId>

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

const playerId = process.argv[2];
if (!playerId) throw new Error("Usage: npx tsx scripts/measurePlayerProfileQueries.mjs <playerId>");

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

const GET_PLAYER = `
  query GetPlayer($id: ID!) {
    player(id: $id) {
      id
      tag
      points
      gameRankings { game points rank }
      tournaments {
        id
        placement
        tournament { id name game status startDate entrantCount }
      }
    }
  }
`;

async function run(label, query, variables) {
  queryCount = 0;
  byCollection.clear();
  const start = Date.now();
  const res = await server.executeOperation({ query, variables }, { contextValue: { loaders: createLoaders() } });
  const elapsedMs = Date.now() - start;
  const errors = res.body.kind === "single" ? res.body.singleResult.errors : undefined;
  if (errors) {
    console.log(`  ${label}: ERRORS ${JSON.stringify(errors.map(e => e.message))}`);
    return;
  }
  const data = res.body.kind === "single" ? res.body.singleResult.data : undefined;
  console.log(`  ${label}: ${queryCount} DB queries, ${elapsedMs}ms in-process resolver time`);
  console.log(`    by collection: ${[...byCollection.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
  const p = data?.player;
  if (p) {
    console.log(`    tournaments=${p.tournaments?.length ?? 0}, gameRankings=${p.gameRankings?.length ?? 0} (games: ${(p.gameRankings ?? []).map(g => g.game).join(", ")})`);
  }
}

console.log(`=== GET_PLAYER for playerId=${playerId} ===`);
// Run once to let Mongoose's one-time-per-process autoIndex createIndex
// calls settle (they're a connection-warmup cost, not a per-request query a
// real warm serverless instance repeats -- indexes already exist in the
// actual database), then measure for real on the second, now-quiet run.
await run("(warm-up, createIndex noise expected)", GET_PLAYER, { id: playerId });
await run("player profile query", GET_PLAYER, { id: playerId });

process.exit(0);
