// Functional verification for the delete-account/confirm page fix (follow-up
// to commit 0237b3d): confirming a deletion should sign the current session
// out for real, and the page should stay put rather than auto-redirecting.
// Real HTTP login, real confirmAccountDeletion mutation, and a real POST to
// NextAuth's own /api/auth/signout endpoint (the exact request
// signOut({redirect:false}) makes client-side) -- not a mock. Confirms:
//   1. A real session is valid before confirming (sanity baseline).
//   2. confirmAccountDeletion succeeds and does NOT itself touch the
//      session cookie (it's a token-based mutation).
//   3. The sign-out request the page issues actually invalidates the
//      session -- a subsequent request with the SAME (properly merged)
//      cookie jar no longer carries a valid session.
//   4. The email-link cancellation path (cancelAccountDeletion, token-based,
//      no auth required) still works fine even after this session was
//      signed out -- confirms the fix doesn't block that separate path.
//
// The page's own "don't auto-navigate" behavior is a pure client-side
// absence-of-a-router.push, verified by code review (no browser automation
// set up in this environment) -- not something a server-rendered HTML fetch
// can distinguish either way.
//
// Requires `npm run dev` already running on localhost:3000.
// Run: npx tsx scripts/testDeleteAccountConfirmSignOut.mjs

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnvLocal();
if (!process.env.MONGODB_URI) throw new Error("Missing MONGODB_URI (checked .env.local)");

const { connectToDatabase } = await import("../lib/db");
const { User } = await import("../models/User");
const { Player } = await import("../models/Player");
const bcrypt = (await import("bcryptjs")).default;

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

// A real cookie jar -- keyed by cookie name, REPLACING on each new
// Set-Cookie rather than naively concatenating strings. Concatenating would
// let a stale "session-token=<old value>" sit alongside a fresh
// "session-token=<cleared/new value>" in the same Cookie header, which is
// exactly the kind of test-script bug that can make a real signOut() look
// broken when it isn't (or vice versa) -- this is the corrected version of
// that mistake, not a hypothetical.
class CookieJar {
  constructor() {
    this.cookies = new Map();
  }
  applySetCookies(headers) {
    for (const raw of headers ?? []) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  has(namePattern) {
    return [...this.cookies.keys()].some(k => namePattern.test(k));
  }
}

async function main() {
  await connectToDatabase();

  const email = "confirmsignouttest@example.com";
  const password = "TestPass123!";
  await User.deleteOne({ email });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ email, passwordHash });
  const player = await Player.create({ userId: user._id, tag: "ConfirmSignOutTest" });
  await User.findByIdAndUpdate(user._id, { playerId: player._id });

  const jar = new CookieJar();

  try {
    // --- Real HTTP login ---
    console.log("\n=== Real HTTP login ===");
    const ipHeaders = { "x-forwarded-for": "10.97.0.1" };
    const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`, { headers: ipHeaders });
    jar.applySetCookies(csrfRes.headers.getSetCookie?.());
    const { csrfToken: loginCsrfToken } = await csrfRes.json();

    const loginRes = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.header(), ...ipHeaders },
      body: new URLSearchParams({ email, password, csrfToken: loginCsrfToken, json: "true" }),
    });
    jar.applySetCookies(loginRes.headers.getSetCookie?.());
    assert(jar.has(/session-token/i), `Got a session-token cookie (status ${loginRes.status})`);

    // --- Sanity: session is valid before confirming ---
    const sessionBefore = await fetch(`${BASE_URL}/api/auth/session`, { headers: { Cookie: jar.header() } });
    const sessionBeforeJson = await sessionBefore.json();
    assert(sessionBeforeJson?.user?.email === email, `Session is valid and recognizes the user before confirming (got ${JSON.stringify(sessionBeforeJson?.user)})`);

    // --- Simulate having received the confirm-deletion email: self-plant a
    // known token with the same hash scheme confirmAccountDeletion checks
    // (real Resend delivery to @example.com is rejected -- same known
    // limitation as the grace-period test suite, tolerated the same way:
    // the mutation's DB writes happen before the fallible email send, so
    // that rejection doesn't affect what's actually under test here). ---
    console.log("\n=== confirmAccountDeletion (what the page's own fetch call does) ===");
    const rawConfirmToken = randomBytes(32).toString("hex");
    await User.findByIdAndUpdate(user._id, {
      deleteAccountTokenHash: hashToken(rawConfirmToken),
      deleteAccountTokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
    });

    const confirmRes = await fetch(`${BASE_URL}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `mutation ConfirmAccountDeletion($token: String!) { confirmAccountDeletion(token: $token) }`,
        variables: { token: rawConfirmToken },
      }),
    });
    const confirmJson = await confirmRes.json();
    const confirmFailedForRealReason = confirmJson.errors && !/Invalid `to` field|example\.com/i.test(confirmJson.errors[0]?.message ?? "");
    assert(!confirmFailedForRealReason, `confirmAccountDeletion succeeded, or failed only on the known Resend @example.com rejection (${JSON.stringify(confirmJson.errors)})`);

    const afterConfirmUser = await User.findById(user._id);
    assert(!!afterConfirmUser.scheduledScrubAt, "Account is now genuinely pending-deletion (scheduledScrubAt set)");

    // The mutation itself is token-based and touches no cookies -- the
    // session (from login, above) should still be valid at this exact
    // point, same as the grace-period feature's own "sign-in stays allowed
    // while pending" design. This is what makes the NEXT step (the page's
    // own explicit signOut() call) the thing actually doing the work,
    // not some incidental side effect of the mutation.
    const sessionAfterConfirm = await fetch(`${BASE_URL}/api/auth/session`, { headers: { Cookie: jar.header() } });
    const sessionAfterConfirmJson = await sessionAfterConfirm.json();
    assert(
      sessionAfterConfirmJson?.user?.email === email,
      `Session is STILL valid immediately after confirmAccountDeletion alone (before the page's own signOut() call) -- confirms the mutation itself doesn't touch the session`
    );

    // --- The page's own signOut({redirect:false}) call -- real request to
    // NextAuth's own /api/auth/signout endpoint, exactly what that client
    // helper issues under the hood. ---
    console.log("\n=== signOut() -- real request to /api/auth/signout ===");
    const signoutCsrfRes = await fetch(`${BASE_URL}/api/auth/csrf`, { headers: { Cookie: jar.header() } });
    jar.applySetCookies(signoutCsrfRes.headers.getSetCookie?.());
    const { csrfToken: signoutCsrfToken } = await signoutCsrfRes.json();

    const signoutRes = await fetch(`${BASE_URL}/api/auth/signout`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.header() },
      body: new URLSearchParams({ csrfToken: signoutCsrfToken, json: "true" }),
    });
    const signoutSetCookies = signoutRes.headers.getSetCookie?.() ?? [];
    assert(signoutRes.status < 400, `POST /api/auth/signout responded successfully (status ${signoutRes.status})`);
    jar.applySetCookies(signoutSetCookies);

    // --- Confirm the session is ACTUALLY gone -- a subsequent request with
    // the (now-cleared) cookie jar no longer carries a valid session. ---
    console.log("\n=== Confirm the session is genuinely gone afterward ===");
    const sessionAfterSignout = await fetch(`${BASE_URL}/api/auth/session`, { headers: { Cookie: jar.header() } });
    const sessionAfterSignoutJson = await sessionAfterSignout.json();
    assert(
      !sessionAfterSignoutJson?.user,
      `Session is gone after signing out -- a subsequent request no longer carries a valid session (got ${JSON.stringify(sessionAfterSignoutJson)})`
    );

    // Also confirm an authenticated GraphQL query using the SAME (now
    // signed-out) cookie jar no longer resolves the user -- the real thing
    // that matters, not just NextAuth's own session endpoint.
    const meRes = await fetch(`${BASE_URL}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: jar.header() },
      body: JSON.stringify({ query: `query { me { email } }` }),
    });
    const meJson = await meRes.json();
    assert(!meJson.data?.me, `An authenticated GraphQL query (me) with the same cookie jar no longer resolves a user (got ${JSON.stringify(meJson.data)})`);

    // --- The email-link cancellation path still works after this session was signed out ---
    console.log("\n=== cancelAccountDeletion (email-link path) still works after sign-out ===");
    const rawCancelToken = randomBytes(32).toString("hex");
    await User.findByIdAndUpdate(user._id, { cancelDeletionTokenHash: hashToken(rawCancelToken), cancelDeletionTokenExpiry: new Date(Date.now() + 60 * 60 * 1000) });
    const cancelRes = await fetch(`${BASE_URL}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `mutation CancelAccountDeletion($token: String!) { cancelAccountDeletion(token: $token) }`,
        variables: { token: rawCancelToken },
      }),
    });
    const cancelJson = await cancelRes.json();
    assert(!cancelJson.errors, `cancelAccountDeletion (email-link, no auth) still succeeds after the confirm session was signed out (${JSON.stringify(cancelJson.errors)})`);
    const afterCancelUser = await User.findById(user._id);
    assert(afterCancelUser.scheduledScrubAt === null, "Deletion actually cancelled -- account is back to normal, not stuck pending");

    console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURE(S)`}`);
  } finally {
    console.log("\nCleaning up test data...");
    await Player.findByIdAndDelete(player._id);
    await User.findByIdAndDelete(user._id);
    console.log("Cleanup done.");
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
