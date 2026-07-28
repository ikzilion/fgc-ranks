// Functional verification for Event.description (markdown, optional,
// settled July 28, 2026). Real HTTP login, real createEvent/updateEvent
// mutations, and a real fetch of the actual rendered Event page HTML -- not
// a mock. Confirms:
//   1. A description with real markdown (bold, a link, a line break)
//      round-trips through createEvent and renders correctly formatted
//      (real <strong>/<a target="_blank" rel="noopener noreferrer">/<br>
//      elements, not literal markdown syntax) on the real page.
//   2. Editing via updateEvent round-trips a changed description the same way.
//   3. An Event with NO description renders with no "About" section at all
//      -- not an empty one.
//   4. A raw <script> tag embedded in the description is NOT rendered as an
//      actual executable element -- react-markdown's default (no rehype-raw)
//      treats it as literal text, which is what actually prevents XSS here.
//
// Requires `npm run dev` already running on localhost:3000.
// Run: npx tsx scripts/testEventDescription.mjs

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
const { Event } = await import("../models/Event");
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

async function main() {
  await connectToDatabase();

  const email = "eventdesctest@example.com";
  const password = "TestPass123!";
  await User.deleteOne({ email });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ email, passwordHash });
  const player = await Player.create({ userId: user._id, tag: "EventDescTester" });
  await User.findByIdAndUpdate(user._id, { playerId: player._id });

  const createdEventIds = [];

  try {
    const jar = await httpLogin(email, password, "10.96.0.1");

    // === Create with real markdown: bold, a link, a line break ===
    console.log("\n=== createEvent with markdown description ===");
    const description = "Our **flagship** event of the year.\nSee the [rules here](https://example.com/rules) before you register.";
    const createRes = await gql(
      `mutation($name: String!, $description: String) { createEvent(name: $name, description: $description) { id displayId } }`,
      { name: "Markdown Desc Test Event", description },
      jar
    );
    assert(!createRes.errors, `createEvent with description succeeded (${JSON.stringify(createRes.errors)})`);
    const eventId = createRes.data.createEvent.id;
    createdEventIds.push(eventId);

    const dbEventAfterCreate = await Event.findById(eventId);
    assert(dbEventAfterCreate.description === description, "Description stored verbatim (markdown source) in the DB");

    // Creator can view their own PENDING event directly (no admin approval needed for this check).
    const pageRes1 = await fetch(`${BASE_URL}/events/${eventId}`, { headers: { Cookie: jar.header() }, cache: "no-store" });
    const html1 = await pageRes1.text();
    assert(pageRes1.status === 200, `Event page rendered (status ${pageRes1.status})`);
    assert(html1.includes(">About<"), "'About' section heading renders when a description is set");
    // Note: the raw markdown source ("**flagship**") legitimately also
    // appears elsewhere in the page source regardless -- EditEventDetailsButton
    // is a client component that receives the raw description as a prop, and
    // Next.js embeds serialized client-component props in the page for
    // hydration. That's normal RSC behavior, not a rendering bug -- the
    // actual thing under test is that the VISIBLE rendered output below is a
    // real <strong> element, not literal asterisks.
    assert(/<strong>\s*flagship\s*<\/strong>/.test(html1), "Bold text rendered as a real <strong> element");
    assert(
      html1.includes('href="https://example.com/rules"') && html1.includes('target="_blank"') && html1.includes('rel="noopener noreferrer"'),
      "Link rendered as a real <a href target=\"_blank\" rel=\"noopener noreferrer\"> element"
    );
    assert(/<br\s*\/?>/.test(html1), "Single newline rendered as a real line break (<br>), not silently ignored");

    // === Edit via updateEvent -- round-trips a changed description ===
    console.log("\n=== updateEvent with a changed description ===");
    const updatedDescription = "Updated: now featuring a **second** stage and [a new link](https://example.com/updated).";
    const updateRes = await gql(
      `mutation($id: ID!, $description: String) { updateEvent(id: $id, description: $description) { id } }`,
      { id: eventId, description: updatedDescription },
      jar
    );
    assert(!updateRes.errors, `updateEvent with a changed description succeeded (${JSON.stringify(updateRes.errors)})`);
    const dbEventAfterUpdate = await Event.findById(eventId);
    assert(dbEventAfterUpdate.description === updatedDescription, "Updated description stored verbatim in the DB");

    const pageRes2 = await fetch(`${BASE_URL}/events/${eventId}`, { headers: { Cookie: jar.header() }, cache: "no-store" });
    const html2 = await pageRes2.text();
    assert(/<strong>\s*second\s*<\/strong>/.test(html2), "Updated bold text renders correctly after edit");
    assert(html2.includes('href="https://example.com/updated"'), "Updated link renders correctly after edit");
    assert(!html2.includes("flagship"), "The OLD description content is gone after the edit (not appended/duplicated)");

    // === No description -- no "About" section at all ===
    console.log("\n=== Event with NO description: no broken empty section ===");
    const createNoDescRes = await gql(`mutation($name: String!) { createEvent(name: $name) { id } }`, { name: "No Description Test Event" }, jar);
    assert(!createNoDescRes.errors, `createEvent with no description succeeded (${JSON.stringify(createNoDescRes.errors)})`);
    const noDescEventId = createNoDescRes.data.createEvent.id;
    createdEventIds.push(noDescEventId);

    const pageRes3 = await fetch(`${BASE_URL}/events/${noDescEventId}`, { headers: { Cookie: jar.header() }, cache: "no-store" });
    const html3 = await pageRes3.text();
    assert(pageRes3.status === 200, `Event page (no description) rendered (status ${pageRes3.status})`);
    assert(!html3.includes(">About<"), "No 'About' section heading renders at all when there's no description");

    // === XSS: raw <script> in the description is not rendered as a real element ===
    console.log("\n=== XSS: embedded raw HTML/<script> is not rendered as an executable element ===");
    const xssPayload = 'Innocent text. <script>window.__xss_fired = true;</script> more text.';
    const createXssRes = await gql(
      `mutation($name: String!, $description: String) { createEvent(name: $name, description: $description) { id } }`,
      { name: "XSS Payload Test Event", description: xssPayload },
      jar
    );
    assert(!createXssRes.errors, `createEvent with a <script>-containing description succeeded (stored as data, not executed) (${JSON.stringify(createXssRes.errors)})`);
    const xssEventId = createXssRes.data.createEvent.id;
    createdEventIds.push(xssEventId);

    const pageRes4 = await fetch(`${BASE_URL}/events/${xssEventId}`, { headers: { Cookie: jar.header() }, cache: "no-store" });
    const html4 = await pageRes4.text();
    // A real (executable) injected element would appear as a literal
    // "<script>" tag start in the HTML. react-markdown's default (no
    // rehype-raw) escapes/treats it as text, so the output should contain
    // the HTML-entity-escaped form instead, never a bare "<script>" tag.
    assert(!/<script>window\.__xss_fired/.test(html4), "No literal, executable <script> tag made it into the rendered HTML");
    assert(html4.includes("&lt;script&gt;") || html4.includes("&amp;lt;script"), "The <script> text is HTML-escaped in the output (rendered as inert text, not a tag)");

    console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURE(S)`}`);
  } finally {
    console.log("\nCleaning up test data...");
    for (const id of createdEventIds) {
      await Event.findByIdAndDelete(id);
    }
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
