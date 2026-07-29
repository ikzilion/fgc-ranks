// Functional verification for the site-wide color theme system (settled
// July 29, 2026, see lib/theme.ts). Real HTTP login, real setActiveTheme
// mutations, and a real fetch of the actual rendered homepage/tournament
// page HTML -- not a mock. Confirms:
//   1. The homepage renders the default theme's exact palette values
//      (inline style on <html>) before any change.
//   2. A Super Admin can switch to the "orange" theme, and it actually
//      takes effect on BOTH the homepage and a real tournament page.
//   3. A regular player and a regular (non-super) Admin are both REJECTED
//      when attempting setActiveTheme -- and the site-wide setting is
//      confirmed unchanged by their attempts.
//   4. Switching back to "default" restores the EXACT original palette
//      (byte-for-byte match against the values captured in step 1), not
//      just "close enough".
//
// Restores the real site-wide theme to "default" in a finally block
// regardless of pass/fail, since this is real shared site state.
//
// Requires `npm run dev` already running on localhost:3000.
// Run: npx tsx scripts/testColorTheme.mjs

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnvLocal();
if (!process.env.MONGODB_URI) throw new Error("Missing MONGODB_URI (checked .env.local)");

const { connectToDatabase } = await import("../lib/db");
const { User } = await import("../models/User");
const { Player } = await import("../models/Player");
const { Tournament } = await import("../models/Tournament");
const { SiteSettings } = await import("../models/SiteSettings");
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

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }
  applySetCookies(headers) {
    for (const raw of headers ?? []) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function httpLogin(email, password, syntheticIp) {
  const jar = new CookieJar();
  const ipHeaders = { "x-forwarded-for": syntheticIp };
  const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`, { headers: ipHeaders });
  jar.applySetCookies(csrfRes.headers.getSetCookie?.());
  const { csrfToken } = await csrfRes.json();
  const loginRes = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.header(), ...ipHeaders },
    body: new URLSearchParams({ email, password, csrfToken, json: "true" }),
  });
  jar.applySetCookies(loginRes.headers.getSetCookie?.());
  return jar;
}

async function gql(query, variables, cookieJar) {
  const res = await fetch(`${BASE_URL}/api/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookieJar ? { Cookie: cookieJar.header() } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

// Pulls the inline style="" attribute value off the <html ...> tag in raw
// page HTML -- this is where app/layout.tsx applies the active theme's CSS
// custom properties.
function extractHtmlTagStyle(html) {
  const match = html.match(/<html[^>]*\sstyle="([^"]*)"/);
  return match ? match[1] : null;
}

async function main() {
  await connectToDatabase();

  const superAdminEmail = "themetest-superadmin@example.com";
  const adminEmail = "themetest-admin@example.com";
  const playerEmail = "themetest-player@example.com";
  const password = "TestPass123!";

  for (const e of [superAdminEmail, adminEmail, playerEmail]) await User.deleteOne({ email: e });
  const passwordHash = await bcrypt.hash(password, 10);

  const superAdminUser = await User.create({ email: superAdminEmail, passwordHash, role: "SUPER_ADMIN" });
  const superAdminPlayer = await Player.create({ userId: superAdminUser._id, tag: "ThemeTestSuperAdmin" });
  await User.findByIdAndUpdate(superAdminUser._id, { playerId: superAdminPlayer._id });

  const adminUser = await User.create({ email: adminEmail, passwordHash, role: "ADMIN" });
  const adminPlayer = await Player.create({ userId: adminUser._id, tag: "ThemeTestAdmin" });
  await User.findByIdAndUpdate(adminUser._id, { playerId: adminPlayer._id });

  const playerUser = await User.create({ email: playerEmail, passwordHash });
  const player = await Player.create({ userId: playerUser._id, tag: "ThemeTestPlayer" });
  await User.findByIdAndUpdate(playerUser._id, { playerId: player._id });

  let tournament;

  // Capture whatever the theme actually was before this test touched
  // anything, so we can restore it exactly at the end -- this is real
  // shared site state, not test-scoped data.
  const originalSettings = await SiteSettings.findById("siteSettings");
  const originalThemeId = originalSettings?.activeTheme ?? "default";

  try {
    tournament = await Tournament.create({
      name: "Theme Test Tournament",
      game: "Test Game",
      format: "Standard Bracket",
      organizers: [superAdminPlayer._id],
      startDate: new Date(),
      entrantCount: 0,
    });

    // === Baseline: default theme's real values on a real page, before any change ===
    console.log("\n=== Baseline: default theme renders on the real homepage ===");
    // Force to a known baseline first, regardless of whatever it was before.
    await SiteSettings.findByIdAndUpdate("siteSettings", { activeTheme: "default" }, { upsert: true });

    const homeRes1 = await fetch(`${BASE_URL}/`, { cache: "no-store" });
    const homeHtml1 = await homeRes1.text();
    assert(homeRes1.status === 200, `Homepage rendered (status ${homeRes1.status})`);
    const defaultStyle = extractHtmlTagStyle(homeHtml1);
    assert(!!defaultStyle, "Found the inline style attribute on <html>");
    assert(defaultStyle?.includes("--navy:#0D0F1A") && defaultStyle?.includes("--blue:#4F8EF7"), `Default theme's real palette values are present (got: ${defaultStyle})`);

    // === Real GraphQL queries for activeTheme/availableThemes ===
    const queryRes = await gql(`query { activeTheme availableThemes { id name } }`, {});
    assert(!queryRes.errors, `activeTheme/availableThemes query succeeded (${JSON.stringify(queryRes.errors)})`);
    assert(queryRes.data?.activeTheme === "default", `activeTheme resolves to "default" (got ${queryRes.data?.activeTheme})`);
    assert(queryRes.data?.availableThemes?.some(t => t.id === "orange"), "availableThemes includes the new 'orange' theme");

    // === Non-Super-Admin rejection: regular player ===
    console.log("\n=== A regular player CANNOT change the theme ===");
    const playerJar = await httpLogin(playerEmail, password, "10.93.0.1");
    const playerAttempt = await gql(`mutation { setActiveTheme(themeId: "orange") }`, {}, playerJar);
    assert(!!playerAttempt.errors, `A regular player's setActiveTheme attempt is rejected (${JSON.stringify(playerAttempt.errors ?? playerAttempt.data)})`);

    // === Non-Super-Admin rejection: regular Admin ===
    console.log("\n=== A regular (non-super) Admin CANNOT change the theme ===");
    const adminJar = await httpLogin(adminEmail, password, "10.93.0.2");
    const adminAttempt = await gql(`mutation { setActiveTheme(themeId: "orange") }`, {}, adminJar);
    assert(!!adminAttempt.errors, `A regular Admin's setActiveTheme attempt is rejected (${JSON.stringify(adminAttempt.errors ?? adminAttempt.data)})`);

    const stillDefault = await SiteSettings.findById("siteSettings");
    assert(stillDefault.activeTheme === "default", "Site-wide theme is STILL 'default' -- neither rejected attempt changed anything");

    // === Super Admin CAN change the theme ===
    console.log("\n=== A Super Admin CAN switch the theme to 'orange', and it actually renders ===");
    const superAdminJar = await httpLogin(superAdminEmail, password, "10.93.0.3");
    const switchRes = await gql(`mutation { setActiveTheme(themeId: "orange") }`, {}, superAdminJar);
    assert(!switchRes.errors, `Super Admin's setActiveTheme("orange") succeeded (${JSON.stringify(switchRes.errors)})`);
    assert(switchRes.data?.setActiveTheme === "orange", "Mutation returns the new active theme id");

    const dbAfterSwitch = await SiteSettings.findById("siteSettings");
    assert(dbAfterSwitch.activeTheme === "orange", "Site-wide setting is now 'orange' in the DB");

    const homeRes2 = await fetch(`${BASE_URL}/`, { cache: "no-store" });
    const homeHtml2 = await homeRes2.text();
    const orangeStyleHome = extractHtmlTagStyle(homeHtml2);
    assert(
      orangeStyleHome?.includes("--navy:#1A1A1A") && orangeStyleHome?.includes("--blue:#FF7A29") && orangeStyleHome?.includes("--text-primary:#FFFFFF"),
      `Homepage now renders the orange theme's grey bg / bright orange accent / white text values (got: ${orangeStyleHome})`
    );
    assert(!orangeStyleHome?.includes("--navy:#0D0F1A"), "The OLD default theme's navy value is gone from the homepage");

    const tournamentUrl = `${BASE_URL}/tournaments/${tournament._id.toString()}`;
    const tournamentRes = await fetch(tournamentUrl, { cache: "no-store" });
    const tournamentHtml = await tournamentRes.text();
    const orangeStyleTournament = extractHtmlTagStyle(tournamentHtml);
    assert(tournamentRes.status === 200, `Tournament page rendered (status ${tournamentRes.status})`);
    assert(
      orangeStyleTournament?.includes("--navy:#1A1A1A") && orangeStyleTournament?.includes("--blue:#FF7A29"),
      `Tournament page ALSO renders the orange theme (site-wide, not homepage-only) (got: ${orangeStyleTournament})`
    );

    // === Switch back to default -- EXACT restoration ===
    console.log("\n=== Switching back to 'default' restores the EXACT original palette ===");
    const revertRes = await gql(`mutation { setActiveTheme(themeId: "default") }`, {}, superAdminJar);
    assert(!revertRes.errors, `Reverting to "default" succeeded (${JSON.stringify(revertRes.errors)})`);

    const homeRes3 = await fetch(`${BASE_URL}/`, { cache: "no-store" });
    const homeHtml3 = await homeRes3.text();
    const revertedStyle = extractHtmlTagStyle(homeHtml3);
    assert(revertedStyle === defaultStyle, `Homepage's inline theme style is BYTE-FOR-BYTE identical to the original baseline (got: ${revertedStyle})`);

    console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURE(S)`}`);
  } finally {
    console.log("\nRestoring the real site-wide theme and cleaning up test data...");
    await SiteSettings.findByIdAndUpdate("siteSettings", { activeTheme: originalThemeId }, { upsert: true });
    if (tournament) await Tournament.findByIdAndDelete(tournament._id);
    await Player.findByIdAndDelete(superAdminPlayer._id);
    await User.findByIdAndDelete(superAdminUser._id);
    await Player.findByIdAndDelete(adminPlayer._id);
    await User.findByIdAndDelete(adminUser._id);
    await Player.findByIdAndDelete(player._id);
    await User.findByIdAndDelete(playerUser._id);
    const finalSettings = await SiteSettings.findById("siteSettings");
    console.log(`Site-wide theme restored to "${finalSettings?.activeTheme}" (was "${originalThemeId}" before this test ran). Cleanup done.`);
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
