// Functional verification for the User-PII field gating (security sweep,
// July 31, 2026).
//
// THE VULNERABILITY THIS PROVES CLOSED: `Player.user` had no authorization
// check, and `type User` exposed `email: String!` / `role: UserRole!`. Since
// Query.players/player/playerByTag are all fully public, a single
// UNAUTHENTICATED request —
//     { players(limit: 100000) { tag user { email role } } }
// — returned every registered account's email address and role, including
// flagging which address held SUPER_ADMIN. Query.players' `limit` was also
// uncapped, so it was one request, not a paginated grind.
//
// Verification strategy: the security property is "which session context may
// read which field", so the field resolvers are invoked DIRECTLY with each of
// the five real contexts (anonymous / owner / other player / ADMIN /
// SUPER_ADMIN) — that exercises the actual gate rather than a mock of it.
// A real end-to-end HTTP query against the running dev server then proves
// the gate is genuinely wired into the live GraphQL path, not just present
// in the module. Test 0 asserts the underlying data really is present in the
// documents, so the null results below are proven to be the GATE working
// rather than the fixture being empty (i.e. it reproduces the leak first).
//
// Requires `npm run dev` already running on localhost:3000.
// Run: npx tsx scripts/testUserPiiFieldGating.mjs

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
const { User } = await import("../models/User");
const { Player } = await import("../models/Player");
const { resolvers } = await import("../graphql/resolvers/index");

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const STAMP = Date.now();
const VICTIM_EMAIL = `pii-victim-${STAMP}@example.com`;
const SNOOP_EMAIL = `pii-snoop-${STAMP}@example.com`;

await connectToDatabase();

// ---------------------------------------------------------------- fixtures
// A "victim" account whose PII the gate must protect, and a "snooper"
// account standing in for any ordinary logged-in attacker.
const victimUser = await User.create({
  email: VICTIM_EMAIL,
  passwordHash: "x".repeat(60),
  role: "PLAYER",
  emailVerified: true,
  scrubBackupEmail: `backup-${VICTIM_EMAIL}`,
});
const victimPlayer = await Player.create({ tag: `PiiVictim${STAMP}`, userId: victimUser._id });
await User.findByIdAndUpdate(victimUser._id, { playerId: victimPlayer._id });

const snoopUser = await User.create({
  email: SNOOP_EMAIL,
  passwordHash: "x".repeat(60),
  role: "PLAYER",
  emailVerified: true,
});

const victimDoc = await User.findById(victimUser._id);

const ANON = {};
const OWNER = { userId: String(victimUser._id), role: "PLAYER" };
const OTHER_PLAYER = { userId: String(snoopUser._id), role: "PLAYER" };
const ADMIN = { userId: String(snoopUser._id), role: "ADMIN" };
const SUPER_ADMIN = { userId: String(snoopUser._id), role: "SUPER_ADMIN" };

const U = resolvers.User;

try {
  // -- 0. Reproduce the leak: the data really is sitting in the document,
  //       so every null below is the GATE working, not an empty fixture.
  console.log("\n0. Pre-condition — the PII is genuinely present (old resolver returned this raw)");
  check("victim document really holds the email", victimDoc.email === VICTIM_EMAIL, `got ${victimDoc.email}`);
  check("victim document really holds the role", victimDoc.role === "PLAYER");
  check(
    "victim document really holds scrubBackupEmail",
    victimDoc.scrubBackupEmail === `backup-${VICTIM_EMAIL}`
  );

  // -- 1. Anonymous: the actual vulnerability.
  console.log("\n1. ANONYMOUS caller (the reported vulnerability) — must get null");
  check("email is null", U.email(victimDoc, {}, ANON) === null, `got ${U.email(victimDoc, {}, ANON)}`);
  check("role is null", U.role(victimDoc, {}, ANON) === null, `got ${U.role(victimDoc, {}, ANON)}`);
  check("createdAt is null", U.createdAt(victimDoc, {}, ANON) === null);
  check("scheduledScrubAt is null", U.scheduledScrubAt(victimDoc, {}, ANON) === null);
  check("scrubBackupEmail is null", U.scrubBackupEmail(victimDoc, {}, ANON) === null);
  check("scrubBackupExpiresAt is null", U.scrubBackupExpiresAt(victimDoc, {}, ANON) === null);

  // -- 2. A different logged-in player must not read someone else's PII.
  console.log("\n2. OTHER logged-in player — must get null (not just anonymous is blocked)");
  check("email is null", U.email(victimDoc, {}, OTHER_PLAYER) === null);
  check("role is null", U.role(victimDoc, {}, OTHER_PLAYER) === null);
  check("scrubBackupEmail is null", U.scrubBackupEmail(victimDoc, {}, OTHER_PLAYER) === null);

  // -- 3. No functional regression for the legitimate readers.
  console.log("\n3. OWNER — must still read their own PII");
  check("email is the real address", U.email(victimDoc, {}, OWNER) === VICTIM_EMAIL);
  check("role is the real role", U.role(victimDoc, {}, OWNER) === "PLAYER");
  check("createdAt is present", U.createdAt(victimDoc, {}, OWNER) != null);

  console.log("\n4. ADMIN / SUPER_ADMIN — must still read other users' PII (admin dashboards)");
  check("ADMIN reads email", U.email(victimDoc, {}, ADMIN) === VICTIM_EMAIL);
  check("ADMIN reads role", U.role(victimDoc, {}, ADMIN) === "PLAYER");
  check("ADMIN reads scrubBackupEmail", U.scrubBackupEmail(victimDoc, {}, ADMIN) === `backup-${VICTIM_EMAIL}`);
  check("SUPER_ADMIN reads email", U.email(victimDoc, {}, SUPER_ADMIN) === VICTIM_EMAIL);

  // -- 5. Public fields must stay public or the TO badge breaks.
  console.log("\n5. Public fields — must stay readable anonymously (TO badge regression guard)");
  check("isTO readable anonymously", U.isTO({ isTO: true }, {}, ANON) === true);
  check("isTO defaults false for legacy docs", U.isTO({}, {}, ANON) === false);

  // -- 5b. Player.scrubBackupTag — the deleted-account leak found in the same
  //        sweep. The scrub deliberately overwrites `tag` with
  //        "deleted-user-xxxx"; this field held the REAL original tag next to
  //        it and had no resolver at all, so it came back to anyone.
  console.log("\n5b. Player.scrubBackupTag (soft-deleted account's real identity)");
  const scrubbed = await Player.create({
    tag: `deleted-user-${STAMP}`,
    isDeleted: true,
    deletedAt: new Date(),
    scrubBackupTag: "RealPersonOriginalTag",
  });
  const scrubbedDoc = await Player.findById(scrubbed._id);
  const P = resolvers.Player;
  check("data really is present in the document", scrubbedDoc.scrubBackupTag === "RealPersonOriginalTag");
  check("anonymous gets null", P.scrubBackupTag(scrubbedDoc, {}, ANON) === null);
  check("ordinary logged-in player gets null", P.scrubBackupTag(scrubbedDoc, {}, OTHER_PLAYER) === null);
  check("ADMIN still reads it (restore tool)", P.scrubBackupTag(scrubbedDoc, {}, ADMIN) === "RealPersonOriginalTag");
  check("SUPER_ADMIN still reads it", P.scrubBackupTag(scrubbedDoc, {}, SUPER_ADMIN) === "RealPersonOriginalTag");
  {
    const res = await fetch(`${BASE_URL}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: `{ player(id:"${scrubbed._id}") { tag isDeleted scrubBackupTag } }` }),
    });
    const j = await res.json();
    check("real unauthenticated HTTP gets null", j?.data?.player?.scrubBackupTag === null, JSON.stringify(j?.data));
    check("scrubbed placeholder tag still returned", (j?.data?.player?.tag ?? "").startsWith("deleted-user-"));
  }
  await Player.findByIdAndDelete(scrubbed._id);

  // -- 6. Query.players limit cap.
  console.log("\n6. Query.players limit cap");
  const anonPage = await resolvers.Query.players(null, { limit: 100000, offset: 0 }, ANON);
  check("anonymous limit clamped to <= 100", anonPage.length <= 100, `got ${anonPage.length}`);
  const adminPage = await resolvers.Query.players(null, { limit: 100000, offset: 0 }, ADMIN);
  check("admin limit clamped to <= 500", adminPage.length <= 500, `got ${adminPage.length}`);
  check(
    "admin ceiling is higher than anonymous (admin/users needs limit:200)",
    adminPage.length >= anonPage.length
  );
  const negative = await resolvers.Query.players(null, { limit: -5, offset: -10 }, ANON);
  check("negative limit/offset does not throw or return everything", negative.length >= 0 && negative.length <= 100);

  // -- 7. Real end-to-end HTTP, proving the gate is wired into the live path.
  console.log("\n7. Real unauthenticated HTTP request against the running server");
  let httpOk = true;
  let body;
  try {
    const res = await fetch(`${BASE_URL}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "{ players(limit: 100000) { tag user { id isTO email role } } }",
      }),
    });
    body = await res.json();
  } catch (err) {
    httpOk = false;
    console.log(`  SKIP  dev server not reachable at ${BASE_URL} (${err.message})`);
  }

  if (httpOk) {
    check("query succeeds (nullable fields, so no non-null error)", !body.errors, JSON.stringify(body.errors));
    const rows = body?.data?.players ?? [];
    check("returned some players", rows.length > 0, `got ${rows.length}`);
    check("page size clamped to <= 100 over real HTTP", rows.length <= 100, `got ${rows.length}`);
    const withUser = rows.filter(r => r.user);
    check("every returned email is null", withUser.every(r => r.user.email === null));
    check("every returned role is null", withUser.every(r => r.user.role === null));
    check("user.id still resolves (public)", withUser.every(r => typeof r.user.id === "string"));
    check("user.isTO still resolves (public, TO badge)", withUser.every(r => typeof r.user.isTO === "boolean"));
    const leaked = withUser.filter(r => r.user.email || r.user.role).length;
    check("ZERO records leaked email or role", leaked === 0, `${leaked} leaked`);
  }
} finally {
  // ------------------------------------------------------------- cleanup
  await Player.findByIdAndDelete(victimPlayer._id);
  await User.findByIdAndDelete(victimUser._id);
  await User.findByIdAndDelete(snoopUser._id);
  const leftover = await User.countDocuments({ email: { $in: [VICTIM_EMAIL, SNOOP_EMAIL] } });
  check("\ncleanup: test fixtures removed", leftover === 0, `${leftover} left`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
