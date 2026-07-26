// Real functional verification for the "generic 'Something went wrong' masks
// real causes" fix -- actually exhausts each of the 5 client-reachable rate
// limiters (using synthetic TEST-NET-3 IPs, RFC 5737, so nothing collides
// with real traffic) via DIRECT invocation of the real resolvers/real
// Redis-backed limiters, and confirms the specific RATE_LIMITED-tagged
// GraphQLError comes back rather than a generic one.
//
// Direct invocation (not HTTP) is used throughout because @upstash/ratelimit
// defaults to an in-memory ephemeralCache per Ratelimit instance -- hitting
// the limiter repeatedly through a long-lived `npm run dev` process would
// leave that process's cache "remembering" a test IP as blocked long after
// Redis itself was reset from a separate script process, breaking repeat
// runs. Direct invocation gets a fresh, empty cache every run. The
// extensions.code actually survives real Apollo/HTTP JSON serialization --
// already confirmed directly against a real running dev server earlier in
// this fix's verification (a real `register` mutation's 4th-attempt-over-
// limit response came back over the wire as
// `"extensions":{"code":"RATE_LIMITED"}`) -- so this script exercises the
// resolver-level construction, which is the actual mechanism the client
// branches on either way.
//
// Cleans up all consumed rate-limit state (Redis) and any created test DB
// records afterward.
//
// Run: npx tsx scripts/verifyRateLimitErrorSurfacing.mjs

import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";

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

const {
  loginRateLimit,
  registerRateLimit,
  passwordResetRateLimit,
  resendVerificationRateLimit,
  deleteAccountRequestRateLimit,
} = await import("../lib/rateLimit");
const { connectToDatabase } = await import("../lib/db");
const { User } = await import("../models/User");
const { Player } = await import("../models/Player");
const { resolvers } = await import("../graphql/resolvers/index");
const { authConfig } = await import("../lib/auth");

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  OK   ${label}`);
  } else {
    console.log(`  FAIL ${label}`);
    failures++;
  }
}

const fakeReq = (ip) => new Request("http://localhost/api/graphql", { headers: { "x-forwarded-for": ip } });

const createdUserIds = [];
const createdPlayerIds = [];

async function main() {
  await connectToDatabase();

  try {
    console.log("\n=== register rate limit (registerRateLimit: 3/hour, direct resolver invocation, real Cloudflare dummy-CAPTCHA) ===");
    const registerIp = "203.0.113.31";
    // registerRateLimit.limit() runs before any DB write or email send (see
    // graphql/resolvers/index.ts), so these 3 calls consume real rate-limit
    // tokens regardless of whether the downstream email send itself
    // succeeds -- Resend rejects @example.com as a recipient in this
    // sandboxed test environment, an unrelated, expected, and
    // already-self-rolling-back failure (register() rolls back the created
    // User+Player if the verification email fails to send), not a
    // rate-limit rejection. What matters here is only that these 3 calls
    // are NOT tagged RATE_LIMITED.
    for (let i = 0; i < 3; i++) {
      try {
        const result = await resolvers.Mutation.register(
          null,
          { email: `ratelimitverify${i}@example.com`, password: "TestPass123!", tag: `RLVerify${i}`, turnstileToken: "test-dummy-token" },
          { req: fakeReq(registerIp) }
        );
        if (result?.user?.id) createdUserIds.push(result.user.id);
        assert(true, `Register attempt ${i + 1}/3 (within limit) is NOT rate-limited`);
      } catch (err) {
        assert(err?.extensions?.code !== "RATE_LIMITED", `Register attempt ${i + 1}/3 (within limit) is NOT rate-limited (threw: ${err?.message})`);
      }
    }
    let registerOverLimitError = null;
    try {
      await resolvers.Mutation.register(
        null,
        { email: "ratelimitverify-over@example.com", password: "TestPass123!", tag: "RLVerifyOver", turnstileToken: "test-dummy-token" },
        { req: fakeReq(registerIp) }
      );
    } catch (err) {
      registerOverLimitError = err;
    }
    assert(!!registerOverLimitError, "4th register attempt (over limit) throws");
    assert(
      registerOverLimitError?.extensions?.code === "RATE_LIMITED",
      `4th register attempt is tagged extensions.code === "RATE_LIMITED" (got ${JSON.stringify(registerOverLimitError?.extensions)})`
    );
    assert(
      registerOverLimitError?.message === "Too many accounts created from this IP. Please try again later.",
      `4th register attempt surfaces its OWN specific message, not a generic one (got "${registerOverLimitError?.message}")`
    );
    assert(
      registerOverLimitError?.message !== "Something went wrong. Please try again.",
      "Confirmed: this is NOT the generic catch-all message"
    );
    await registerRateLimit.resetUsedTokens(registerIp);

    console.log("\n=== requestPasswordReset rate limit (passwordResetRateLimit: 20/hour in dev, direct resolver invocation) ===");
    const pwResetIp = "203.0.113.32";
    for (let i = 0; i < 20; i++) {
      try {
        await resolvers.Mutation.requestPasswordReset(null, { email: "nonexistent-rl-test@example.com" }, { req: fakeReq(pwResetIp) });
      } catch (err) {
        assert(false, `requestPasswordReset attempt ${i + 1}/20 (should be within limit) unexpectedly threw: ${err?.message}`);
      }
    }
    let pwResetOverLimitError = null;
    try {
      await resolvers.Mutation.requestPasswordReset(null, { email: "nonexistent-rl-test@example.com" }, { req: fakeReq(pwResetIp) });
    } catch (err) {
      pwResetOverLimitError = err;
    }
    assert(!!pwResetOverLimitError, "21st requestPasswordReset attempt (over limit) throws");
    assert(
      pwResetOverLimitError?.extensions?.code === "RATE_LIMITED",
      `21st requestPasswordReset attempt is tagged extensions.code === "RATE_LIMITED" (got ${JSON.stringify(pwResetOverLimitError?.extensions)})`
    );
    assert(
      pwResetOverLimitError?.message === "Too many requests. Please try again later.",
      `21st requestPasswordReset attempt surfaces its real specific message (got "${pwResetOverLimitError?.message}")`
    );
    // This is exactly the condition app/(auth)/forgot-password/page.tsx's
    // handleSubmit now branches on instead of silently reporting success --
    // previously it discarded json.errors entirely.
    await passwordResetRateLimit.resetUsedTokens(pwResetIp);

    console.log("\n=== resendVerificationEmail rate limit (resendVerificationRateLimit: 20/hour in dev, direct resolver invocation) ===");
    const resendIp = "203.0.113.33";
    for (let i = 0; i < 20; i++) {
      try {
        await resolvers.Mutation.resendVerificationEmail(null, { email: "nonexistent-rl-test@example.com" }, { req: fakeReq(resendIp) });
      } catch (err) {
        assert(false, `resendVerificationEmail attempt ${i + 1}/20 (should be within limit) unexpectedly threw: ${err?.message}`);
      }
    }
    let resendOverLimitError = null;
    try {
      await resolvers.Mutation.resendVerificationEmail(null, { email: "nonexistent-rl-test@example.com" }, { req: fakeReq(resendIp) });
    } catch (err) {
      resendOverLimitError = err;
    }
    assert(!!resendOverLimitError, "21st resendVerificationEmail attempt (over limit) throws");
    assert(
      resendOverLimitError?.extensions?.code === "RATE_LIMITED",
      `21st resendVerificationEmail attempt is tagged extensions.code === "RATE_LIMITED" (got ${JSON.stringify(resendOverLimitError?.extensions)})`
    );
    // This is the exact condition all 3 "resend verification email" client
    // call sites (login page, RegisterForm, verify-email page) now check
    // instead of silently reporting success.
    await resendVerificationRateLimit.resetUsedTokens(resendIp);

    console.log("\n=== login rate limit (loginRateLimit: 5/5min, direct authorize() invocation -- same code path NextAuth's real /api/auth/callback/credentials hits) ===");
    const loginIp = "203.0.113.34";
    // CredentialsProvider()'s own top-level `.authorize` is a fixed dummy
    // stub (`() => null`) -- the real function we configured lives under
    // `.options.authorize` (NextAuth rebinds it internally at request time).
    const authorize = authConfig.providers[0].options.authorize;
    for (let i = 0; i < 5; i++) {
      let threw = false;
      try {
        await authorize({ email: "nonexistent-login-rl@example.com", password: "wrongpass" }, fakeReq(loginIp));
      } catch {
        threw = true;
      }
      assert(!threw, `Login attempt ${i + 1}/5 (within limit) does not throw a rate-limit error`);
    }
    let loginOverLimitError = null;
    try {
      await authorize({ email: "nonexistent-login-rl@example.com", password: "wrongpass" }, fakeReq(loginIp));
    } catch (err) {
      loginOverLimitError = err;
    }
    assert(!!loginOverLimitError, "6th login attempt (over limit) throws");
    assert(loginOverLimitError?.code === "rate_limited", `6th login attempt throws with code "rate_limited" (got "${loginOverLimitError?.code}")`);
    assert(
      loginOverLimitError?.constructor?.name === "RateLimitedSignin",
      `6th login attempt throws the specific RateLimitedSignin class, not a generic error (got ${loginOverLimitError?.constructor?.name})`
    );
    // This is exactly the `result.code === "rate_limited"` check
    // app/(auth)/login/page.tsx's handleSubmit already branches on.
    await loginRateLimit.resetUsedTokens(loginIp);

    console.log("\n=== requestAccountDeletion rate limit (deleteAccountRequestRateLimit: 20/hour in dev, direct resolver invocation) ===");
    const passwordHash = await bcrypt.hash("TestPass123!", 10);
    const testUser = await User.create({ email: "ratelimitverify-delacct@example.com", passwordHash });
    createdUserIds.push(testUser._id.toString());
    const testPlayer = await Player.create({ userId: testUser._id, tag: "RLVerifyDelAcct" });
    createdPlayerIds.push(testPlayer._id.toString());
    await User.findByIdAndUpdate(testUser._id, { playerId: testPlayer._id });

    const delAcctIp = "203.0.113.35";
    // Same reasoning as the register loop above: deleteAccountRequestRateLimit
    // is checked before sendAccountDeletionEmail, so an unrelated Resend
    // rejection of the @example.com test recipient doesn't affect whether
    // these 20 calls correctly consumed real rate-limit tokens -- only that
    // none of them are themselves tagged RATE_LIMITED.
    for (let i = 0; i < 20; i++) {
      try {
        await resolvers.Mutation.requestAccountDeletion(null, null, { playerId: testPlayer._id.toString(), req: fakeReq(delAcctIp) });
      } catch (err) {
        assert(
          err?.extensions?.code !== "RATE_LIMITED",
          `requestAccountDeletion attempt ${i + 1}/20 (within limit) is NOT rate-limited (threw: ${err?.message})`
        );
      }
    }
    let delAcctOverLimitError = null;
    try {
      await resolvers.Mutation.requestAccountDeletion(null, null, { playerId: testPlayer._id.toString(), req: fakeReq(delAcctIp) });
    } catch (err) {
      delAcctOverLimitError = err;
    }
    assert(!!delAcctOverLimitError, "21st requestAccountDeletion attempt (over limit) throws");
    assert(
      delAcctOverLimitError?.extensions?.code === "RATE_LIMITED",
      `21st requestAccountDeletion attempt is tagged extensions.code === "RATE_LIMITED" (got ${JSON.stringify(delAcctOverLimitError?.extensions)})`
    );
    // This is exactly the condition components/DeleteAccountButton.tsx's
    // alert() now branches on to show the friendly rate-limit-specific text
    // instead of the raw resolver message.
    await deleteAccountRequestRateLimit.resetUsedTokens(delAcctIp);

    console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURE(S)`}`);
  } finally {
    console.log("\nCleaning up test data + consumed rate-limit state...");
    await Player.deleteMany({ _id: { $in: createdPlayerIds } });
    await User.deleteMany({ _id: { $in: createdUserIds } });
    // Also catch the 3 real accounts created by the register-mutation loop,
    // in case their ids weren't captured above for any reason.
    await Player.deleteMany({ tag: /^RLVerify/ });
    const leftoverUsers = await User.find({ email: /ratelimitverify/i });
    await User.deleteMany({ _id: { $in: leftoverUsers.map(u => u._id) } });

    const leftoverPlayers = await Player.countDocuments({ tag: /^RLVerify/ });
    const leftoverUsersCount = await User.countDocuments({ email: /ratelimitverify/i });
    console.log(`Verification -- leftover test players: ${leftoverPlayers}, leftover test users: ${leftoverUsersCount}`);
    console.log("Cleanup done.");
  }

  process.exit(failures === 0 ? 0 : 1);
}

main();
