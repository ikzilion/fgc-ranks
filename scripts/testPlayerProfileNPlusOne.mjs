// Before/after query-count verification for the /players/[id] profile page's
// Entrant.tournament N+1 fix (July 30, 2026 performance investigation, same
// bug class/methodology as the tournament-page fix, commit bc8ab98, and the
// July 29 audit's scripts/measureNPlusOne.mjs): Entrant.tournament used to do
// an individual Tournament.findById per entrant -- exactly one per
// tournament a player has ever entered, unbatched, right next to
// Entrant.player which WAS already going through playerLoader.
//
// Real in-process ApolloServer (actual typeDefs/resolvers/loaders, not a
// mock) against a real (throwaway) player with 30 real tournament entries,
// counting real DB round trips via mongoose's debug hook. Confirms the fix
// is genuinely O(1) per request regardless of entry count, not just "a bit
// fewer queries" for one specific small case.
//
// Run: npx tsx scripts/testPlayerProfileNPlusOne.mjs

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
const { Player } = await import("../models/Player");
const { Tournament } = await import("../models/Tournament");
const { Entrant } = await import("../models/Entrant");
const { ApolloServer } = await import("@apollo/server");
const { typeDefs } = await import("../graphql/schema");
const { resolvers } = await import("../graphql/resolvers");
const { createLoaders } = await import("../graphql/loaders");

const ENTRANT_COUNT = 30;
const GET_PLAYER = `query GetPlayer($id: ID!) { player(id: $id) { id tournaments { id tournament { id name } } } }`;

async function main() {
  let failures = 0;
  function assert(cond, label) {
    if (cond) {
      console.log(`  OK   ${label}`);
    } else {
      console.log(`  FAIL ${label}`);
      failures++;
    }
  }

  await connectToDatabase();

  await Player.deleteOne({ tag: "PerfNPlusOneTestPlayer" });
  const player = await Player.create({ tag: "PerfNPlusOneTestPlayer" });
  const tournamentIds = [];
  for (let i = 0; i < ENTRANT_COUNT; i++) {
    const t = await Tournament.create({ name: `PerfNPlusOneTournament${i}`, game: "Street Fighter 6", startDate: new Date(), status: "ENDED" });
    tournamentIds.push(t._id);
  }
  await Entrant.insertMany(tournamentIds.map((tid, i) => ({ playerId: player._id, tournamentId: tid, placement: (i % 8) + 1 })));

  let queryCount = 0;
  const byCollection = new Map();
  mongoose.set("debug", (collectionName, method) => {
    queryCount++;
    byCollection.set(`${collectionName}.${method}`, (byCollection.get(`${collectionName}.${method}`) ?? 0) + 1);
  });

  const server = new ApolloServer({ typeDefs, resolvers });

  try {
    // Warm-up run first -- Mongoose's one-time-per-process autoIndex
    // createIndex calls would otherwise inflate the real measurement below.
    await server.executeOperation({ query: GET_PLAYER, variables: { id: player._id.toString() } }, { contextValue: { loaders: createLoaders() } });

    queryCount = 0;
    byCollection.clear();
    const res = await server.executeOperation({ query: GET_PLAYER, variables: { id: player._id.toString() } }, { contextValue: { loaders: createLoaders() } });
    const errors = res.body.kind === "single" ? res.body.singleResult.errors : undefined;
    const data = res.body.kind === "single" ? res.body.singleResult.data : undefined;

    assert(!errors, `query executes with no errors ${errors ? JSON.stringify(errors.map(e => e.message)) : ""}`);
    assert(data?.player?.tournaments?.length === ENTRANT_COUNT, `all ${ENTRANT_COUNT} tournament entries are returned (got ${data?.player?.tournaments?.length})`);

    const tournamentFindOneCount = byCollection.get("tournaments.findOne") ?? 0;
    const tournamentFindCount = byCollection.get("tournaments.find") ?? 0;
    assert(tournamentFindOneCount === 0, `zero individual tournaments.findOne calls (found ${tournamentFindOneCount}) -- was ${ENTRANT_COUNT} before the tournamentLoader fix`);
    assert(tournamentFindCount === 1, `exactly one batched tournaments.find call regardless of ${ENTRANT_COUNT} entries (found ${tournamentFindCount})`);
    assert(
      queryCount <= 4,
      `total DB queries stay small and O(1), not O(N) (found ${queryCount} for ${ENTRANT_COUNT} entries: ${[...byCollection.entries()].map(([k, v]) => `${k}=${v}`).join(", ")})`
    );
  } finally {
    await Entrant.deleteMany({ playerId: player._id });
    await Tournament.deleteMany({ _id: { $in: tournamentIds } });
    await Player.deleteOne({ _id: player._id });
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
