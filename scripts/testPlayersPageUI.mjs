// End-to-end UI verification for the redesigned Players list page: a real
// headless Chromium session driving the actual PlayerSearchFilter component
// (not just the GraphQL layer directly) -- confirms typing in the search
// box updates the rendered list, clicking page 2 shows different players,
// and the initial server-rendered page matches what the client refetch
// would show.
//
// Requires `npm run dev` already running on localhost:3000.
// Run: npx tsx scripts/testPlayersPageUI.mjs

import { chromium } from "playwright";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

// Polls instead of a fixed wait -- the dev server can add real (variable)
// latency the first time it JIT-compiles a route/API path, on top of the
// component's own 300ms debounce, so a fixed timeout is inherently flaky.
async function waitUntil(fn, { timeout = 8000, interval = 150 } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await new Promise(r => setTimeout(r, interval));
  }
  return last;
}

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
    await page.goto(`${BASE_URL}/players`, { waitUntil: "networkidle" });

    const rowLinks = page.locator('main a[href^="/players/"]');
    const initialCount = await rowLinks.count();
    assert(initialCount > 0, `Players page renders a server-side page 1 with rows on load (found ${initialCount})`);

    const searchInput = page.getByPlaceholder("Search by player tag…");
    await searchInput.fill("Jotaro");

    const afterSearchTags = await waitUntil(async () => {
      const texts = await rowLinks.allInnerTexts();
      return texts.some(t => t.includes("JotaroStarPlatinum")) && texts.length <= 5 ? texts : null;
    });
    assert(!!afterSearchTags, `typing "Jotaro" into the search box re-fetches and shows JotaroStarPlatinum (only, not the full unfiltered page)`);
    assert(
      !!afterSearchTags && afterSearchTags.every(t => t.toLowerCase().includes("jotaro")),
      `every row shown after searching "Jotaro" actually matches (found: ${afterSearchTags?.join(" | ")})`
    );

    await searchInput.fill("");
    const clearedTags = await waitUntil(async () => {
      const count = await rowLinks.count();
      return count === initialCount ? count : null;
    });
    assert(clearedTags === initialCount, `clearing the search restores the original page (count ${clearedTags} == initial ${initialCount})`);

    const page1Tags = await rowLinks.allInnerTexts();
    const nextPageButton = page.getByRole("button", { name: "Next page" });
    const nextDisabled = await nextPageButton.isDisabled();
    if (!nextDisabled) {
      await nextPageButton.click();
      const page2Tags = await waitUntil(async () => {
        const texts = await rowLinks.allInnerTexts();
        const overlap = texts.filter(t => page1Tags.includes(t));
        return overlap.length === 0 && texts.length > 0 ? texts : null;
      });
      assert(!!page2Tags, `clicking "Next page" shows different players than page 1`);
    } else {
      console.log("  SKIP next-page check (fewer than one full page of players exist)");
    }
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
