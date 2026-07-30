// Verification for the TournamentManageTabs overflow-indicator chevron: a
// subtle chevron-right (no gradient/fade) should appear at the tab bar's
// right edge only when it's actually horizontally scrollable and not yet
// scrolled to the end, and never at all when the tabs already fit.
//
// Real HTTP login as an ADMIN test user (canManage, so TournamentManageTabs
// renders at all) + a real Tournament seeded in MongoDB, then a real
// headless Chromium (Playwright) session measuring actual scrollWidth vs
// clientWidth / chevron visibility -- not a screenshot.
//
// Requires `npm run dev` already running on localhost:3000.
// Run: npx tsx scripts/testMobileTabBarOverflowArrow.mjs

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
const { Tournament } = await import("../models/Tournament");
const bcrypt = (await import("bcryptjs")).default;

// Scoped to the tab bar's own "relative" wrapper (Overview button's
// grandparent), not a page-wide selector -- Navbar's own overflow chevron
// (added in a later follow-up) uses this exact same chevron-right path, so
// an unscoped selector would ambiguously match both on this page.
async function isTabBarChevronVisible(page) {
  return page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent?.trim() === "Overview");
    const wrapper = btn?.parentElement?.parentElement;
    return !!wrapper?.querySelector('svg path[d="M9 6l6 6-6 6"]');
  });
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

  const email = "tabbaroverflowtest@example.com";
  const password = "TestPass123!";
  await User.deleteOne({ email });
  const user = await User.create({ email, passwordHash: await bcrypt.hash(password, 10), role: "ADMIN" });
  const player = await Player.create({ userId: user._id, tag: "TabBarOverflowTester" });
  await User.findByIdAndUpdate(user._id, { playerId: player._id });

  await Tournament.deleteMany({ name: "TabBar Overflow Arrow Test Cup" });
  const tournament = await Tournament.create({
    name: "TabBar Overflow Arrow Test Cup",
    game: "Street Fighter 6",
    startDate: new Date(),
    organizers: [player._id],
  });

  let browser;
  try {
    console.log("\n=== Real HTTP login ===");
    const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`);
    const csrfCookies = csrfRes.headers.getSetCookie?.() ?? [];
    const { csrfToken } = await csrfRes.json();
    assert(!!csrfToken, "Got a CSRF token from /api/auth/csrf");

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

    console.log("\n=== Headless Chromium: tab bar overflow chevron ===");
    browser = await chromium.launch();
    const context = await browser.newContext();
    const cookiePairs = cookieJar.split("; ").map(pair => {
      const idx = pair.indexOf("=");
      return { name: pair.slice(0, idx), value: pair.slice(idx + 1) };
    });
    const url = new URL(BASE_URL);
    await context.addCookies(cookiePairs.map(c => ({ ...c, domain: url.hostname, path: "/" })));

    const page = await context.newPage();
    const tournamentUrl = `${BASE_URL}/tournaments/${tournament._id}`;

    // --- Narrow enough to force real overflow (found via direct
    // scrollWidth/clientWidth measurement: 3 short tab labels only start
    // overflowing below ~230-250px -- rare on a real device at default
    // font size, but exactly the scenario a user with larger accessibility
    // text settings, or a genuinely tiny viewport, would hit). ---
    await page.setViewportSize({ width: 220, height: 800 });
    await page.goto(tournamentUrl, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Overview" }).waitFor({ state: "visible", timeout: 5000 });

    const scrollInfo = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent?.trim() === "Overview");
      const el = btn?.parentElement;
      return el ? { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth } : null;
    });
    assert(
      !!scrollInfo && scrollInfo.scrollWidth > scrollInfo.clientWidth,
      `[220px] tab bar actually overflows (scrollWidth=${scrollInfo?.scrollWidth}, clientWidth=${scrollInfo?.clientWidth})`
    );

    const chevronVisibleAtStart = await isTabBarChevronVisible(page);
    assert(chevronVisibleAtStart, "[220px] chevron is visible when the tab bar overflows and isn't scrolled to the end");

    // Scroll the tab bar container all the way to its end -- real scrollLeft
    // assignment (fires a genuine 'scroll' event React's onScroll picks up).
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent?.trim() === "Overview");
      const el = btn?.parentElement;
      if (el) el.scrollLeft = el.scrollWidth - el.clientWidth;
    });
    await page.waitForTimeout(150);
    const chevronVisibleAtEnd = await isTabBarChevronVisible(page);
    assert(!chevronVisibleAtEnd, "[220px] chevron disappears once the tab bar is scrolled all the way to the end");

    // --- A normal mobile width where 3 short tab labels fit fine ---
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(tournamentUrl, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Overview" }).waitFor({ state: "visible", timeout: 5000 });
    const fitInfo = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent?.trim() === "Overview");
      const el = btn?.parentElement;
      return el ? { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth } : null;
    });
    assert(
      !!fitInfo && fitInfo.scrollWidth <= fitInfo.clientWidth + 1,
      `[375px] tabs fit without overflowing (scrollWidth=${fitInfo?.scrollWidth}, clientWidth=${fitInfo?.clientWidth})`
    );
    const chevronAt375 = await isTabBarChevronVisible(page);
    assert(!chevronAt375, "[375px] chevron never renders when the tabs already fit");

    // --- Desktop: completely unaffected ---
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.goto(tournamentUrl, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Overview" }).waitFor({ state: "visible", timeout: 5000 });
    const chevronAt1024 = await isTabBarChevronVisible(page);
    assert(!chevronAt1024, "[1024px] chevron never renders on desktop");

    await page.getByRole("button", { name: "Manage" }).click();
    const manageTabVisible = await page.getByText("Add tournament organizers", { exact: false }).first().isVisible().catch(() => false);
    // Loose check -- just confirms tab switching still functions normally
    // after the TabBar's internal changes, not the exact Manage panel copy.
    const editButtonVisible = await page.getByRole("button", { name: /edit/i }).first().isVisible().catch(() => false);
    assert(manageTabVisible || editButtonVisible, "[1024px] clicking a tab still switches panels normally");
  } finally {
    if (browser) await browser.close();
    await Tournament.deleteOne({ _id: tournament._id });
    await Player.deleteOne({ _id: player._id });
    await User.deleteOne({ _id: user._id });
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
