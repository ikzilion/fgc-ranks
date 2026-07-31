// Functional verification for the GraphQL depth/field-count limits
// (security sweep, July 31, 2026 — see lib/graphqlLimits.ts).
//
// THE VULNERABILITY: the schema is cyclic (Player.tournaments ->
// Entrant.tournament -> Tournament.entrants -> Entrant.player -> ...) and
// ApolloServer was built with no validationRules at all, so a single
// unauthenticated request could nest that cycle arbitrarily deep, multiplying
// DB work per level. Also covers alias multiplication, which stays shallow
// and so would slip past a depth limit on its own.
//
// The point of this suite is BOTH directions: the attack shapes must be
// rejected, AND the app's own real queries must still be accepted — a limit
// that breaks the site is not a fix. The real query bodies below are lifted
// from the actual pages so this fails loudly if someone later tightens the
// limit past what the app needs.
//
// Requires a server running on localhost:3000.
// Run: npx tsx scripts/testGraphqlQueryLimits.mjs

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function gql(query) {
  const res = await fetch(`${BASE_URL}/api/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return res.json();
}

// Apollo Server rewrites extensions.code on ANY validation-stage error to
// GRAPHQL_VALIDATION_FAILED, so the custom QUERY_TOO_DEEP/QUERY_TOO_LARGE
// codes set in lib/graphqlLimits.ts never survive to the wire. Match on the
// message text instead — that is what actually reaches a caller.
function rejectedTooDeep(json) {
  return (json.errors ?? []).some(e => /too deeply nested/.test(e.message ?? ""));
}
function rejectedTooLarge(json) {
  return (json.errors ?? []).some(e => /too many fields/.test(e.message ?? ""));
}
function rejectedByLimits(json) {
  return rejectedTooDeep(json) || rejectedTooLarge(json);
}
function firstError(json) {
  return json.errors?.[0]?.message ?? "(no error — query was ACCEPTED)";
}

// Builds the recursive amplification query at an arbitrary nesting level.
function nested(levels) {
  let inner = "tag";
  for (let i = 0; i < levels; i++) {
    inner = `tournaments { tournament { entrants { player { ${inner} } } } }`;
  }
  return `{ players(limit: 1) { ${inner} } }`;
}

console.log("\n1. ATTACK — recursive cycle nesting must be rejected");
for (const levels of [3, 5, 10]) {
  const json = await gql(nested(levels));
  check(`${levels}-cycle nest rejected`, rejectedTooDeep(json), firstError(json));
}

console.log("\n2. ATTACK — alias multiplication must be rejected");
{
  const aliases = Array.from({ length: 900 }, (_, i) =>
    `a${i}: players(limit: 100) { id tag points wins losses avatarUrl }`
  ).join("\n");
  const json = await gql(`{ ${aliases} }`);
  check("900-alias bomb rejected", rejectedTooLarge(json), firstError(json));
}

console.log("\n3. ATTACK — fragment-based nesting must not evade the depth check");
{
  // Same amplification, expressed through fragments instead of inline
  // selections — a depth rule that ignores fragment spreads would pass this.
  const q = `
    { players(limit: 1) { ...L1 } }
    fragment L1 on Player { tournaments { tournament { entrants { player { ...L2 } } } } }
    fragment L2 on Player { tournaments { tournament { entrants { player { ...L3 } } } } }
    fragment L3 on Player { tournaments { tournament { entrants { player { tag } } } } }
  `;
  const json = await gql(q);
  check("fragment-spread nesting rejected", rejectedTooDeep(json), firstError(json));
}

console.log("\n4. NO REGRESSION — the app's own real queries must still be accepted");
// Lifted from the real pages. These must never be rejected by the limits.
const realQueries = {
  "players list (app/players/page.tsx shape)":
    `{ playersLeaderboard(page: 1, pageSize: 20) { totalCount players { id tag avatarUrl points wins losses user { id isTO } } } }`,
  "homepage feed shape":
    `{ newsPosts(limit: 20) { id title body createdAt } tournaments(limit: 10) { id name game status startDate } }`,
  "tournament detail (deepest real query, depth 5)":
    `{ tournament(id: "000000000000000000000000") {
         id name game status
         entrants { id placement player { id tag avatarUrl } }
         matches { id round status player1 { tag } player2 { tag } winner { tag } }
         bracket { id size matches { id round bracketSide status player1 { tag } player2 { tag } } }
         pools { id poolNumber entrants { player { tag } } bracket { matches { id round player1 { tag } } } }
       } }`,
  "player profile shape":
    `{ player(id: "000000000000000000000000") { id tag points gameRankings { game points rank } tournaments { id placement tournament { id name game } } } }`,
};
for (const [label, q] of Object.entries(realQueries)) {
  const json = await gql(q);
  check(`accepted: ${label}`, !rejectedByLimits(json), firstError(json));
}

console.log("\n5. Boundary — a query just under the limit still works");
{
  const json = await gql(`{ players(limit: 1) { tournaments { tournament { entrants { player { tag } } } } } }`);
  check("single-cycle nest (depth 6) still accepted", !rejectedByLimits(json), firstError(json));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
