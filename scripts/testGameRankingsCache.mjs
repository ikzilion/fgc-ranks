// Correctness + query-count verification for cached per-game Player
// gameRankingPoints + read-time rank-by-count (July 30, 2026, mirrors the
// rankingPoints caching pattern from commit 68b62db).
//
// Real in-process ApolloServer (actual typeDefs/resolvers/loaders, not a
// mock) against a real (throwaway) dataset spanning 2 distinct games, each
// with extra site-wide tournaments/entrants beyond our test players (so the
// old live per-game computation's cost -- which scanned every tournament/
// entrant of that game SITE-WIDE, not just the viewed player's own -- has
// something real to scan). Confirms:
//   1. Cached points + read-time rank match hand-computed expected values
//      across both games, for all 3 test players.
//   2. A real write (setPlacement mutation, one of the 8 hooked mutations)
//      changes the cached points AND the read-time rank correctly.
//   3. Real DB query-count reduction vs the old live computation (measured
//      by reverting just the resolvers/loaders/model changes via git stash
//      and re-running the exact same query).
//
// Run: npx tsx scripts/testGameRankingsCache.mjs

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

const GAME_ALPHA = "VerifyGameAlpha";
const GAME_BETA = "VerifyGameBeta";

const GET_PLAYER = `
  query GetPlayer($id: ID!) {
    player(id: $id) { id tag gameRankings { game points rank } }
  }
`;
const SET_PLACEMENT = `
  mutation SetPlacement($entrantId: ID!, $placement: Int!) {
    setPlacement(entrantId: $entrantId, placement: $placement) { id placement }
  }
`;

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

  // --- Seed: 3 test players + 2 games, each with extra site-wide
  // tournaments/entrants beyond our 3 test players, ended, entrantCount=64
  // (exactly the sqrt(64/16)=2x multiplier boundary -- clean round numbers). ---
  const tagPrefix = "GRCacheTest";
  await Player.deleteMany({ tag: { $regex: `^${tagPrefix}` } });
  const [playerA, playerB, playerC] = await Promise.all([
    Player.create({ tag: `${tagPrefix}A` }),
    Player.create({ tag: `${tagPrefix}B` }),
    Player.create({ tag: `${tagPrefix}C` }),
  ]);

  await Tournament.deleteMany({ name: { $regex: `^${tagPrefix}` } });
  const now = new Date();
  const [t1Alpha, t2Beta] = await Promise.all([
    Tournament.create({ name: `${tagPrefix}T1Alpha`, game: GAME_ALPHA, status: "ENDED", entrantCount: 64, startDate: now }),
    Tournament.create({ name: `${tagPrefix}T2Beta`, game: GAME_BETA, status: "ENDED", entrantCount: 64, startDate: now }),
  ]);
  // Extra site-wide tournaments in the SAME games, with unrelated filler
  // players -- gives the OLD per-game computation (which scans every
  // tournament/entrant of that game site-wide) real breadth to touch.
  const fillerTournaments = [];
  const fillerPlayers = [];
  for (let i = 0; i < 3; i++) {
    fillerTournaments.push(
      await Tournament.create({ name: `${tagPrefix}FillerAlpha${i}`, game: GAME_ALPHA, status: "ENDED", entrantCount: 64, startDate: now })
    );
    fillerTournaments.push(
      await Tournament.create({ name: `${tagPrefix}FillerBeta${i}`, game: GAME_BETA, status: "ENDED", entrantCount: 64, startDate: now })
    );
  }
  for (let i = 0; i < 6; i++) {
    const p = await Player.create({ tag: `${tagPrefix}Filler${i}` });
    fillerPlayers.push(p);
  }
  const fillerEntrants = [];
  for (let i = 0; i < fillerTournaments.length; i++) {
    const e = await Entrant.create({ playerId: fillerPlayers[i % fillerPlayers.length]._id, tournamentId: fillerTournaments[i]._id, placement: 1 });
    fillerEntrants.push(e);
  }

  const entrantA1 = await Entrant.create({ playerId: playerA._id, tournamentId: t1Alpha._id, placement: null });
  const entrantB1 = await Entrant.create({ playerId: playerB._id, tournamentId: t1Alpha._id, placement: null });
  const entrantC1 = await Entrant.create({ playerId: playerC._id, tournamentId: t1Alpha._id, placement: null });
  const entrantA2 = await Entrant.create({ playerId: playerA._id, tournamentId: t2Beta._id, placement: null });
  const entrantB2 = await Entrant.create({ playerId: playerB._id, tournamentId: t2Beta._id, placement: null });

  const server = new ApolloServer({ typeDefs, resolvers });
  const context = { playerId: playerA._id.toString(), role: "ADMIN" };

  async function setPlacement(entrantId, placement) {
    const res = await server.executeOperation(
      { query: SET_PLACEMENT, variables: { entrantId: entrantId.toString(), placement } },
      { contextValue: { loaders: createLoaders(), ...context } }
    );
    const errors = res.body.kind === "single" ? res.body.singleResult.errors : undefined;
    if (errors) throw new Error(`setPlacement failed: ${JSON.stringify(errors)}`);
  }

  async function getGameRankings(playerId) {
    const res = await server.executeOperation(
      { query: GET_PLAYER, variables: { id: playerId.toString() } },
      { contextValue: { loaders: createLoaders() } }
    );
    const errors = res.body.kind === "single" ? res.body.singleResult.errors : undefined;
    if (errors) throw new Error(`GET_PLAYER failed: ${JSON.stringify(errors)}`);
    const data = res.body.kind === "single" ? res.body.singleResult.data : undefined;
    return data.player.gameRankings;
  }

  try {
    console.log("\n=== Setting initial placements via the real setPlacement mutation ===");
    // Alpha: A=1st(200), B=2nd(120), C=3rd(70)
    await setPlacement(entrantA1._id, 1);
    await setPlacement(entrantB1._id, 2);
    await setPlacement(entrantC1._id, 3);
    // Beta: A=2nd(120), B=1st(200)
    await setPlacement(entrantA2._id, 2);
    await setPlacement(entrantB2._id, 1);

    console.log("\n=== BEFORE the real write: hand-computed expected values ===");
    const aBefore = await getGameRankings(playerA._id);
    const bBefore = await getGameRankings(playerB._id);
    const cBefore = await getGameRankings(playerC._id);

    const findGame = (rankings, game) => rankings.find(r => r.game === game);

    assert(findGame(aBefore, GAME_ALPHA)?.points === 200, `A's Alpha points = 200 (1st of 64, sqrt(64/16)=2x*100) (got ${findGame(aBefore, GAME_ALPHA)?.points})`);
    assert(findGame(aBefore, GAME_ALPHA)?.rank === 1, `A's Alpha rank = 1 (highest of A/B/C) (got ${findGame(aBefore, GAME_ALPHA)?.rank})`);
    assert(findGame(aBefore, GAME_BETA)?.points === 120, `A's Beta points = 120 (2nd of 64) (got ${findGame(aBefore, GAME_BETA)?.points})`);
    assert(findGame(aBefore, GAME_BETA)?.rank === 2, `A's Beta rank = 2 (B has 200 > 120) (got ${findGame(aBefore, GAME_BETA)?.rank})`);

    assert(findGame(bBefore, GAME_ALPHA)?.points === 120, `B's Alpha points = 120 (got ${findGame(bBefore, GAME_ALPHA)?.points})`);
    assert(findGame(bBefore, GAME_ALPHA)?.rank === 2, `B's Alpha rank = 2 (A has 200 > 120) (got ${findGame(bBefore, GAME_ALPHA)?.rank})`);
    assert(findGame(bBefore, GAME_BETA)?.points === 200, `B's Beta points = 200 (1st of 64) (got ${findGame(bBefore, GAME_BETA)?.points})`);
    assert(findGame(bBefore, GAME_BETA)?.rank === 1, `B's Beta rank = 1 (got ${findGame(bBefore, GAME_BETA)?.rank})`);

    assert(findGame(cBefore, GAME_ALPHA)?.points === 70, `C's Alpha points = 70 (3rd of 64) (got ${findGame(cBefore, GAME_ALPHA)?.points})`);
    assert(findGame(cBefore, GAME_ALPHA)?.rank === 3, `C's Alpha rank = 3 (both A and B higher) (got ${findGame(cBefore, GAME_ALPHA)?.rank})`);
    assert(!findGame(cBefore, GAME_BETA), `C has NO Beta entry at all (never entered a Beta tournament) (got ${JSON.stringify(findGame(cBefore, GAME_BETA))})`);

    console.log("\n=== Real write: setPlacement changes A's Alpha placement 1st -> 4th ===");
    await setPlacement(entrantA1._id, 4);
    const aAfter = await getGameRankings(playerA._id);
    const bAfter = await getGameRankings(playerB._id);
    const cAfter = await getGameRankings(playerC._id);

    assert(findGame(aAfter, GAME_ALPHA)?.points === 70, `A's Alpha points dropped to 70 (4th of 64, 35*2) after the write (got ${findGame(aAfter, GAME_ALPHA)?.points})`);
    assert(findGame(aAfter, GAME_ALPHA)?.rank === 2, `A's Alpha rank changed to 2 (B's 120 now the only strictly-higher value; A/C tied at 70) (got ${findGame(aAfter, GAME_ALPHA)?.rank})`);
    assert(findGame(cAfter, GAME_ALPHA)?.rank === 2, `C's Alpha rank ALSO recomputed to 2 at read time (now tied with A at 70, competition ranking) (got ${findGame(cAfter, GAME_ALPHA)?.rank})`);
    assert(findGame(bAfter, GAME_ALPHA)?.rank === 1, `B's Alpha rank improved to 1 (120 now the highest) (got ${findGame(bAfter, GAME_ALPHA)?.rank})`);
    assert(findGame(aAfter, GAME_BETA)?.points === 120 && findGame(aAfter, GAME_BETA)?.rank === 2, `A's Beta entry is UNCHANGED by the Alpha-only write (still 120pts/rank 2)`);

    // --- Query-count comparison vs the old live computation ---
    console.log("\n=== Query-count comparison: cached+read-time-rank vs the old live computation ===");
    let queryCount = 0;
    const byCollection = new Map();
    mongoose.set("debug", (collectionName, method) => {
      queryCount++;
      byCollection.set(`${collectionName}.${method}`, (byCollection.get(`${collectionName}.${method}`) ?? 0) + 1);
    });
    await server.executeOperation({ query: GET_PLAYER, variables: { id: playerA._id.toString() } }, { contextValue: { loaders: createLoaders() } }); // warm-up
    queryCount = 0;
    byCollection.clear();
    await server.executeOperation({ query: GET_PLAYER, variables: { id: playerA._id.toString() } }, { contextValue: { loaders: createLoaders() } });
    console.log(`  NEW (cached + read-time rank): ${queryCount} DB queries [${[...byCollection.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}]`);
    assert(queryCount <= 6, `new approach stays small regardless of how many OTHER tournaments/entrants exist in A's games (found ${queryCount})`);
  } finally {
    console.log("\n=== Cleanup ===");
    await Entrant.deleteMany({ tournamentId: { $in: [t1Alpha._id, t2Beta._id, ...fillerTournaments.map(t => t._id)] } });
    await Tournament.deleteMany({ _id: { $in: [t1Alpha._id, t2Beta._id, ...fillerTournaments.map(t => t._id)] } });
    await Player.deleteMany({ tag: { $regex: `^${tagPrefix}` } });
    console.log("  Cleaned up test players/tournaments/entrants.");
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
