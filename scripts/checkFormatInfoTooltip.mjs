// scripts/checkFormatInfoTooltip.mjs
//
// One-off functional verification for the Format-dropdown info tooltips on
// CreateTournamentButton (hover on desktop via pure CSS group-hover, tap-to-
// toggle on touch devices via onClick). Real HTTP login + real headless
// Chromium session against the actual dev server, not a DOM snapshot guess.
//
// Requires `npm run dev` already running on localhost:3000.
// Run: npx tsx scripts/checkFormatInfoTooltip.mjs

import fs from "fs";
import path from "path";
import { chromium } from "playwright";

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

const STANDARD_TEXT = "Every entrant goes straight into one double-elimination bracket. Best for smaller events — works well up to a few hundred entrants, but with a large field, everyone has to wait through many rounds before eliminations really thin out.";
const POOLS_TEXT = "Entrants are split into smaller pools first, each playing out as its own mini double-elimination bracket. The top 2 finishers from each pool then advance into a final bracket. This gets everyone playing matches faster in a large tournament, and finishes the same way EVO and CEO run big brackets.";

async function main() {
  await connectToDatabase();

  const email = "formattooltiptest@example.com";
  const password = "TestPass123!";
  await User.deleteOne({ email });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ email, passwordHash });
  const player = await Player.create({ userId: user._id, tag: "FormatTooltipTester" });
  await User.findByIdAndUpdate(user._id, { playerId: player._id });

  let browser;
  try {
    console.log("\n=== Real HTTP login ===");
    const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`);
    const csrfCookies = csrfRes.headers.getSetCookie?.() ?? [];
    const { csrfToken } = await csrfRes.json();
    let cookieJar = csrfCookies.map(c => c.split(";")[0]).join("; ");

    const loginRes = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieJar },
      body: new URLSearchParams({ email, password, csrfToken, json: "true" }),
    });
    const loginCookies = loginRes.headers.getSetCookie?.() ?? [];
    assert(loginCookies.some(c => /session-token/i.test(c)), `Got a session-token cookie back from credentials login (status ${loginRes.status})`);
    cookieJar = [cookieJar, ...loginCookies.map(c => c.split(";")[0])].filter(Boolean).join("; ");

    browser = await chromium.launch();
    const context = await browser.newContext();
    const cookiePairs = cookieJar.split("; ").map(pair => {
      const idx = pair.indexOf("=");
      return { name: pair.slice(0, idx), value: pair.slice(idx + 1) };
    });
    const url = new URL(BASE_URL);
    await context.addCookies(cookiePairs.map(c => ({ ...c, domain: url.hostname, path: "/" })));

    const page = await context.newPage();

    console.log("\n=== Desktop: hover shows the right text, nothing else ===");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${BASE_URL}/tournaments`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "+ New tournament" }).click();

    const standardIcon = page.getByRole("button", { name: "What is Standard Bracket?" });
    const poolsIcon = page.getByRole("button", { name: "What is Pools + Bracket?" });
    await standardIcon.waitFor({ state: "visible" });
    assert(await poolsIcon.isVisible(), "Both format info icons are present in the modal");

    const standardText = page.getByText(STANDARD_TEXT, { exact: true });
    const poolsText = page.getByText(POOLS_TEXT, { exact: true });
    assert(!(await standardText.isVisible()) && !(await poolsText.isVisible()), "Neither explanation is visible before any interaction");

    await standardIcon.hover();
    assert(await standardText.isVisible(), "Hovering the Standard Bracket icon reveals its exact explanation text");
    assert(!(await poolsText.isVisible()), "Hovering Standard Bracket does NOT reveal the Pools + Bracket text");

    await poolsIcon.hover();
    assert(await poolsText.isVisible(), "Hovering the Pools + Bracket icon reveals its exact explanation text");

    // Move away from both icons -- hover-only visibility should end (no
    // click ever happened, so nothing should be pinned open).
    await page.mouse.move(10, 10);
    assert(!(await standardText.isVisible()) && !(await poolsText.isVisible()), "Moving the mouse away hides both (neither was click-pinned)");

    console.log("\n=== Mobile (375px): tap-to-toggle works where hover doesn't apply ===");
    await page.setViewportSize({ width: 375, height: 800 });
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "+ New tournament" }).click();

    const standardIconMobile = page.getByRole("button", { name: "What is Standard Bracket?" });
    const standardTextMobile = page.getByText(STANDARD_TEXT, { exact: true });
    await standardIconMobile.waitFor({ state: "visible" });
    assert(!(await standardTextMobile.isVisible()), "Mobile: explanation hidden before tapping");

    // .click() (not .hover()) simulates a touch tap -- exercises the onClick
    // toggle path independent of any hover state.
    await standardIconMobile.click();
    assert(await standardTextMobile.isVisible(), "Mobile: tapping the info icon reveals the explanation (tap-to-toggle works)");

    await standardIconMobile.click();
    assert(!(await standardTextMobile.isVisible()), "Mobile: tapping the same icon again hides it (toggle, not just reveal)");

    // A narrow viewport with .click() still dispatches real (non-touch)
    // mouse events -- rule out any touch-specific quirk (e.g. a mobile
    // browser's synthetic hover-before-click on first tap) by using an
    // actually touch-enabled browser context and .tap(), which Chromium
    // dispatches as genuine touch events.
    console.log("\n=== Real touch-enabled context: .tap() behaves the same as .click() ===");
    const touchContext = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 800 } });
    await touchContext.addCookies(cookiePairs.map(c => ({ ...c, domain: url.hostname, path: "/" })));
    const touchPage = await touchContext.newPage();
    await touchPage.goto(`${BASE_URL}/tournaments`, { waitUntil: "networkidle" });
    await touchPage.getByRole("button", { name: "+ New tournament" }).click();

    const poolsIconTouch = touchPage.getByRole("button", { name: "What is Pools + Bracket?" });
    const poolsTextTouch = touchPage.getByText(POOLS_TEXT, { exact: true });
    await poolsIconTouch.waitFor({ state: "visible" });
    assert(!(await poolsTextTouch.isVisible()), "Touch: explanation hidden before the first tap");

    await poolsIconTouch.tap();
    assert(await poolsTextTouch.isVisible(), "Touch: a single real tap opens it (no double-tap-required ghost-hover quirk)");

    await poolsIconTouch.tap();
    assert(!(await poolsTextTouch.isVisible()), "Touch: tapping again closes it");
    await touchContext.close();

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`}`);
  } finally {
    if (browser) await browser.close();
    console.log("\nCleaning up test data...");
    await Player.deleteOne({ tag: "FormatTooltipTester" });
    await User.deleteOne({ email });
    console.log("Cleanup done.");
  }

  process.exit(failures === 0 ? 0 : 1);
}

main();
