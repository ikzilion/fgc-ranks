// Verification for the notification bell mobile overflow bug: real HTTP
// login, real Notification docs seeded directly in MongoDB (one with a long
// unbroken string to stress-test word-wrap), then a real headless Chromium
// (Playwright) session that opens the dropdown and measures actual
// getBoundingClientRect()/scrollWidth of the panel and message text at
// 320/375/414/480px viewport widths -- not a screenshot, not a visual guess.
//
// Requires `npm run dev` already running on localhost:3000.
// Run: npx tsx scripts/testNotificationBellMobileOverflow.mjs

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
const { Notification, NotificationType } = await import("../models/Notification");
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

  const email = "notifbelloverflowtest@example.com";
  const password = "TestPass123!";
  await User.deleteOne({ email });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ email, passwordHash });
  const player = await Player.create({ userId: user._id, tag: "NotifBellTester" });
  await User.findByIdAndUpdate(user._id, { playerId: player._id });

  await Notification.deleteMany({ playerId: player._id });
  const longUnbrokenMessage =
    "ThisIsADeliberatelyLongUnbrokenNotificationMessageWithNoSpacesAtAllDesignedToStressTestWordWrapBehaviorInsideTheNotificationBellDropdownPanelOnNarrowMobileViewports";
  await Notification.create([
    {
      playerId: player._id,
      type: NotificationType.PLAYER_JOINED,
      message: "SomePlayerTag just joined your tournament Winter Regional 2026",
      read: false,
    },
    {
      playerId: player._id,
      type: NotificationType.MATCH_REPORTED,
      message: longUnbrokenMessage,
      read: false,
    },
  ]);

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
    console.log("\n=== Headless Chromium: notification bell at mobile widths ===");
    browser = await chromium.launch();
    const context = await browser.newContext();

    // Inject the real NextAuth session cookies from the real login above.
    const cookiePairs = cookieJar.split("; ").map(pair => {
      const idx = pair.indexOf("=");
      return { name: pair.slice(0, idx), value: pair.slice(idx + 1) };
    });
    const url = new URL(BASE_URL);
    await context.addCookies(
      cookiePairs.map(c => ({ ...c, domain: url.hostname, path: "/" }))
    );

    const page = await context.newPage();

    for (const width of [320, 375, 414, 480, 1024]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

      const bellButton = page.locator("nav button").first();
      await bellButton.click();
      // Panel renders after the myNotifications fetch resolves.
      await page.getByText("SomePlayerTag just joined").waitFor({ timeout: 5000 });

      const panelBox = await page
        .locator("nav .fgc-card")
        .first()
        .evaluate(el => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, width: r.width };
        });

      const panelFitsOnScreen = panelBox.left >= -0.5 && panelBox.right <= width + 0.5;
      assert(
        panelFitsOnScreen,
        `[${width}px] panel stays within viewport (left=${panelBox.left.toFixed(1)}, right=${panelBox.right.toFixed(1)}, viewport=${width})`
      );
      if (width >= 640) {
        assert(
          Math.abs(panelBox.width - 320) < 1,
          `[${width}px] desktop panel keeps its original 320px width (width=${panelBox.width.toFixed(1)})`
        );
      }

      const longMsgBox = await page
        .getByText("ThisIsADeliberatelyLong", { exact: false })
        .first()
        .evaluate(el => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
        });

      const textFitsOnScreen = longMsgBox.right <= width + 0.5;
      const textNotOverflowingOwnBox = longMsgBox.scrollWidth <= longMsgBox.clientWidth + 1;
      assert(
        textFitsOnScreen,
        `[${width}px] long unbroken message's right edge stays within viewport (right=${longMsgBox.right.toFixed(1)}, viewport=${width})`
      );
      assert(
        textNotOverflowingOwnBox,
        `[${width}px] long unbroken message wraps instead of overflowing its own box (scrollWidth=${longMsgBox.scrollWidth}, clientWidth=${longMsgBox.clientWidth})`
      );
    }
  } finally {
    if (browser) await browser.close();
    await Notification.deleteMany({ playerId: player._id });
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
