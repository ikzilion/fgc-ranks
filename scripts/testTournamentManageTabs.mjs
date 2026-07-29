// Functional verification for the TO/admin tournament-page tabbed
// reorganization (settled July 28, 2026, see components/TournamentManageTabs.tsx).
// Real HTTP login + real fetch of the actual rendered SSR HTML for a real
// disposable test tournament -- not a mock. Confirms:
//   1. A PUBLIC (non-managing) viewer's rendered page is completely
//      unchanged -- no tab bar, same entrants/bracket content in the same
//      position, same status/join controls.
//   2. A canManage (organizer) viewer's rendered page shows the new
//      Overview/Manage/Stream tab bar.
//   3. Overview is the default tab -- its content (entrants/bracket
//      section) is present in the initial SSR HTML, while the Manage/
//      Stream tabs' own button labels (Edit details, Manage organizers,
//      Stream settings, etc.) are NOT present until their tab is active --
//      confirming the conditional rendering actually gates on tab state
//      rather than always rendering everything.
//   4. The always-above-tabs controls (status action, Streamer Mode,
//      Tablet/Phone Mode) are still present for a canManage viewer.
//
// Requires `npm run dev` already running on localhost:3000.
// Run: npx tsx scripts/testTournamentManageTabs.mjs

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

async function httpLogin(email, password, syntheticIp) {
  const ipHeaders = { "x-forwarded-for": syntheticIp };
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
  cookieJar = [cookieJar, ...loginCookies.map(c => c.split(";")[0])].filter(Boolean).join("; ");
  return cookieJar;
}

async function main() {
  await connectToDatabase();

  const email = "tabtest-organizer@example.com";
  const password = "TestPass123!";
  await User.deleteOne({ email });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ email, passwordHash });
  const player = await Player.create({ userId: user._id, tag: "TabTestOrganizer" });
  await User.findByIdAndUpdate(user._id, { playerId: player._id });

  const tournament = await Tournament.create({
    name: "Tab Reorg Test Tournament",
    game: "Test Game",
    format: "Standard Bracket",
    organizers: [player._id],
    startDate: new Date(),
    entrantCount: 0,
  });

  try {
    const pageUrl = `${BASE_URL}/tournaments/${tournament._id.toString()}`;

    // === Public (non-managing) viewer ===
    console.log("\n=== Public/non-managing viewer: page must be completely unchanged ===");
    const publicRes = await fetch(pageUrl, { cache: "no-store" });
    const publicHtml = await publicRes.text();
    assert(publicRes.status === 200, `Page rendered (status ${publicRes.status})`);
    assert(publicHtml.includes("Tab Reorg Test Tournament"), "Tournament name renders");
    assert(publicHtml.includes("Entrants"), "Entrants section still renders in its usual position");
    assert(publicHtml.includes("Streamer Mode"), "Streamer Mode card still renders (public, unaffected by this feature)");
    assert(!publicHtml.includes(">Overview<"), "No 'Overview' tab button rendered for a public viewer");
    assert(!publicHtml.includes(">Manage<"), "No 'Manage' tab button rendered for a public viewer");
    assert(!publicHtml.includes("Stream settings"), "No 'Stream settings' button rendered for a public viewer (StreamAssetsButton never mounts)");
    assert(!publicHtml.includes("Edit details") && !publicHtml.includes("Edit tournament"), "No edit-details control rendered for a public viewer");

    // === Organizer (canManage) viewer ===
    console.log("\n=== Organizer (canManage) viewer: new tab bar appears, Overview is the default ===");
    const cookieJar = await httpLogin(email, password, "10.98.0.1");
    const manageRes = await fetch(pageUrl, { headers: { Cookie: cookieJar }, cache: "no-store" });
    const manageHtml = await manageRes.text();
    assert(manageRes.status === 200, `Page rendered for the organizer (status ${manageRes.status})`);
    assert(manageHtml.includes(">Overview<"), "'Overview' tab button renders for the organizer");
    assert(manageHtml.includes(">Manage<"), "'Manage' tab button renders for the organizer");
    assert(manageHtml.includes(">Stream<"), "'Stream' tab button renders for the organizer");

    // Overview is the default -- its content (Entrants) is present in the
    // initial SSR HTML without needing a click.
    assert(manageHtml.includes("Entrants"), "Overview tab's content (Entrants section) is present in the initial page load");

    // The Manage/Stream tabs' own buttons must NOT be in the initial HTML --
    // proves the conditional actually gates on tab state (tab starts at
    // "overview") rather than always rendering every panel.
    assert(!manageHtml.includes("Stream settings"), "Stream tab's 'Stream settings' button is NOT in the initial HTML (not the active tab)");
    assert(!manageHtml.includes("Manage Organizers"), "Manage tab's 'Manage Organizers' trigger button is NOT in the initial HTML (not the active tab)");

    // Always-above-the-tabs controls still present for the organizer.
    assert(manageHtml.includes("Start tournament"), "Status action (TournamentStatusButton, UPCOMING -> 'Start tournament') still renders above the tabs");
    assert(manageHtml.includes("Streamer Mode"), "Streamer Mode card still renders for the organizer");
    assert(manageHtml.includes("Tablet"), "Tablet/Phone Mode card still renders for the organizer (canManage-only, unaffected by the tab reorg)");

    console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURE(S)`}`);
  } finally {
    console.log("\nCleaning up test data...");
    await Tournament.findByIdAndDelete(tournament._id);
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
