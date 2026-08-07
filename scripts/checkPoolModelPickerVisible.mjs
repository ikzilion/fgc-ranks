// scripts/checkPoolModelPickerVisible.mjs
//
// One-off check: the user reported that creating a tournament only shows a
// Format dropdown with 2 options (Standard Bracket / Pools + Bracket) and no
// Pool Model (A/B/C) picker at all. Code review of CreateTournamentButton.tsx
// shows a "Pool stage model" section gated on format === "Pools + Bracket"
// (added commit 0869fda, July 24, 2026, present on main/HEAD) -- this
// contradicts the report, so checking the REAL rendered DOM against
// production directly rather than trusting either the code read or the
// report.
//
// Real HTTP login (disposable test account created directly in Mongo, same
// as scripts/checkFormatInfoTooltip.mjs) + real headless Chromium against
// production, not a DOM snapshot guess.
//
// Run: npx tsx scripts/checkPoolModelPickerVisible.mjs

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

const { connectToDatabase } = await import("../lib/db.ts");
const { User } = await import("../models/User.ts");
const { Player } = await import("../models/Player.ts");
const bcrypt = (await import("bcryptjs")).default;
const mongoose = (await import("mongoose")).default;

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  OK   ${label}`);
  } else {
    console.log(`  FAIL ${label}`);
    failures++;
  }
}

async function main() {
  await connectToDatabase();

  const email = "poolmodelpickertest@example.com";
  const password = "TestPass123!";
  await User.deleteOne({ email });
  await Player.deleteOne({ tag: "PoolModelPickerTester" });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ email, passwordHash });
  const player = await Player.create({ userId: user._id, tag: "PoolModelPickerTester" });
  await User.findByIdAndUpdate(user._id, { playerId: player._id });

  let browser;
  try {
    console.log("=== Real HTTP login against production ===");
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
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${BASE_URL}/tournaments`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "+ New tournament" }).click();

    console.log("\n=== Before selecting a format ===");
    const poolModelHeading = page.getByText("Pool stage model");
    assert(!(await poolModelHeading.isVisible()), '"Pool stage model" section absent before picking a format (expected)');

    console.log("\n=== After selecting 'Pools + Bracket' in the Format dropdown ===");
    const formatSelect = page.locator("select").filter({ has: page.locator("option", { hasText: "Pools + Bracket" }) });
    await formatSelect.selectOption("Pools + Bracket");
    await page.waitForTimeout(300);
    assert(await poolModelHeading.isVisible(), '"Pool stage model" section appears after selecting Pools + Bracket');

    const modelA = page.getByText("Model A — Round-robin pools");
    const modelB = page.getByText("Model B — Continuous carry-over");
    const modelC = page.getByText("Model C — Double-elim pools (default)");
    assert(await modelA.isVisible(), "Model A option visible");
    assert(await modelB.isVisible(), "Model B option visible");
    assert(await modelC.isVisible(), "Model C option visible");

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  } finally {
    if (browser) await browser.close();
    await User.deleteOne({ email });
    await Player.deleteOne({ tag: "PoolModelPickerTester" });
    await mongoose.disconnect();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async err => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
