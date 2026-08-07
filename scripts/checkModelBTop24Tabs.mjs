// scripts/checkModelBTop24Tabs.mjs
// Real DOM check of the new Model B Top 24/Top 8 roster tabs, against the
// disposable verification tournament from setupModelBTop24Verification.mjs.
// Run: npx tsx scripts/checkModelBTop24Tabs.mjs
import { chromium } from "playwright";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const TOURNAMENT_ID = process.argv[2];
if (!TOURNAMENT_ID) throw new Error("Usage: checkModelBTop24Tabs.mjs <tournamentId>");

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
  await page.goto(`${BASE_URL}/tournaments/${TOURNAMENT_ID}`, { waitUntil: "networkidle", timeout: 60000 });

  const round1Tab = page.getByRole("button", { name: "Round 1", exact: true });
  const top24Tab = page.getByRole("button", { name: "Top 24", exact: true });
  const top8Tab = page.getByRole("button", { name: "Top 8", exact: true });

  assert(await round1Tab.isVisible(), '"Round 1" round tab visible');
  const top24Exists = (await top24Tab.count()) > 0;
  console.log(`  "Top 24" tab present: ${top24Exists}`);
  const top8Exists = (await top8Tab.count()) > 0;
  console.log(`  "Top 8" tab present: ${top8Exists}`);

  if (top24Exists) {
    await top24Tab.click();
    await page.waitForTimeout(300);
    const caption = page.getByText(/live entrants? remaining this round/);
    assert(await caption.isVisible(), "Top 24 live-count caption visible");
    console.log(`    caption: "${(await caption.textContent())?.trim()}"`);
    const poolLabels = await page.locator('p:text-matches("^Pool \\\\d+$")').allTextContents();
    console.log(`    pools shown in roster: ${poolLabels.join(", ")}`);
  }

  if (top8Exists) {
    await top8Tab.click();
    await page.waitForTimeout(300);
    const caption = page.getByText(/live entrants? remaining this round/);
    assert(await caption.isVisible(), "Top 8 live-count caption visible");
    console.log(`    caption: "${(await caption.textContent())?.trim()}"`);
    const poolLabels = await page.locator('p:text-matches("^Pool \\\\d+$")').allTextContents();
    console.log(`    pools shown in roster: ${poolLabels.join(", ")}`);
    const heading = page.getByRole("heading", { name: "Top 8", exact: true }).or(page.locator('p:text-is("Top 8")'));
    assert((await heading.count()) > 0, '"Top 8" section heading visible');
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
