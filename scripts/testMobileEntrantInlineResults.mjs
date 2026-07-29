// Verification for the mobile entrant-search follow-up: when there's an
// active search query on mobile, matching entrants should render directly
// below the search bar (a compact inline results panel) instead of only
// updating the full Entrants list at the bottom, which would still require
// scrolling past the bracket. Confirms:
//   1. Typing a real tag substring makes the inline panel appear directly
//      under the search input, showing only the matching entrant(s).
//   2. Clearing the query removes the inline panel entirely (no empty state).
//   3. The bottom Entrants list always shows every entrant, unfiltered,
//      throughout (query empty, active, and cleared again).
//
// Requires `npm run dev` already running on localhost:3000.
// Run: npx tsx scripts/testMobileEntrantInlineResults.mjs

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

  const email = "mobileinlineresultstest@example.com";
  const password = "TestPass123!";
  await User.deleteOne({ email });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ email, passwordHash, role: "ADMIN" });
  const player = await Player.create({ userId: user._id, tag: "InlineResultsTester" });
  await User.findByIdAndUpdate(user._id, { playerId: player._id });

  const entrantTags = ["Alpha", "Bravo", "Charlie", "Delta", "ZZZUniqueSearchableTag123"];
  const entrantPlayers = [];
  for (const tag of entrantTags) {
    await Player.deleteOne({ tag });
    entrantPlayers.push(await Player.create({ tag }));
  }

  await Tournament.deleteMany({ name: "Mobile Inline Results Test Cup" });
  const tournament = await Tournament.create({
    name: "Mobile Inline Results Test Cup",
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
    console.log("\n=== Headless Chromium at 375px: inline quick-results panel ===");
    browser = await chromium.launch();
    const context = await browser.newContext();
    const cookiePairs = cookieJar.split("; ").map(pair => {
      const idx = pair.indexOf("=");
      return { name: pair.slice(0, idx), value: pair.slice(idx + 1) };
    });
    const url = new URL(BASE_URL);
    await context.addCookies(cookiePairs.map(c => ({ ...c, domain: url.hostname, path: "/" })));

    const page = await context.newPage();
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto(`${BASE_URL}/tournaments/${tournament._id}`, { waitUntil: "networkidle" });

    const searchInput = page.getByPlaceholder("Search entrants by tag…");
    await searchInput.waitFor({ state: "visible", timeout: 5000 });

    const bottomListLinks = page.locator('p:has-text("Entrants") + div.fgc-card a[href^="/players/"]');
    const inlinePanelLinks = page.locator('input[placeholder="Search entrants by tag…"] ~ div.fgc-card a[href^="/players/"]');

    // 1. Empty query: no inline panel at all.
    const inlineCountEmpty = await inlinePanelLinks.count();
    assert(inlineCountEmpty === 0, `No inline results panel with an empty query (found ${inlineCountEmpty} rows)`);
    const bottomCountEmpty = await bottomListLinks.count();
    assert(bottomCountEmpty === entrantTags.length, `Bottom list shows all ${entrantTags.length} entrants with an empty query (found ${bottomCountEmpty})`);

    // 2. Active, non-empty query: inline panel appears directly under the
    // search input with only the matching entrant, positioned above the
    // bracket -- and the bottom list still shows everyone.
    await searchInput.fill("zzzuniquesearchabletag");
    await page.waitForTimeout(200);

    const inlineCountActive = await inlinePanelLinks.count();
    const inlineText = inlineCountActive > 0 ? await inlinePanelLinks.first().innerText() : "";
    assert(
      inlineCountActive === 1 && inlineText.includes("ZZZUniqueSearchableTag123"),
      `Inline panel shows exactly the matching entrant right under the search bar (count=${inlineCountActive}, text="${inlineText.split("\n")[0]}")`
    );

    const searchBox = await searchInput.boundingBox();
    const inlineBox = await inlinePanelLinks.first().boundingBox();
    const bracketBox = await page.getByText("Bracket", { exact: true }).first().boundingBox();
    assert(
      inlineBox.y > searchBox.y && inlineBox.y < bracketBox.y,
      `Inline result (y=${inlineBox.y.toFixed(0)}) renders between the search bar (y=${searchBox.y.toFixed(0)}) and the bracket (y=${bracketBox.y.toFixed(0)}), no scrolling past the bracket needed`
    );

    const bottomCountActive = await bottomListLinks.count();
    assert(
      bottomCountActive === entrantTags.length,
      `Bottom list still shows all ${entrantTags.length} entrants while a search is active, unfiltered (found ${bottomCountActive})`
    );

    // 3. Clearing the query removes the inline panel entirely (no empty
    // state), and the bottom list is unaffected throughout.
    await searchInput.fill("");
    await page.waitForTimeout(200);
    const inlineCountCleared = await inlinePanelLinks.count();
    assert(inlineCountCleared === 0, `Inline results panel disappears entirely once the query is cleared (found ${inlineCountCleared} rows)`);
    const bottomCountCleared = await bottomListLinks.count();
    assert(bottomCountCleared === entrantTags.length, `Bottom list still shows all ${entrantTags.length} entrants after clearing (found ${bottomCountCleared})`);

    // 4. A query with zero matches shows the inline "no match" message, not
    // an empty invisible panel or a crash.
    await searchInput.fill("nonexistenttagxyz");
    await page.waitForTimeout(200);
    const noMatchText = await page.getByText("No entrants match your search.").first().isVisible();
    assert(noMatchText, "Inline panel shows a 'no match' message for a query with zero hits");
    const bottomCountNoMatch = await bottomListLinks.count();
    assert(bottomCountNoMatch === entrantTags.length, `Bottom list is still unaffected during a zero-match search (found ${bottomCountNoMatch})`);
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
