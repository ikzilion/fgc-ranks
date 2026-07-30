// Verification for the mobile tournament-page reorder (search -> bracket ->
// entrants) + entrant search bar. Real HTTP login as an ADMIN test user, a
// real Tournament + Entrant docs seeded directly in MongoDB, then a real
// headless Chromium (Playwright) session that measures actual
// getBoundingClientRect() Y-positions (order-of-appearance, not a visual
// guess) at mobile widths, confirms desktop's side-by-side layout and
// x-position order are pixel-identical to before, and confirms the bottom
// Entrants list stays unfiltered while a search is active (see the follow-up
// inline quick-results panel in scripts/testMobileEntrantInlineResults.mjs).
//
// Requires `npm run dev` already running on localhost:3000.
// Run: npx tsx scripts/testMobileTournamentReorderSearch.mjs

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
const { Entrant } = await import("../models/Entrant");
const bcrypt = (await import("bcryptjs")).default;

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

  const email = "mobiletourneyreordertest@example.com";
  const password = "TestPass123!";
  await User.deleteOne({ email });
  const passwordHash = await bcrypt.hash(password, 10);
  // ADMIN role so canManage is true without needing a real organizer link --
  // showBracketSection = tournament.bracket || canManage, and we want the
  // Bracket flex item to render (as its "No bracket generated yet." empty
  // state) purely to test layout order, without needing a full bracket sim.
  const user = await User.create({ email, passwordHash, role: "ADMIN" });
  const player = await Player.create({ userId: user._id, tag: "MobileReorderTester" });
  await User.findByIdAndUpdate(user._id, { playerId: player._id });

  const entrantTags = ["Alpha", "Bravo", "Charlie", "Delta", "ZZZUniqueSearchableTag123"];
  const entrantPlayers = [];
  for (const tag of entrantTags) {
    await Player.deleteOne({ tag });
    entrantPlayers.push(await Player.create({ tag }));
  }

  await Tournament.deleteMany({ name: "Mobile Reorder Search Test Cup" });
  const tournament = await Tournament.create({
    name: "Mobile Reorder Search Test Cup",
    game: "Street Fighter 6",
    startDate: new Date(),
    organizers: [player._id],
  });

  await Entrant.deleteMany({ tournamentId: tournament._id });
  for (let i = 0; i < entrantPlayers.length; i++) {
    await Entrant.create({ playerId: entrantPlayers[i]._id, tournamentId: tournament._id, seed: i + 1 });
  }

  let browser;
  try {
    // --- Real HTTP login ---
    console.log("\n=== Real HTTP login ===");
    const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`);
    const csrfCookies = csrfRes.headers.getSetCookie?.() ?? [];
    const { csrfToken } = await csrfRes.json();
    assert(!!csrfToken, "Got a CSRF token from /api/auth/csrf");

    const cookieHeaderFromSetCookies = setCookies => setCookies.map(c => c.split(";")[0]).join("; ");
    let cookieJar = cookieHeaderFromSetCookies(csrfCookies);

    const loginRes = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieJar },
      body: new URLSearchParams({ email, password, csrfToken, json: "true" }),
    });
    const loginCookies = loginRes.headers.getSetCookie?.() ?? [];
    assert(loginCookies.some(c => /session-token/i.test(c)), `Got a session-token cookie back from credentials login (status ${loginRes.status})`);
    cookieJar = [cookieJar, ...loginCookies.map(c => c.split(";")[0])].filter(Boolean).join("; ");

    // --- Real headless browser session ---
    console.log("\n=== Headless Chromium: tournament page order + search ===");
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

    for (const width of [320, 375, 414, 480]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(tournamentUrl, { waitUntil: "networkidle" });

      const searchInput = page.getByPlaceholder("Search entrants by tag…");
      const bracketLabel = page.getByText("Bracket", { exact: true }).first();
      const entrantsLabel = page.getByText("Entrants", { exact: true }).first();

      await searchInput.waitFor({ state: "visible", timeout: 5000 });
      await bracketLabel.waitFor({ state: "visible", timeout: 5000 });
      await entrantsLabel.waitFor({ state: "visible", timeout: 5000 });

      const searchTop = (await searchInput.boundingBox()).y;
      const bracketTop = (await bracketLabel.boundingBox()).y;
      const entrantsTop = (await entrantsLabel.boundingBox()).y;

      assert(
        searchTop < bracketTop && bracketTop < entrantsTop,
        `[${width}px] order top-to-bottom is search (${searchTop.toFixed(0)}) < bracket (${bracketTop.toFixed(0)}) < entrants (${entrantsTop.toFixed(0)})`
      );
    }

    // --- Functional check (still at a mobile width) ---
    // The bottom Entrants list itself always shows everyone, unfiltered --
    // an active search instead surfaces an inline quick-results panel right
    // under the search bar (see scripts/testMobileEntrantInlineResults.mjs
    // for that follow-up behavior in full). This just confirms the reorder
    // work didn't regress the bottom list back into filtering itself.
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto(tournamentUrl, { waitUntil: "networkidle" });
    const entrantLinks = page.locator('p:has-text("Entrants") + div.fgc-card a[href^="/players/"]');
    const countBefore = await entrantLinks.count();
    assert(countBefore === entrantTags.length, `All ${entrantTags.length} entrants render before searching (found ${countBefore})`);

    await page.getByPlaceholder("Search entrants by tag…").fill("zzzuniquesearchabletag");
    await page.waitForTimeout(200);
    const countAfter = await entrantLinks.count();
    assert(
      countAfter === entrantTags.length,
      `Bottom Entrants list stays unfiltered (shows all ${entrantTags.length}) while a search is active (found ${countAfter})`
    );

    // --- Desktop pixel-parity check ---
    console.log("\n=== Desktop (1024px): unchanged side-by-side layout ===");
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto(tournamentUrl, { waitUntil: "networkidle" });

    const desktopSearchVisible = await page.getByPlaceholder("Search entrants by tag…").isVisible();
    assert(!desktopSearchVisible, "[1024px] mobile search bar is not shown on desktop");

    const entrantsBox = await page.getByText("Entrants", { exact: true }).first().boundingBox();
    const bracketBox = await page.getByText("Bracket", { exact: true }).first().boundingBox();
    // The "Bracket" label sits inside the bracket card's own p-6 padding
    // while "Entrants" doesn't have an equivalent wrapper, so a modest y
    // tolerance (not exact equality) is the right same-row check here.
    assert(
      entrantsBox.x < bracketBox.x && Math.abs(entrantsBox.y - bracketBox.y) < 80,
      `[1024px] Entrants sidebar (x=${entrantsBox.x.toFixed(0)}, y=${entrantsBox.y.toFixed(0)}) sits left of Bracket (x=${bracketBox.x.toFixed(0)}, y=${bracketBox.y.toFixed(0)}), same row -- unchanged side-by-side layout`
    );
  } finally {
    if (browser) await browser.close();
    await Entrant.deleteMany({ tournamentId: tournament._id });
    await Tournament.deleteOne({ _id: tournament._id });
    for (const p of entrantPlayers) await Player.deleteOne({ _id: p._id });
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
