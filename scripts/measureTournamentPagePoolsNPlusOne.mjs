// scripts/measureTournamentPagePoolsNPlusOne.mjs
//
// Root-cause investigation for the Pools+Bracket 700-entrant tournament's
// slow page load (23.8s raw fetch / 29.6s hydrated vs ~10s bracket-only
// baseline). Working theory: the tournament detail page's real GET_TOURNAMENT
// query (app/tournaments/[id]/page.tsx) fetches ALL pools' full bracket +
// matches unconditionally, and the Pool-level field resolvers (Pool.entrants/
// bracket/matches/standings, graphql/resolvers/index.ts) + Bracket.matches
// are NOT covered by the existing DataLoader batching (graphql/loaders.ts) --
// that fix only batched individual-document-by-ID fan-out (Match.player1/
// winner/nextMatch, Entrant.player), not "find all X for this pool/bracket"
// LIST queries, which fire once per pool/bracket with zero batching.
//
// Same methodology as scripts/measureNPlusOne.mjs (real ApolloServer +
// mongoose debug hook, in-process against real production data, not a mock)
// -- extended with an in-memory-only Pool.find mock (no DB writes) to
// empirically test whether the round-trip count scales linearly or
// worse-than-linear with pool count, using the SAME real tournament's real
// pool data at different truncated sizes.
//
// Run: npx tsx scripts/measureTournamentPagePoolsNPlusOne.mjs

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
const { connectToDatabase } = await import("../lib/db.ts");
const { ApolloServer } = await import("@apollo/server");
const { typeDefs } = await import("../graphql/schema/index.ts");
const { resolvers } = await import("../graphql/resolvers/index.ts");
const { createLoaders } = await import("../graphql/loaders.ts");
const { Pool } = await import("../models/Pool.ts");

await connectToDatabase();

const TOURNAMENT_ID = "6a6d10f64991d6d367a265c9";

const MATCH_FIELDS = `
  id round status bracketSide bracketRound bracketPosition
  player1Score player2Score isForfeit
  player1 { id tag } player2 { id tag } winner { id tag }
  nextMatch { id } nextLoserMatch { id } canUndo
`;

// Real query the tournament detail page actually sends -- copied verbatim
// (field-for-field) from app/tournaments/[id]/page.tsx's GET_TOURNAMENT.
const GET_TOURNAMENT = `
  query GetTournament($id: ID!, $playerId: ID) {
    tournament(id: $id) {
      id name game status cancellationReason visibility isRestricted entrantCount
      startDate endDate isEntered(playerId: $playerId) isOrganizer(playerId: $playerId)
      isInvited(playerId: $playerId) streamBackgroundUrl sponsorBannerUrl
      sponsorBannerUrls { url linkUrl } sponsorBannerIntervalSeconds
      bracketLineColor bracketBoxColor bracketFontColor logoUrl isOnlineOnly
      address twitchUrl format capacity entryFee prizePot
      event { id displayId name logoUrl }
      organizers { id tag }
      invitedPlayers { id tag }
      entrants { id seed placement checkedInAt pointsEarned player { id tag avatarUrl characters } }
      bracket { id seedingMethod size matches { ${MATCH_FIELDS} } }
      allPoolsComplete suggestedPoolCount poolModel modelBCurrentRoundComplete
      pools {
        id poolNumber roundNumber isFinalsCutoff
        entrants { id player { id tag avatarUrl } }
        bracket { id seedingMethod size matches { ${MATCH_FIELDS} } }
        matches { ${MATCH_FIELDS} }
        standings { rank matchWins matchLosses gamesWon gamesLost entrant { id player { id tag avatarUrl } } }
      }
      mainBracket { id seedingMethod size seedOrder { id } matches { ${MATCH_FIELDS} } }
    }
    players(limit: 200) { id tag }
  }
`;

let queryCount = 0;
const byCollection = new Map();
mongoose.set("debug", (collectionName, method) => {
  queryCount++;
  const key = `${collectionName}.${method}`;
  byCollection.set(key, (byCollection.get(key) ?? 0) + 1);
});

const server = new ApolloServer({ typeDefs, resolvers });

async function run(label, variables) {
  queryCount = 0;
  byCollection.clear();
  const t0 = Date.now();
  const res = await server.executeOperation(
    { query: GET_TOURNAMENT, variables },
    { contextValue: { loaders: createLoaders() } }
  );
  const ms = Date.now() - t0;
  const errors = res.body.kind === "single" ? res.body.singleResult.errors : undefined;
  if (errors) {
    console.log(`  ${label}: ERRORS ${JSON.stringify(errors.map(e => e.message))}`);
    return null;
  }
  console.log(`  ${label}: ${queryCount} DB queries, ${ms}ms in-process resolver time`);
  console.log(`    by collection.method: ${[...byCollection.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  return { queryCount, ms };
}

console.log("=== Real GET_TOURNAMENT query against the real 85-pool tournament ===");
const real = await run("85 pools (real)", { id: TOURNAMENT_ID });

// ── Empirical scaling-shape check: mock Pool.find to return only the first
// N of the SAME tournament's real pool documents. No DB writes -- purely an
// in-process override of the imported model's own .find method for the
// lifetime of this script, restored immediately after. This exercises the
// exact same resolver code path (Pool.entrants/bracket/matches/standings,
// Bracket.matches) at smaller N to see whether cost grows linearly or worse.
console.log("\n=== Scaling-shape check (same real tournament, mocked pool subsets, no DB writes) ===");
const allRealPools = await Pool.find({ tournamentId: TOURNAMENT_ID }).sort({ poolNumber: 1 });
console.log(`  (${allRealPools.length} real pools available to subset from)`);

function chainable(arr) {
  const p = Promise.resolve(arr);
  p.sort = () => chainable(arr);
  p.select = () => chainable(arr);
  p.lean = () => chainable(arr);
  return p;
}

const originalFind = Pool.find.bind(Pool);
const testCounts = [1, 5, 16, 64, allRealPools.length];
const results = [];
for (const n of testCounts) {
  const subset = allRealPools.slice(0, n);
  Pool.find = filter => {
    if (filter && filter.tournamentId) {
      return chainable(subset);
    }
    return originalFind(filter);
  };
  const r = await run(`${n} pool(s) (mocked subset)`, { id: TOURNAMENT_ID });
  Pool.find = originalFind;
  if (r) results.push({ n, ...r });
}

console.log("\n=== Scaling summary ===");
console.table(results.map(r => ({ pools: r.n, dbQueries: r.queryCount, queriesPerPool: (r.queryCount / r.n).toFixed(2) })));

if (results.length >= 2) {
  const first = results[0];
  const last = results[results.length - 1];
  const ratio = (last.queryCount - first.queryCount) / (last.n - first.n);
  console.log(`\nMarginal DB queries added per additional pool (first->last): ${ratio.toFixed(2)}`);
  console.log(`If this were purely linear, queriesPerPool in the table above should stay roughly constant across all rows.`);
}

process.exit(0);
