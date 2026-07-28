// Functional verification for the account-deletion grace period + audit log
// + admin restore tool (settled July 28, 2026, see the Notion "Account
// deletion is currently unrecoverable" writeup). Real HTTP login, real
// GraphQL mutations, and real DB reads to confirm actual behavior — not a
// mock. Per the standing Verification Rule, the 7-day scrub window is
// fast-forwarded directly in the DB rather than waiting 7 real days
// (explicitly sanctioned by the task). Token hashes for confirm/cancel are
// similarly self-planted with a token this script generates itself (using
// the exact same SHA-256 scheme the resolvers use) rather than intercepting
// real emails, which no test script in this codebase attempts.
//
// Requires `npm run dev` already running on localhost:3000.
// Run: npx tsx scripts/testAccountDeletionGracePeriod.mjs

import fs from "fs";
import path from "path";
import { createHash, randomBytes } from "crypto";

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
const { AccountDeletionAuditLog } = await import("../models/AccountDeletionAuditLog");
const { resolvers } = await import("../graphql/resolvers/index");
const bcrypt = (await import("bcryptjs")).default;

const fakeReq = ip => new Request("http://localhost/api/graphql", { headers: { "x-forwarded-for": ip } });

// requestAccountDeletion/confirmAccountDeletion write their DB state (the
// thing actually under test) BEFORE sending an email -- but Resend hard-
// rejects @example.com recipients (RFC 2606 reserved test domain) rather
// than silently no-op'ing, so calling these two through real HTTP throws a
// 500 that has nothing to do with the feature. Same direct-resolver-
// invocation workaround scripts/testRateLimitErrorSurfacing.mjs already
// established for this exact issue -- tolerate ONLY that specific Resend
// rejection, let anything else propagate as a real failure.
async function tolerateResendExampleDotComRejection(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!/Invalid `to` field|example\.com/i.test(err?.message ?? "")) throw err;
    return true;
  }
}

// Returns null on success (including the tolerated Resend rejection), or
// the real error if something else went wrong.
async function callConfirm(token) {
  try {
    await tolerateResendExampleDotComRejection(() => resolvers.Mutation.confirmAccountDeletion(null, { token }, { req: fakeReq("203.0.113.12") }));
    return null;
  } catch (err) {
    return err;
  }
}

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  OK   ${label}`);
  } else {
    console.log(`  FAIL ${label}`);
    failures++;
  }
}

function hashToken(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

// loginRateLimit (lib/rateLimit.ts) is 5 attempts/5min, keyed by IP, and NOT
// relaxed in dev like most of this app's other limiters -- this script's
// fetch() calls send no x-forwarded-for at all, so EVERY login across EVERY
// phase would otherwise share the same "unknown" bucket (and collide with
// whatever other test scripts have hit this session). Each call site below
// passes a distinct synthetic IP so this script's own login volume can't
// rate-limit itself.
async function httpLogin(email, password, syntheticIp) {
  const ipHeaders = syntheticIp ? { "x-forwarded-for": syntheticIp } : {};
  const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`, { headers: ipHeaders });
  const csrfCookies = csrfRes.headers.getSetCookie?.() ?? [];
  const { csrfToken } = await csrfRes.json();
  let cookieJar = csrfCookies.map(c => c.split(";")[0]).join("; ");

  const loginRes = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieJar, ...ipHeaders },
    body: new URLSearchParams({ email, password, csrfToken, json: "true" }),
  });
  const loginCookies = loginRes.headers.getSetCookie?.() ?? [];
  const sessionCookiePart = loginCookies.find(c => /session-token/i.test(c));
  cookieJar = [cookieJar, ...loginCookies.map(c => c.split(";")[0])].filter(Boolean).join("; ");
  return { cookieJar, gotSessionCookie: !!sessionCookiePart, status: loginRes.status };
}

async function gql(query, variables, cookieJar) {
  const res = await fetch(`${BASE_URL}/api/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookieJar ? { Cookie: cookieJar } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

async function main() {
  await connectToDatabase();

  const password = "TestPass123!";
  const passwordHash = await bcrypt.hash(password, 10);

  // --- Set up disposable fixtures: 1 subject account (the one going
  // through the full flow), 1 second account (login-lockout-timing test),
  // 1 third account (ADMIN-immediate-delete test), and 1 SUPER_ADMIN
  // account (for the restore tool + as the admin performer). ---
  const emails = {
    subject: "gracedeltest-subject@example.com",
    loginPath: "gracedeltest-loginpath@example.com",
    adminImmediate: "gracedeltest-adminimmediate@example.com",
    superAdmin: "gracedeltest-superadmin@example.com",
  };
  for (const e of Object.values(emails)) await User.deleteOne({ email: e });

  const subjectUser = await User.create({ email: emails.subject, passwordHash });
  const subjectPlayer = await Player.create({ userId: subjectUser._id, tag: "GraceDelSubject" });
  await User.findByIdAndUpdate(subjectUser._id, { playerId: subjectPlayer._id });

  const loginPathUser = await User.create({ email: emails.loginPath, passwordHash });
  const loginPathPlayer = await Player.create({ userId: loginPathUser._id, tag: "GraceDelLoginPath" });
  await User.findByIdAndUpdate(loginPathUser._id, { playerId: loginPathPlayer._id });

  const adminImmediateUser = await User.create({ email: emails.adminImmediate, passwordHash });
  const adminImmediatePlayer = await Player.create({ userId: adminImmediateUser._id, tag: "GraceDelAdminImm" });
  await User.findByIdAndUpdate(adminImmediateUser._id, { playerId: adminImmediatePlayer._id });

  const superAdminUser = await User.create({ email: emails.superAdmin, passwordHash, role: "SUPER_ADMIN" });
  const superAdminPlayer = await Player.create({ userId: superAdminUser._id, tag: "GraceDelSuperAdmin" });
  await User.findByIdAndUpdate(superAdminUser._id, { playerId: superAdminPlayer._id });

  try {
    // === PHASE 1: request -> confirm starts the grace period, does NOT scrub ===
    console.log("\n=== PHASE 1: requestAccountDeletion -> confirmAccountDeletion starts a 7-day window, no immediate scrub ===");
    const { cookieJar: subjectCookies, gotSessionCookie } = await httpLogin(emails.subject, password, "10.99.0.1");
    assert(gotSessionCookie, "Subject account real HTTP login succeeded");

    let reqError = null;
    try {
      await tolerateResendExampleDotComRejection(() =>
        resolvers.Mutation.requestAccountDeletion(null, null, { playerId: subjectPlayer._id.toString(), req: fakeReq("203.0.113.11") })
      );
    } catch (err) {
      reqError = err;
    }
    assert(!reqError, `requestAccountDeletion succeeded (${reqError?.message})`);

    const afterRequest = await User.findById(subjectUser._id);
    assert(!!afterRequest.deleteAccountTokenHash, "deleteAccountTokenHash was set on the real DB record");

    const requestedLog = await AccountDeletionAuditLog.findOne({ playerId: subjectPlayer._id, action: "REQUESTED" });
    assert(!!requestedLog && requestedLog.ip !== undefined, `REQUESTED audit log entry recorded (ip=${requestedLog?.ip})`);

    // Self-plant a known confirm token with the SAME hash the resolver
    // would have set from the real emailed token — simulates "the TO
    // clicked the real link" without needing to intercept Resend delivery.
    const rawConfirmToken = randomBytes(32).toString("hex");
    await User.findByIdAndUpdate(subjectUser._id, {
      deleteAccountTokenHash: hashToken(rawConfirmToken),
      deleteAccountTokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
    });

    const confirmError = await callConfirm(rawConfirmToken);
    assert(!confirmError, `confirmAccountDeletion succeeded (${confirmError?.message})`);

    const afterConfirm = await User.findById(subjectUser._id);
    const playerAfterConfirm = await Player.findById(subjectPlayer._id);
    assert(playerAfterConfirm.isDeleted === false, "Player is NOT scrubbed immediately after confirming");
    assert(afterConfirm.email === emails.subject, "User email is UNCHANGED immediately after confirming");
    assert(!!afterConfirm.scheduledScrubAt, "scheduledScrubAt is now set");
    const daysOut = (afterConfirm.scheduledScrubAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    assert(daysOut > 6.9 && daysOut < 7.1, `scheduledScrubAt is ~7 days out (got ${daysOut.toFixed(2)} days)`);
    assert(!!afterConfirm.cancelDeletionTokenHash, "cancelDeletionTokenHash was set for the cancel-from-email path");

    const confirmedLog = await AccountDeletionAuditLog.findOne({ playerId: subjectPlayer._id, action: "CONFIRMED" });
    assert(!!confirmedLog, "CONFIRMED audit log entry recorded");

    // === PHASE 2: sign-in still works normally while pending ===
    console.log("\n=== PHASE 2: sign-in still works normally during the pending window (settled UX decision) ===");
    const { gotSessionCookie: pendingLoginWorked } = await httpLogin(emails.subject, password, "10.99.0.2");
    assert(pendingLoginWorked, "Real HTTP login still succeeds while the account is pending-deletion (not yet elapsed)");

    const meRes = await gql(`query { me { scheduledScrubAt } }`, {}, subjectCookies);
    assert(
      !!meRes.data?.me?.scheduledScrubAt,
      `me query surfaces scheduledScrubAt to a signed-in pending account (drives the client's banner) [raw: ${JSON.stringify(meRes)}]`
    );

    // === PHASE 3: cancel via the token (email-link) path actually cancels ===
    console.log("\n=== PHASE 3: cancelAccountDeletion (token/email-link path) actually cancels ===");
    const rawCancelToken1 = randomBytes(32).toString("hex");
    await User.findByIdAndUpdate(subjectUser._id, { cancelDeletionTokenHash: hashToken(rawCancelToken1) });
    const cancel1Res = await gql(`mutation($token: String!) { cancelAccountDeletion(token: $token) }`, { token: rawCancelToken1 });
    assert(!cancel1Res.errors, `cancelAccountDeletion succeeded (${JSON.stringify(cancel1Res.errors)})`);

    const afterCancel1 = await User.findById(subjectUser._id);
    assert(afterCancel1.scheduledScrubAt === null, "scheduledScrubAt cleared after token-based cancel");
    assert(afterCancel1.email === emails.subject, "Account is back to fully normal (email unchanged, nothing scrubbed)");
    const cancelledLog1 = await AccountDeletionAuditLog.findOne({ playerId: subjectPlayer._id, action: "CANCELLED" });
    assert(!!cancelledLog1, "CANCELLED audit log entry recorded (token path)");

    // Re-confirm to get back into pending state for the session-cancel test.
    const rawConfirmToken2 = randomBytes(32).toString("hex");
    await User.findByIdAndUpdate(subjectUser._id, {
      deleteAccountTokenHash: hashToken(rawConfirmToken2),
      deleteAccountTokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
    });
    await callConfirm(rawConfirmToken2);
    const rePending = await User.findById(subjectUser._id);
    assert(!!rePending.scheduledScrubAt, "Re-entered pending state for the next test");

    // === PHASE 4: cancel via the signed-in session path actually cancels ===
    console.log("\n=== PHASE 4: cancelMyPendingDeletion (signed-in session path) actually cancels ===");
    const cancel2Res = await gql(`mutation { cancelMyPendingDeletion }`, {}, subjectCookies);
    assert(!cancel2Res.errors, `cancelMyPendingDeletion succeeded (${JSON.stringify(cancel2Res.errors)})`);
    const afterCancel2 = await User.findById(subjectUser._id);
    assert(afterCancel2.scheduledScrubAt === null, "scheduledScrubAt cleared after session-based cancel");
    const cancelledLog2 = await AccountDeletionAuditLog.countDocuments({ playerId: subjectPlayer._id, action: "CANCELLED" });
    assert(cancelledLog2 === 2, `2 CANCELLED audit log entries now recorded, one per cancel path (got ${cancelledLog2})`);

    // === PHASE 5: elapsed grace period actually scrubs, via the lazy GraphQL-request sweep ===
    console.log("\n=== PHASE 5: an elapsed window actually scrubs (fast-forwarded in the DB), backup retained ===");
    const rawConfirmToken3 = randomBytes(32).toString("hex");
    await User.findByIdAndUpdate(subjectUser._id, {
      deleteAccountTokenHash: hashToken(rawConfirmToken3),
      deleteAccountTokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
    });
    await callConfirm(rawConfirmToken3);

    // Explicitly sanctioned by the task: fast-forward the scheduled date
    // directly in the DB instead of waiting 7 real days.
    await User.findByIdAndUpdate(subjectUser._id, { scheduledScrubAt: new Date(Date.now() - 1000) });

    // Any GraphQL request triggers the lazy sweep (app/api/graphql/route.ts's
    // context factory) — an unrelated public query is enough.
    await gql(`query { games { id } }`, {});

    const afterElapsed = await User.findById(subjectUser._id);
    const playerAfterElapsed = await Player.findById(subjectPlayer._id);
    assert(playerAfterElapsed.isDeleted === true, "Player IS scrubbed once the window elapses (via the lazy GraphQL-request sweep)");
    assert(playerAfterElapsed.tag.startsWith("Deleted Player #"), `Tag anonymized (got "${playerAfterElapsed.tag}")`);
    assert(afterElapsed.email !== emails.subject && afterElapsed.email.startsWith("deleted-"), `Email scrubbed (got "${afterElapsed.email}")`);
    assert(afterElapsed.scheduledScrubAt === null, "scheduledScrubAt cleared once actually scrubbed");
    assert(playerAfterElapsed.scrubBackupTag === "GraceDelSubject", `Original tag retained in the restore backup (got "${playerAfterElapsed.scrubBackupTag}")`);
    assert(afterElapsed.scrubBackupEmail === emails.subject, `Original email retained in the restore backup (got "${afterElapsed.scrubBackupEmail}")`);
    assert(!!afterElapsed.scrubBackupExpiresAt, "scrubBackupExpiresAt (30-day restore window) was set");

    const scrubbedLog = await AccountDeletionAuditLog.findOne({ playerId: subjectPlayer._id, action: "SCRUBBED" });
    assert(!!scrubbedLog && scrubbedLog.performedByPlayerId === null, "SCRUBBED audit log entry recorded with no performer (elapsed on its own, nobody 'did' it)");

    // === PHASE 6: admin restore tool actually recovers tag/email ===
    console.log("\n=== PHASE 6: SUPER_ADMIN restoreDeletedPlayer actually recovers the original tag/email ===");
    const { cookieJar: superAdminCookies, gotSessionCookie: superAdminLoggedIn } = await httpLogin(emails.superAdmin, password, "10.99.0.3");
    assert(superAdminLoggedIn, "Super Admin real HTTP login succeeded");

    const listRes = await gql(`query { restorableDeletedPlayers { id scrubBackupTag } }`, {}, superAdminCookies);
    assert(!listRes.errors, `restorableDeletedPlayers query succeeded (${JSON.stringify(listRes.errors)})`);
    const listedIds = (listRes.data?.restorableDeletedPlayers ?? []).map(p => p.id);
    assert(listedIds.includes(subjectPlayer._id.toString()), "The scrubbed subject player appears in restorableDeletedPlayers");

    const restoreRes = await gql(
      `mutation($playerId: ID!) { restoreDeletedPlayer(playerId: $playerId) { id tag isDeleted } }`,
      { playerId: subjectPlayer._id.toString() },
      superAdminCookies
    );
    assert(!restoreRes.errors, `restoreDeletedPlayer succeeded (${JSON.stringify(restoreRes.errors)})`);
    assert(restoreRes.data?.restoreDeletedPlayer?.tag === "GraceDelSubject", `Restored player's tag is back to the original (got "${restoreRes.data?.restoreDeletedPlayer?.tag}")`);
    assert(restoreRes.data?.restoreDeletedPlayer?.isDeleted === false, "Restored player is no longer marked isDeleted");

    const restoredUser = await User.findById(subjectUser._id);
    assert(restoredUser.email === emails.subject, `Restored user's email is back to the original (got "${restoredUser.email}")`);
    assert(restoredUser.scrubBackupEmail === null, "scrubBackupEmail cleared after restore (consumed, not left lying around)");

    const restoredLog = await AccountDeletionAuditLog.findOne({ playerId: subjectPlayer._id, action: "RESTORED" });
    assert(
      !!restoredLog && restoredLog.performedByPlayerId?.toString() === superAdminPlayer._id.toString(),
      "RESTORED audit log entry recorded with the correct performing Super Admin"
    );

    // A regular (non-super) admin cannot restore. Reuse adminImmediatePlayer's
    // user, temporarily promoted, for this negative check.
    await User.findByIdAndUpdate(adminImmediateUser._id, { role: "ADMIN" });
    const { cookieJar: regularAdminCookies } = await httpLogin(emails.adminImmediate, password, "10.99.0.4");
    const forbiddenRes = await gql(`query { restorableDeletedPlayers { id } }`, {}, regularAdminCookies);
    assert(!!forbiddenRes.errors, "A regular ADMIN (not Super Admin) is rejected from restorableDeletedPlayers");
    await User.findByIdAndUpdate(adminImmediateUser._id, { role: "PLAYER" });

    // === PHASE 7: the redundant login-time elapsed check (lib/auth.ts) works independently of the GraphQL sweep ===
    console.log("\n=== PHASE 7: an elapsed window is also caught by a direct login attempt (never touching /api/graphql first) ===");
    const rawConfirmToken4 = randomBytes(32).toString("hex");
    await User.findByIdAndUpdate(loginPathUser._id, {
      deleteAccountTokenHash: hashToken(rawConfirmToken4),
      deleteAccountTokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
    });
    await callConfirm(rawConfirmToken4);
    await User.findByIdAndUpdate(loginPathUser._id, { scheduledScrubAt: new Date(Date.now() - 1000) });

    // Direct login attempt — /api/auth/callback/credentials, NOT /api/graphql.
    const { gotSessionCookie: elapsedLoginWorked } = await httpLogin(emails.loginPath, password, "10.99.0.5");
    assert(!elapsedLoginWorked, "Direct login attempt on an elapsed-but-unswept account is REJECTED (scrubbed just-in-time by authorize())");

    const loginPathPlayerAfter = await Player.findById(loginPathPlayer._id);
    assert(loginPathPlayerAfter.isDeleted === true, "That account was actually scrubbed as a side effect of the login attempt itself, not a GraphQL request");

    // === PHASE 8: ADMIN immediate deletePlayer still works, bypassing the grace period, and logs the performing admin ===
    console.log("\n=== PHASE 8: ADMIN deletePlayer still scrubs immediately (unchanged), logs the performing admin ===");
    await User.findByIdAndUpdate(adminImmediateUser._id, { role: "ADMIN" });
    const { cookieJar: adminCookies } = await httpLogin(emails.adminImmediate, password, "10.99.0.6");
    const deleteRes = await gql(`mutation($id: ID!) { deletePlayer(id: $id) }`, { id: subjectPlayer._id.toString() }, adminCookies);
    assert(!deleteRes.errors, `ADMIN deletePlayer succeeded on the (already-restored) subject player (${JSON.stringify(deleteRes.errors)})`);
    const subjectAfterAdminDelete = await Player.findById(subjectPlayer._id);
    assert(subjectAfterAdminDelete.isDeleted === true, "Immediately scrubbed by the admin action, no grace period involved");
    const adminScrubLog = await AccountDeletionAuditLog.findOne({ playerId: subjectPlayer._id, action: "SCRUBBED", performedByPlayerId: adminImmediatePlayer._id });
    assert(!!adminScrubLog, "SCRUBBED audit log entry attributes this one to the performing admin (distinct from an elapsed/self scrub)");

    console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURE(S)`}`);
  } finally {
    console.log("\nCleaning up test data...");
    await AccountDeletionAuditLog.deleteMany({
      playerId: { $in: [subjectPlayer._id, loginPathPlayer._id, adminImmediatePlayer._id, superAdminPlayer._id] },
    });
    await Player.deleteMany({ _id: { $in: [subjectPlayer._id, loginPathPlayer._id, adminImmediatePlayer._id, superAdminPlayer._id] } });
    await User.deleteMany({ _id: { $in: [subjectUser._id, loginPathUser._id, adminImmediateUser._id, superAdminUser._id] } });
    console.log("Cleanup done.");
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
