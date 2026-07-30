// Verification for the new server-side paginated + searched Players
// leaderboard (playersLeaderboard GraphQL query). Runs real GraphQL queries
// against the live dev server + real MongoDB data (no seeding needed -- this
// checks pagination/search correctness against whatever players already
// exist), confirming:
//   1. Paging: page 1 and page 2 return non-overlapping players, correct
//      page lengths, and totalCount matches a direct Player.countDocuments.
//   2. Search: a real player's tag prefix matches, case-insensitively;
//      a MID-string substring that would have matched the OLD client-side
//      "contains anywhere" search does NOT match anymore (the deliberate,
//      disclosed prefix-only behavior change); a broader prefix match
//      (e.g. "Sim" -> many SimPlayerNN test accounts) also paginates
//      correctly with no overlap between its own page 1 and page 2.
//
// Requires `npm run dev` already running on localhost:3000.
// Run: npx tsx scripts/testPlayersLeaderboardPagination.mjs

import fs from "fs";
import path from "path";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

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

const { connectToDatabase } = await import("../lib/db");
const { Player } = await import("../models/Player");

const QUERY = `
  query PlayersLeaderboard($page: Int, $pageSize: Int, $search: String) {
    playersLeaderboard(page: $page, pageSize: $pageSize, search: $search) {
      totalCount
      players { id tag rankingPoints: points }
    }
  }
`;

async function fetchPage(page, pageSize, search) {
  const res = await fetch(`${BASE_URL}/api/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { page, pageSize, search } }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data.playersLeaderboard;
}

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
  const realTotal = await Player.countDocuments({ isDeleted: { $ne: true } });

  console.log("\n=== Pagination (no search) ===");
  const page1 = await fetchPage(1, 20, undefined);
  const page2 = await fetchPage(2, 20, undefined);

  assert(page1.totalCount === realTotal, `totalCount (${page1.totalCount}) matches a direct Player.countDocuments (${realTotal})`);
  assert(page1.players.length === Math.min(20, realTotal), `page 1 returns ${Math.min(20, realTotal)} players (got ${page1.players.length})`);
  assert(page2.players.length === Math.min(20, Math.max(0, realTotal - 20)), `page 2 returns the expected remainder (got ${page2.players.length})`);

  const page1Ids = new Set(page1.players.map(p => p.id));
  const overlap = page2.players.filter(p => page1Ids.has(p.id));
  assert(overlap.length === 0, `page 1 and page 2 have zero overlapping players (found ${overlap.length} overlapping)`);

  console.log("\n=== Search: real prefix match, case-insensitive ===");
  const exact = await fetchPage(1, 20, "Jotaro");
  assert(
    exact.players.some(p => p.tag === "JotaroStarPlatinum"),
    `search "Jotaro" matches JotaroStarPlatinum (found: ${exact.players.map(p => p.tag).join(", ")})`
  );
  const lower = await fetchPage(1, 20, "jotaro");
  assert(
    lower.players.some(p => p.tag === "JotaroStarPlatinum"),
    `search "jotaro" (lowercase) still matches case-insensitively`
  );

  console.log("\n=== Search: prefix-only semantics (deliberate behavior change) ===");
  const midSubstring = await fetchPage(1, 20, "Star"); // mid-string in "JotaroStarPlatinum"
  assert(
    !midSubstring.players.some(p => p.tag === "JotaroStarPlatinum"),
    `search "Star" does NOT match JotaroStarPlatinum -- prefix-only, not the old "contains anywhere" behavior (found: ${midSubstring.players.map(p => p.tag).join(", ") || "none"})`
  );

  const noMatch = await fetchPage(1, 20, "zzz_definitely_no_such_tag_zzz");
  assert(noMatch.players.length === 0 && noMatch.totalCount === 0, `a genuinely non-matching search returns 0 players and totalCount 0`);

  console.log("\n=== Search pagination: a broader-matching prefix ===");
  const simTotal = await Player.countDocuments({ isDeleted: { $ne: true }, tag: { $regex: "^Sim" } });
  if (simTotal >= 3) {
    const simPage1 = await fetchPage(1, 2, "Sim");
    const simPage2 = await fetchPage(2, 2, "Sim");
    assert(simPage1.totalCount === simTotal, `"Sim" search totalCount (${simPage1.totalCount}) matches a direct count (${simTotal})`);
    const simPage1Ids = new Set(simPage1.players.map(p => p.id));
    const simOverlap = simPage2.players.filter(p => simPage1Ids.has(p.id));
    assert(simOverlap.length === 0, `"Sim" search page 1 and page 2 have zero overlap (found ${simOverlap.length})`);
    assert(
      simPage1.players.every(p => p.tag.toLowerCase().startsWith("sim")) && simPage2.players.every(p => p.tag.toLowerCase().startsWith("sim")),
      `every returned player across both "Sim" pages actually starts with "sim"`
    );
  } else {
    console.log(`  SKIP (only ${simTotal} "Sim*" players in this dataset, not enough to test 2 pages of size 2)`);
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
