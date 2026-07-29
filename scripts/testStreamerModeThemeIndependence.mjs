// Verifies the Streamer Mode / site-theme independence fix (July 29, 2026
// bugfix -- components/StreamBracket.tsx's BROADCAST_FIXED_VARS).
//
// Real HTTP fetch of the actual rendered /tournaments/[id] (regular) and
// /tournaments/[id]/stream (Streamer Mode) pages for a real tournament with
// a generated bracket -- same convention as scripts/testColorTheme.mjs
// (extract the inline style="" attribute off a real element in the raw SSR
// HTML, not a mock). Confirms:
//   1. Before any theme change, both pages show the same (default) navy/blue.
//   2. Switching the real site-wide theme to "orange" makes the regular
//      page's <html> AND its bracket area both pick up orange (no local
//      override exists there -- everything just inherits from <html>).
//   3. The SAME switch leaves Streamer Mode's OWN root wrapper (the
//      "isolate" div StreamBracket renders, which re-declares --navy/--blue/
//      etc as fixed values) completely unchanged, even though <html> above
//      it did switch -- proving the CSS custom property override actually
//      wins the cascade for everything inside Streamer Mode's own subtree.
//
// app/layout.tsx's activeTheme fetch uses next:{revalidate:30} (July 29,
// 2026 perf fix), so a direct DB write isn't guaranteed to show up on the
// very next page load -- polls (up to the revalidate window plus slack)
// until the real page's <html> tag actually reflects the new theme, same
// real-world delay a site visitor would see.
//
// Restores the real site-wide theme to whatever it was before, in a finally
// block regardless of pass/fail, since this is real shared site state.
//
// Requires `npm run dev` already running on localhost:3000.
// Run: npx tsx scripts/testStreamerModeThemeIndependence.mjs

import fs from "fs";
import path from "path";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const TOURNAMENT_ID = "6a5be6041c5d40bad1929619"; // Community Showdown — real generated bracket

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

const { connectToDatabase } = await import("../lib/db.ts");
const { SiteSettings } = await import("../models/SiteSettings.ts");
await connectToDatabase();

let failures = 0;
function assert(cond, label) {
  if (cond) console.log(`  OK   ${label}`);
  else {
    console.log(`  FAIL ${label}`);
    failures++;
  }
}

function extractHtmlTagStyle(html) {
  const match = html.match(/<html[^>]*\sstyle="([^"]*)"/);
  return match ? match[1] : null;
}

// StreamBracket's own root wrapper carries a unique "isolate" class
// (confirmed: grep -rn "isolate" components/ app/ -- only this one match).
function extractIsolateDivStyle(html) {
  const match = html.match(/class="min-h-screen w-full isolate"\sstyle="([^"]*)"/);
  return match ? match[1] : null;
}

async function fetchPage(url) {
  const res = await fetch(url, { cache: "no-store" });
  return res.text();
}

// Polls until the real page's <html> tag reflects the expected theme
// (accounting for the fetch cache's revalidate:30 window), not just an
// immediate single read.
async function pollForHtmlNavy(url, expectedNavySubstr, timeoutMs = 40000) {
  const start = Date.now();
  let html;
  while (Date.now() - start < timeoutMs) {
    html = await fetchPage(url);
    const style = extractHtmlTagStyle(html);
    if (style?.includes(expectedNavySubstr)) return { html, waitedMs: Date.now() - start };
    await new Promise(r => setTimeout(r, 2000));
  }
  return { html, waitedMs: Date.now() - start, timedOut: true };
}

const originalSettings = await SiteSettings.findById("siteSettings");
const originalThemeId = originalSettings?.activeTheme ?? "default";

try {
  console.log("=== Baseline: forcing theme to 'default' (polling for cache to catch up) ===");
  await SiteSettings.findByIdAndUpdate("siteSettings", { activeTheme: "default" }, { upsert: true });

  const { html: regularBefore, waitedMs: waitRB } = await pollForHtmlNavy(`${BASE_URL}/tournaments/${TOURNAMENT_ID}`, "--navy:#0D0F1A");
  const { html: streamBefore, waitedMs: waitSB } = await pollForHtmlNavy(`${BASE_URL}/tournaments/${TOURNAMENT_ID}/stream`, "--navy:#0D0F1A");
  console.log(`  regular page <html> style (waited ${waitRB}ms):`, extractHtmlTagStyle(regularBefore));
  console.log(`  stream page <html> style  (waited ${waitSB}ms):`, extractHtmlTagStyle(streamBefore));
  const isolateBefore = extractIsolateDivStyle(streamBefore);
  console.log("  stream page's isolate-div style:", isolateBefore);
  assert(extractHtmlTagStyle(regularBefore)?.includes("--navy:#0D0F1A"), "regular page <html> shows default theme's navy");
  assert(isolateBefore?.includes("--navy:#0D0F1A") && isolateBefore?.includes("--blue:#4F8EF7"), "stream page's isolate wrapper shows the frozen default navy/blue");

  console.log("\n=== Switching real site-wide theme to 'orange' (polling for cache to catch up) ===");
  await SiteSettings.findByIdAndUpdate("siteSettings", { activeTheme: "orange" }, { upsert: true });

  const { html: regularAfter, waitedMs: waitRA } = await pollForHtmlNavy(`${BASE_URL}/tournaments/${TOURNAMENT_ID}`, "--navy:#1A1A1A");
  const { html: streamAfter, waitedMs: waitSA } = await pollForHtmlNavy(`${BASE_URL}/tournaments/${TOURNAMENT_ID}/stream`, "--navy:#1A1A1A");
  console.log(`  regular page <html> style (waited ${waitRA}ms):`, extractHtmlTagStyle(regularAfter));
  console.log(`  stream page <html> style  (waited ${waitSA}ms):`, extractHtmlTagStyle(streamAfter));
  const isolateAfter = extractIsolateDivStyle(streamAfter);
  console.log("  stream page's isolate-div style (should be UNCHANGED):", isolateAfter);

  assert(extractHtmlTagStyle(regularAfter)?.includes("--navy:#1A1A1A") && extractHtmlTagStyle(regularAfter)?.includes("--blue:#FF7A29"), "regular page <html> switched to orange theme's navy/accent");
  // The regular tournament page has no local CSS-variable override anywhere
  // in its own markup, so its actual bracket-area colors come purely from
  // whatever <html> resolves to -- already proven correct by the <html>
  // check above; there is no separate "bracket wrapper style" to inspect on
  // this route the way Streamer Mode has one.
  assert(extractHtmlTagStyle(streamAfter)?.includes("--navy:#1A1A1A"), "stream page's <html> itself still reports the new site theme (layout.tsx applies it everywhere)");
  assert(isolateAfter === isolateBefore, "stream page's own wrapper style is BYTE-FOR-BYTE identical before/after the site theme switch");
  assert(isolateAfter?.includes("--navy:#0D0F1A") && isolateAfter?.includes("--blue:#4F8EF7"), "stream page's wrapper still shows the frozen default navy/blue, NOT orange");

  console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURE(S)`}`);
} finally {
  console.log(`\nRestoring real site-wide theme to "${originalThemeId}"...`);
  await SiteSettings.findByIdAndUpdate("siteSettings", { activeTheme: originalThemeId }, { upsert: true });
}

process.exit(failures === 0 ? 0 : 1);
