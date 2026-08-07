// scripts/checkStandardBracketTop24Tabs.mjs
//
// Real DOM check (not a screenshot) that the new StandardBracketSection
// Top 24/Top 8 tabs render on a standard (bracket-only) tournament — using
// the existing ENDED 700-entrant stress tournament, where the bracket is
// fully decided (live count = 1), so both tabs should be eligible
// (mainStartCount 701 >= 48/16, liveCount 1 <= 24/8).
//
// Run: npx tsx scripts/checkStandardBracketTop24Tabs.mjs (requires
// `npm run dev` already running on localhost:3000)

import { chromium } from "playwright";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const URL = `${BASE_URL}/tournaments/6a6d069e387ee77102b68fb3`;

let failures = 0;
function assert(cond, label) {
  if (cond) console.log(`  OK   ${label}`);
  else {
    console.log(`  FAIL ${label}`);
    failures++;
  }
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });

  const mainTab = page.getByRole("button", { name: "Main Bracket", exact: true });
  const top24Tab = page.getByRole("button", { name: "Top 24", exact: true });
  const top8Tab = page.getByRole("button", { name: "Top 8", exact: true });

  assert(await mainTab.isVisible(), '"Main Bracket" tab visible');
  assert(await top24Tab.isVisible(), '"Top 24" tab visible');
  assert(await top8Tab.isVisible(), '"Top 8" tab visible');

  await top24Tab.click();
  await page.waitForTimeout(300);
  const liveText = page.getByText(/live entrants? remaining/);
  assert(await liveText.isVisible(), "Live-count caption visible after clicking Top 24");
  console.log(`    caption: "${(await liveText.textContent())?.trim()}"`);

  await top8Tab.click();
  await page.waitForTimeout(300);
  assert(await liveText.isVisible(), "Live-count caption still visible after clicking Top 8");

  await mainTab.click();
  await page.waitForTimeout(300);
  assert(!(await liveText.isVisible()), "Live-count caption gone after clicking back to Main Bracket");

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
