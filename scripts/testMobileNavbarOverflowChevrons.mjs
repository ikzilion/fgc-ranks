// Verification for Navbar.tsx's nav-links row overflow chevrons: a subtle
// chevron-left and chevron-right (same no-fade pattern as the
// TournamentManageTabs tab bar, commit 78eb976), each independently shown
// only when the row is actually scrollable in that direction.
//
// No login/DB seeding needed -- the nav-links row renders identically for
// a signed-out visitor, so this hits the real homepage directly. Confirms:
//   1. At 375px (real overflow: scrollWidth 414 vs clientWidth 347): the
//      right chevron shows on load, the left chevron doesn't (scrolled to
//      the very start already); scrolling to the end flips both.
//   2. At 480px (no overflow: scrollWidth == clientWidth): neither chevron
//      ever renders.
//   3. At 1024px desktop: neither chevron renders, nav is unaffected.
//
// Requires `npm run dev` already running on localhost:3000.
// Run: npx tsx scripts/testMobileNavbarOverflowChevrons.mjs

import { chromium } from "playwright";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const LEFT_CHEVRON_SELECTOR = 'svg path[d="M15 6l-6 6 6 6"]';
const RIGHT_CHEVRON_SELECTOR = 'svg path[d="M9 6l6 6-6 6"]';

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

  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    console.log("\n=== 375px: real overflow ===");
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.getByRole("link", { name: "News" }).waitFor({ state: "visible", timeout: 5000 });

    const navInfo = await page.evaluate(() => {
      const link = Array.from(document.querySelectorAll("a")).find(a => a.textContent?.trim() === "News");
      const el = link?.parentElement;
      return el ? { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth } : null;
    });
    assert(
      !!navInfo && navInfo.scrollWidth > navInfo.clientWidth,
      `[375px] nav-links row actually overflows (scrollWidth=${navInfo?.scrollWidth}, clientWidth=${navInfo?.clientWidth})`
    );

    const rightAtStart = await page.locator(RIGHT_CHEVRON_SELECTOR).isVisible().catch(() => false);
    const leftAtStart = await page.locator(LEFT_CHEVRON_SELECTOR).isVisible().catch(() => false);
    assert(rightAtStart, "[375px] right chevron shows on load (row starts scrolled all the way left)");
    assert(!leftAtStart, "[375px] left chevron does NOT show on load (nothing hidden to its left yet)");

    // Scroll the nav-links row to its end -- real scrollLeft assignment
    // fires a genuine 'scroll' event React's onScroll picks up.
    await page.evaluate(() => {
      const link = Array.from(document.querySelectorAll("a")).find(a => a.textContent?.trim() === "News");
      const el = link?.parentElement;
      if (el) el.scrollLeft = el.scrollWidth - el.clientWidth;
    });
    await page.waitForTimeout(150);
    const rightAtEnd = await page.locator(RIGHT_CHEVRON_SELECTOR).isVisible().catch(() => false);
    const leftAtEnd = await page.locator(LEFT_CHEVRON_SELECTOR).isVisible().catch(() => false);
    assert(!rightAtEnd, "[375px] right chevron disappears once scrolled all the way to the end");
    assert(leftAtEnd, "[375px] left chevron appears once scrolled away from the start");

    console.log("\n=== 480px: tabs fit, no overflow ===");
    await page.setViewportSize({ width: 480, height: 800 });
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.getByRole("link", { name: "News" }).waitFor({ state: "visible", timeout: 5000 });
    const fitInfo = await page.evaluate(() => {
      const link = Array.from(document.querySelectorAll("a")).find(a => a.textContent?.trim() === "News");
      const el = link?.parentElement;
      return el ? { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth } : null;
    });
    assert(
      !!fitInfo && fitInfo.scrollWidth <= fitInfo.clientWidth + 1,
      `[480px] nav-links row fits without overflowing (scrollWidth=${fitInfo?.scrollWidth}, clientWidth=${fitInfo?.clientWidth})`
    );
    const leftAt480 = await page.locator(LEFT_CHEVRON_SELECTOR).isVisible().catch(() => false);
    const rightAt480 = await page.locator(RIGHT_CHEVRON_SELECTOR).isVisible().catch(() => false);
    assert(!leftAt480 && !rightAt480, "[480px] neither chevron renders when the nav links already fit");

    console.log("\n=== 1024px: desktop unaffected ===");
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.getByRole("link", { name: "News" }).waitFor({ state: "visible", timeout: 5000 });
    const leftAt1024 = await page.locator(LEFT_CHEVRON_SELECTOR).isVisible().catch(() => false);
    const rightAt1024 = await page.locator(RIGHT_CHEVRON_SELECTOR).isVisible().catch(() => false);
    assert(!leftAt1024 && !rightAt1024, "[1024px] neither chevron renders on desktop");
    const playersLinkVisible = await page.getByRole("link", { name: "Players" }).isVisible();
    assert(playersLinkVisible, "[1024px] all nav links still render normally");
  } finally {
    await browser.close();
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
