// scripts/verifyEmailLinksAndDuplicateEmailCors.mjs
//
// Closes out the NEXT_PUBLIC_APP_URL follow-up (fix landed in commit
// 179bfba). Two things were never independently verified:
//
// 1. Password-reset and email-verification-resend links: does the actual
//    sent email link to https://www.fgc-ranks.com/... (not localhost, not
//    bare apex), and does clicking through in a fresh browser context
//    succeed with no CORS/console errors? (Only the account-deletion email
//    got this treatment before.)
// 2. The generic-error-on-duplicate-email anomaly: was it really the same
//    CORS/preflight bug that affected RegisterForm.tsx (one of the 6 files
//    fixed in 179bfba)? Reproduced directly against production with a real
//    disposable test account, inspecting actual network request/response
//    details rather than judging plausibility.
//
// The test account itself is created directly in the (shared, real) DB --
// same pattern as other one-off scripts in this folder -- rather than
// through the real /register UI, because /register is the one form gated
// by Cloudflare Turnstile (Security Push Phase 5) and driving a real
// production CAPTCHA from a script is a separate, orthogonal problem from
// what's being verified here. requestPasswordReset/resendVerificationEmail
// have no CAPTCHA gate, so those two run entirely through the real
// production UI. The duplicate-email check (Step 3) DOES need the real
// /register UI+Turnstile, since that's specifically what's being tested --
// see the notes at that step for how Turnstile is handled and what happens
// if it can't be resolved.
//
// Uses mail.tm (free disposable inbox with a real REST API, no signup UI)
// for actually receiving the emails.
//
// Requires MONGODB_URI in .env.local (same DB as production, per project
// convention).
//
// Run: node scripts/verifyEmailLinksAndDuplicateEmailCors.mjs

import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const SITE = "https://www.fgc-ranks.com";
let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  OK   ${label}`);
  } else {
    console.log(`  FAIL ${label}`);
    failures++;
  }
}

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

// ---- mail.tm disposable inbox ----------------------------------------
async function mtFetch(path, opts = {}) {
  const res = await fetch(`https://api.mail.tm${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`mail.tm ${path} -> ${res.status}: ${text}`);
  return json;
}

async function createDisposableInbox() {
  const domains = await mtFetch("/domains");
  const domain = domains["hydra:member"][0].domain;
  const address = `fgcranks.verify.${Date.now()}@${domain}`;
  const password = "Test-" + Math.random().toString(36).slice(2) + "!9";
  const created = await mtFetch("/accounts", { method: "POST", body: JSON.stringify({ address, password }) });
  // mail.tm normalizes/echoes back the actual stored address -- must
  // authenticate with THIS value, not the locally-constructed one, or
  // /token 401s even though the account was created successfully.
  const actualAddress = created.address || address;

  let token;
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      ({ token } = await mtFetch("/token", { method: "POST", body: JSON.stringify({ address: actualAddress, password }) }));
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return { address: actualAddress, password, token };
}

async function waitForMessage(token, { after = 0, subjectIncludes, timeoutMs = 45000 }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const list = await mtFetch("/messages", { headers: { Authorization: `Bearer ${token}` } });
    const members = list["hydra:member"] || [];
    const match = members.find(
      m => new Date(m.createdAt).getTime() >= after && m.subject.includes(subjectIncludes)
    );
    if (match) {
      return mtFetch(`/messages/${match.id}`, { headers: { Authorization: `Bearer ${token}` } });
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for an email with subject containing "${subjectIncludes}"`);
}

function extractFirstLink(msg) {
  const html = Array.isArray(msg.html) ? msg.html.join("\n") : (msg.html || msg.text || "");
  const match = html.match(/href="([^"]+)"/);
  return match ? match[1].replace(/&amp;/g, "&") : null;
}

// ---- Turnstile handling -----------------------------------------------
// Poll the hidden `cf-turnstile-response` input Cloudflare's script writes
// into the page once a challenge resolves, rather than repeatedly clicking
// submit -- a direct signal instead of a proxy. Falls back to clicking the
// widget's visible checkbox if it hasn't self-resolved after a while
// (managed mode sometimes needs that nudge even for legitimate sessions).
async function waitForTurnstileToken(page, { timeoutMs = 90000 } = {}) {
  const start = Date.now();
  let clickedCheckbox = false;
  while (Date.now() - start < timeoutMs) {
    const value = await page.evaluate(() => {
      const el = document.querySelector('input[name="cf-turnstile-response"]');
      return el ? el.value : "";
    }).catch(() => "");
    if (value) return value;

    if (!clickedCheckbox && Date.now() - start > 15000) {
      const cfFrame = page.frameLocator('iframe[src*="challenges.cloudflare.com"]').first();
      await cfFrame.locator("body").click({ timeout: 3000 }).catch(() => {});
      clickedCheckbox = true;
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

// ---- Network/console instrumentation ----------------------------------
function instrumentPage(page, label) {
  const events = { consoleErrors: [], failedRequests: [], graphqlCalls: [] };
  page.on("console", msg => {
    if (msg.type() === "error") events.consoleErrors.push(msg.text());
  });
  page.on("requestfailed", req => {
    events.failedRequests.push({ url: req.url(), failure: req.failure()?.errorText });
  });
  page.on("response", async res => {
    if (res.url().includes("/api/graphql")) {
      let body = null;
      try { body = await res.text(); } catch {}
      events.graphqlCalls.push({ url: res.url(), status: res.status(), headers: res.headers(), body });
    }
  });
  console.log(`  [instrumented: ${label}]`);
  return events;
}

async function main() {
  loadEnvLocal();
  if (!process.env.MONGODB_URI) throw new Error("Missing MONGODB_URI (checked .env.local)");
  const { connectToDatabase } = await import("../lib/db.ts");
  const { User } = await import("../models/User.ts");
  const bcrypt = (await import("bcryptjs")).default;

  console.log("=== Setting up disposable inbox (mail.tm) ===");
  const inbox = await createDisposableInbox();
  console.log(`  inbox: ${inbox.address}`);

  console.log("=== Creating test account directly in DB (bypasses Turnstile-gated /register) ===");
  await connectToDatabase();
  const passwordHash = await bcrypt.hash("Sup3rSecret!42", 10);
  const user = await User.create({
    email: inbox.address,
    passwordHash,
    emailVerified: false, // so resendVerificationEmail actually sends
  });
  console.log(`  User created: ${user._id}`);

  const browser = await chromium.launch({ headless: false });

  try {
    // ---------------- Step 1: real email-verification RESEND -------------
    // Reached via the real error-state resend form on /verify-email (no
    // Turnstile involved -- only /register is gated).
    console.log("\n=== Step 1: Trigger real email-verification RESEND ===");
    const ctxVerify = await browser.newContext();
    const pageVerify = await ctxVerify.newPage();
    const verifyEvents = instrumentPage(pageVerify, "verify-email resend");
    const resendStart = Date.now();
    await pageVerify.goto(`${SITE}/verify-email?token=deliberately-invalid-token`, { waitUntil: "domcontentloaded" });
    await pageVerify.getByPlaceholder("you@example.com").fill(inbox.address);
    await pageVerify.getByRole("button", { name: "Resend link" }).click();
    const resendConfirmed = await pageVerify.getByText("If that email needs verifying, a new link has been sent.").isVisible({ timeout: 10000 }).catch(() => false);
    assert(resendConfirmed, "resendVerificationEmail: UI confirmed sent");
    assert(verifyEvents.failedRequests.length === 0, "resend flow: zero failed network requests");
    assert(verifyEvents.consoleErrors.filter(e => /cors|cross-origin|preflight/i.test(e)).length === 0, "resend flow: zero CORS-related console errors");

    console.log("  Waiting for the verification email to actually arrive...");
    const verifyMsg = await waitForMessage(inbox.token, { after: resendStart, subjectIncludes: "Verify your FGC Ranks email" });
    const verifyLink = extractFirstLink(verifyMsg);
    console.log(`  verification email link: ${verifyLink}`);
    assert(!!verifyLink, "verification email received with a link");
    assert(verifyLink?.startsWith("https://www.fgc-ranks.com/verify-email?token="), "verification link points to https://www.fgc-ranks.com (not localhost/bare apex)");

    const ctxVerifyClick = await browser.newContext();
    const pageVerifyClick = await ctxVerifyClick.newPage();
    const verifyClickEvents = instrumentPage(pageVerifyClick, "verify-email click-through (fresh context)");
    await pageVerifyClick.goto(verifyLink, { waitUntil: "domcontentloaded" });
    const verifySuccess = await pageVerifyClick.getByText("Your email is verified.").isVisible({ timeout: 10000 }).catch(() => false);
    assert(verifySuccess, "verify-email link click-through: succeeded, no errors shown");
    assert(verifyClickEvents.failedRequests.length === 0, "verify-email click-through: zero failed network requests");
    assert(verifyClickEvents.consoleErrors.filter(e => /cors|cross-origin|preflight/i.test(e)).length === 0, "verify-email click-through: zero CORS-related console errors");
    await ctxVerifyClick.close();
    await ctxVerify.close();

    // ---------------- Step 2: real password-reset request -----------------
    console.log("\n=== Step 2: Trigger real password-reset request ===");
    const ctxForgot = await browser.newContext();
    const pageForgot = await ctxForgot.newPage();
    const forgotEvents = instrumentPage(pageForgot, "forgot-password");
    const forgotStart = Date.now();
    await pageForgot.goto(`${SITE}/forgot-password`, { waitUntil: "domcontentloaded" });
    await pageForgot.locator('form input[type="email"]').fill(inbox.address);
    await pageForgot.getByRole("button", { name: "Send reset link" }).click();
    const forgotConfirmed = await pageForgot.getByText(/a password reset/i).isVisible({ timeout: 10000 }).catch(() => false);
    assert(forgotConfirmed, "requestPasswordReset: UI confirmed sent");
    assert(forgotEvents.failedRequests.length === 0, "forgot-password flow: zero failed network requests");

    console.log("  Waiting for the password-reset email to actually arrive...");
    const resetMsg = await waitForMessage(inbox.token, { after: forgotStart, subjectIncludes: "Reset your FGC Ranks password" });
    const resetLink = extractFirstLink(resetMsg);
    console.log(`  reset email link: ${resetLink}`);
    assert(!!resetLink, "password-reset email received with a link");
    assert(resetLink?.startsWith("https://www.fgc-ranks.com/reset-password?token="), "reset link points to https://www.fgc-ranks.com (not localhost/bare apex)");

    const ctxResetClick = await browser.newContext();
    const pageResetClick = await ctxResetClick.newPage();
    const resetClickEvents = instrumentPage(pageResetClick, "reset-password click-through (fresh context)");
    await pageResetClick.goto(resetLink, { waitUntil: "domcontentloaded" });
    const resetFormVisible = await pageResetClick.locator('form input[type="password"]').first().isVisible({ timeout: 10000 }).catch(() => false);
    assert(resetFormVisible, "reset-password link click-through: form rendered, no errors");
    if (resetFormVisible) {
      const pwFields = pageResetClick.locator('form input[type="password"]');
      await pwFields.nth(0).fill("NewSup3rSecret!42");
      await pwFields.nth(1).fill("NewSup3rSecret!42");
      await pageResetClick.getByRole("button", { name: /update password/i }).click().catch(() => {});
      await pageResetClick.waitForTimeout(2000);
    }
    assert(resetClickEvents.failedRequests.length === 0, "reset-password click-through: zero failed network requests");
    assert(resetClickEvents.consoleErrors.filter(e => /cors|cross-origin|preflight/i.test(e)).length === 0, "reset-password click-through: zero CORS-related console errors");
    await ctxResetClick.close();
    await ctxForgot.close();

    // ---------------- Step 3: Duplicate-email registration (CORS theory) --
    // This is the one flow that genuinely needs the real /register UI (and
    // therefore real Turnstile) since it's specifically about what happens
    // when RegisterForm.tsx's client-side fetch runs against production.
    console.log("\n=== Step 3: Reproduce duplicate-email registration via real /register UI ===");
    const ctxDup = await browser.newContext();
    const pageDup = await ctxDup.newPage();
    const dupEvents = instrumentPage(pageDup, "duplicate-email register attempt");
    await pageDup.goto(`${SITE}/register`, { waitUntil: "domcontentloaded" });
    await pageDup.locator('form input[type="text"]').fill(`DupTag${Date.now() % 100000}`);
    await pageDup.locator('form input[type="email"]').fill(inbox.address); // already registered
    await pageDup.locator('form input[type="password"]').fill("Sup3rSecret!42");

    const token = await waitForTurnstileToken(pageDup);
    assert(!!token, "Turnstile resolved for duplicate-email registration attempt");

    if (token) {
      await pageDup.getByRole("button", { name: "Create account" }).click();
      await pageDup.waitForTimeout(2500);
    }

    const dupErrorText = await pageDup.locator("form p").first().textContent().catch(() => null);
    const genericShown = await pageDup.getByText("Something went wrong. Please try again.").isVisible().catch(() => false);
    const specificShown = await pageDup.getByText("This email is already registered").isVisible().catch(() => false);
    const captchaFailShown = await pageDup.getByText("CAPTCHA verification failed").isVisible().catch(() => false);

    const dupCall = dupEvents.graphqlCalls[dupEvents.graphqlCalls.length - 1];
    console.log(`  network: ${dupEvents.graphqlCalls.length} /api/graphql response(s) captured, ${dupEvents.failedRequests.length} failed request(s)`);
    if (dupCall) {
      console.log(`  register call status: ${dupCall.status}`);
      console.log(`  register call response headers: ${JSON.stringify(dupCall.headers)}`);
      console.log(`  register call body: ${dupCall.body?.slice(0, 500)}`);
    } else {
      console.log("  NO /api/graphql response was ever observed for this attempt.");
    }
    if (dupEvents.failedRequests.length) {
      console.log(`  FAILED requests: ${JSON.stringify(dupEvents.failedRequests)}`);
    }
    console.log(`  rendered error text: "${dupErrorText}"`);
    console.log(`  CORS-related console errors: ${JSON.stringify(dupEvents.consoleErrors.filter(e => /cors|cross-origin|preflight/i.test(e)))}`);

    console.log("\n=== VERDICT ===");
    if (!token) {
      console.log("Turnstile could not be resolved by this automated session within the timeout, so the register");
      console.log("mutation was never actually submitted -- the duplicate-email path was NOT reached this run.");
      console.log("No conclusion either way from this step; see Steps 1-2 for the parts that WERE verified.");
    } else {
      assert(dupEvents.failedRequests.length === 0, "duplicate-email attempt: register fetch did NOT fail at the network level (no CORS/preflight block)");
      assert(!!dupCall && dupCall.status === 200, "duplicate-email attempt: register call returned a normal 200 same-origin response");
      if (captchaFailShown) {
        console.log("Server rejected the CAPTCHA token (stale/single-use) before reaching the duplicate-email check.");
        console.log("Still meaningful: the fetch itself completed same-origin with a normal 200 GraphQL-error response --");
        console.log("proves no CORS/preflight failure on this exact call, which is what the theory hinged on.");
      } else {
        assert(specificShown && !genericShown, "duplicate-email attempt: UI shows the SPECIFIC \"already registered\" message, not the generic catch-all");
        if (dupEvents.failedRequests.length === 0 && dupCall?.status === 200 && specificShown) {
          console.log("Duplicate-email CORS theory: RULED OUT. The register fetch completed as a normal same-origin");
          console.log("200 response; the server-thrown \"This email is already registered\" message reached the UI");
          console.log("intact. No CORS/preflight failure occurred -- confirms 179bfba's relative-path fix (RegisterForm.tsx");
          console.log("is one of the 6 files) makes this class of bug structurally impossible now.");
        } else if (dupEvents.failedRequests.length > 0 || genericShown) {
          console.log("Duplicate-email CORS theory: STILL REPRODUCING as a network-level failure or generic error.");
          console.log("This is a live bug distinct from what 179bfba fixed -- needs investigation.");
        }
      }
    }

    await ctxDup.close();
  } finally {
    await browser.close();
    // Clean up the disposable test account.
    await User.findByIdAndDelete(user._id);
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error("Script error:", err);
  process.exit(1);
});
