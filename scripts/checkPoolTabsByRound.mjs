// scripts/checkPoolTabsByRound.mjs
//
// One-off check: user reported that on the Pools+Bracket Model B
// 700-entrant stress tournament, only 1 pool tab ("Pool 85") renders instead
// of tabs for all 85 pools. Code review of PoolsSection.tsx suggests pools
// are round-scoped behind a round selector (Round 1/2/3/Semifinal Cutoff/
// Finals) -- each round tab should reveal only that round's own pool tabs
// (64/16/4/1 respectively), not one flat 85-tab bar. Checking the REAL
// rendered DOM to confirm rather than trust the code read alone.
//
// No login needed -- pool tabs are public-view content, canManage only
// gates action buttons.
//
// Run: npx tsx scripts/checkPoolTabsByRound.mjs

import { chromium } from "playwright";

const URL = "https://www.fgc-ranks.com/tournaments/6a6d10f64991d6d367a265c9";

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  console.log(`Loading ${URL} ...`);
  const t0 = Date.now();
  await page.goto(URL, { waitUntil: "networkidle", timeout: 120000 });
  console.log(`Loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const roundTabLabels = ["Round 1", "Round 2", "Round 3", "Semifinal Cutoff", "Finals"];
  for (const label of roundTabLabels) {
    const btn = page.getByRole("button", { name: label, exact: true });
    const exists = (await btn.count()) > 0;
    console.log(`\nRound tab "${label}": ${exists ? "found" : "NOT FOUND"}`);
    if (!exists) continue;
    await btn.click();
    await page.waitForTimeout(300);
    const poolButtons = page.locator('button:text-matches("^Pool \\\\d+$")');
    const poolCount = await poolButtons.count();
    const poolLabels = await poolButtons.allTextContents();
    console.log(`  Pool tabs visible: ${poolCount}`);
    if (poolCount > 0 && poolCount <= 10) console.log(`  Labels: ${poolLabels.join(", ")}`);
    else if (poolCount > 0) console.log(`  First 5: ${poolLabels.slice(0, 5).join(", ")} ... Last 5: ${poolLabels.slice(-5).join(", ")}`);
  }

  await browser.close();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
