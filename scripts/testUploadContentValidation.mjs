// Functional verification for /api/upload content + filename validation
// (security sweep, July 31, 2026 — see lib/uploadSecurity.ts).
//
// THE VULNERABILITY: the route's only content check was
// `ALLOWED_TYPES.includes(file.type)` — the CLIENT-supplied MIME type. For
// stream-bg/sponsor-banner (and the animated-GIF logo passthrough) the raw
// bytes were stored untouched under `${folder}/${Date.now()}-${file.name}`,
// with file.name straight from the client and no explicit contentType on
// put(). Confirmed before the fix, as an ORDINARY player (not a TO, not an
// admin): a file named "x.html" sent with Content-Type: image/png came back
// at a public blob URL that Vercel served as `text/html` — arbitrary
// HTML/JS hosting on the project's Blob domain by any registered user.
// The route also had no rate limit at all.
//
// Every upload here uses BENIGN bytes (a real 1x1 PNG/GIF); only the
// FILENAME and claimed MIME type are hostile. All blobs are deleted at the
// end. Runs against the REAL Vercel Blob store (there is no local emulator),
// so cleanup is not optional.
//
// Requires a server running on localhost:3000.
// Run: npx tsx scripts/testUploadContentValidation.mjs

import fs from "fs";
import path from "path";

const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

function loadEnvLocal() {
  const content = fs.readFileSync(path.resolve(process.cwd(), ".env.local"), "utf-8");
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    // MONGODB_URI is left to the caller so this can run against an isolated
    // in-memory instance (scripts/startMemoryMongo.mjs) rather than prod.
    if (k !== "MONGODB_URI") process.env[k] = v;
  }
}
loadEnvLocal();
if (!process.env.MONGODB_URI) throw new Error("Set MONGODB_URI (see scripts/startMemoryMongo.mjs)");

const { connectToDatabase } = await import("../lib/db");
const { User } = await import("../models/User");
const { Player } = await import("../models/Player");
const { del } = await import("@vercel/blob");
const bcrypt = (await import("bcryptjs")).default;

let passed = 0, failed = 0;
function check(label, cond, detail = "") {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

// Real, valid image bytes. Only names/MIME claims are hostile.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const NOT_AN_IMAGE = Buffer.from("<html><body><script>alert(1)</script></body></html>", "utf8");

await connectToDatabase();
const stamp = Date.now();
const email = `uploadsec-${stamp}@example.com`;
const u = await User.create({ email, passwordHash: await bcrypt.hash("TestPass123!", 10), role: "PLAYER", isTO: false, emailVerified: true });
const p = await Player.create({ tag: `UploadSec${stamp}`, userId: u._id });
await User.findByIdAndUpdate(u._id, { playerId: p._id });

const jar = new Map();
const applyCookies = list => { for (const c of list ?? []) { const pair = c.split(";")[0]; const eq = pair.indexOf("="); jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()); } };
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
applyCookies(csrfRes.headers.getSetCookie?.());
const { csrfToken } = await csrfRes.json();
const loginRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieHeader() },
  body: new URLSearchParams({ email, password: "TestPass123!", csrfToken, json: "true" }),
  redirect: "manual",
});
applyCookies(loginRes.headers.getSetCookie?.());
const sess = await (await fetch(`${BASE}/api/auth/session`, { headers: { Cookie: cookieHeader() } })).json();

const uploaded = [];
async function upload(bytes, name, mime, type) {
  const fd = new FormData();
  fd.append("file", new File([bytes], name, { type: mime }), name);
  fd.append("type", type);
  const res = await fetch(`${BASE}/api/upload`, { method: "POST", headers: { Cookie: cookieHeader() }, body: fd });
  const json = await res.json().catch(() => ({}));
  if (json.url) uploaded.push(json.url);
  return { status: res.status, json };
}

try {
  console.log("\n0. Attacker profile — an ORDINARY player, not a TO, not an admin");
  check("logged in", !!sess?.user);
  check("is NOT a TO", sess?.user?.isTO === false, `isTO=${sess?.user?.isTO}`);
  check("role is PLAYER", sess?.user?.role === "PLAYER");

  console.log("\n1. ATTACK — hostile extension must not control the served Content-Type");
  {
    const r = await upload(PNG, `evil-${stamp}.html`, "image/png", "sponsor-banner");
    check("upload of a real PNG still succeeds", r.status === 200, JSON.stringify(r.json));
    if (r.json.url) {
      const stored = new URL(r.json.url).pathname;
      check("stored key does NOT end in .html", !stored.endsWith(".html"), stored);
      check("stored key ends in the VERIFIED extension .png", stored.endsWith(".png"), stored);
      const served = (await fetch(r.json.url)).headers.get("content-type");
      check("served as image/png, NOT text/html", (served ?? "").startsWith("image/png"), `got ${served}`);
    }
  }

  console.log("\n2. ATTACK — path traversal in the filename must not survive");
  {
    const r = await upload(PNG, `../../avatars/trav-${stamp}.png`, "image/png", "sponsor-banner");
    check("upload succeeds (name sanitized, not rejected)", r.status === 200, JSON.stringify(r.json));
    if (r.json.url) {
      const stored = new URL(r.json.url).pathname;
      check("stored key contains no '..'", !stored.includes(".."), stored);
      check("stored key contains no nested path escape", stored.startsWith("/sponsor-banners/"), stored);
      check("stored key has exactly one directory level", stored.split("/").filter(Boolean).length === 2, stored);
    }
  }

  console.log("\n3. ATTACK — non-image bytes with a forged image MIME must be rejected");
  {
    const r = await upload(NOT_AN_IMAGE, `payload-${stamp}.png`, "image/png", "sponsor-banner");
    check("rejected with 400", r.status === 400, `status ${r.status} ${JSON.stringify(r.json)}`);
    check("no blob URL returned", !r.json.url);
  }
  {
    // Same forgery against the avatar path, which was already incidentally
    // protected by sharp re-encoding — asserted so it stays that way.
    const r = await upload(NOT_AN_IMAGE, `payload-${stamp}.png`, "image/png", "avatar");
    check("avatar path also rejects non-image bytes", r.status === 400, `status ${r.status}`);
  }

  console.log("\n4. NO REGRESSION — legitimate uploads must still work");
  {
    const r = await upload(PNG, `my avatar photo!!.png`, "image/png", "avatar");
    check("avatar upload succeeds", r.status === 200, JSON.stringify(r.json));
    check("avatar stored as .webp (re-encoded)", (r.json.url ?? "").endsWith(".webp"), r.json.url);
  }
  {
    const r = await upload(GIF, `banner-${stamp}.gif`, "image/gif", "sponsor-banner");
    check("GIF sponsor-banner upload succeeds", r.status === 200, JSON.stringify(r.json));
    if (r.json.url) {
      const served = (await fetch(r.json.url)).headers.get("content-type");
      check("GIF served as image/gif (passthrough intact)", (served ?? "").startsWith("image/gif"), `got ${served}`);
    }
  }
  {
    const r = await upload(PNG, `logo-${stamp}.png`, "image/png", "tournament-logo");
    check("tournament-logo upload succeeds", r.status === 200, JSON.stringify(r.json));
  }
} finally {
  console.log("\n--- cleanup ---");
  for (const url of uploaded) {
    try { await del(url); } catch (e) { console.log(`  WARN could not delete ${url}: ${e.message}`); }
  }
  console.log(`  deleted ${uploaded.length} test blob(s)`);
  await Player.findByIdAndDelete(p._id);
  await User.findByIdAndDelete(u._id);
  console.log("  test account removed");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
