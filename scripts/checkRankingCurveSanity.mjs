// scripts/checkRankingCurveSanity.mjs
//
// One-off QA sanity check (not a permanent test) for the anti-farming
// ranking curve (lib/ranking.ts's scaledPointsForPlacement, commit a0fe005).
// Calls the REAL exported function -- no reimplementation -- across a
// representative spread of entrant counts, for 1st and 3rd place, and
// prints a table for human eyeballing. Read-only, no DB writes.
//
// Run: npx tsx scripts/checkRankingCurveSanity.mjs

const { scaledPointsForPlacement, pointsForPlacement } = await import("../lib/ranking");

const entrantCounts = [2, 4, 8, 16, 32, 48, 64, 100, 300, 700];

console.log(`Base table: 1st=${pointsForPlacement(1)}, 3rd=${pointsForPlacement(3)}\n`);

function printTable(placement) {
  console.log(`=== Placement ${placement} ===`);
  console.log("entrants".padStart(9), "points".padStart(8), "multiplier".padStart(11), "delta-from-prev".padStart(17));
  let prev = null;
  for (const n of entrantCounts) {
    const pts = scaledPointsForPlacement(placement, n);
    const mult = (pts / pointsForPlacement(placement)).toFixed(3);
    const delta = prev === null ? "-" : (pts - prev >= 0 ? "+" : "") + (pts - prev);
    console.log(String(n).padStart(9), String(pts).padStart(8), mult.padStart(11), String(delta).padStart(17));
    prev = pts;
  }
  console.log("");
}

printTable(1);
printTable(3);

// Extra: ratio of a small win to a mid-size win, and mid to large, to
// directly check "does a small win look disproportionately rewarding".
console.log("=== Ratios (placement 1) ===");
for (const [a, b] of [[8, 32], [32, 64], [64, 300], [8, 700]]) {
  const pa = scaledPointsForPlacement(1, a);
  const pb = scaledPointsForPlacement(1, b);
  console.log(`${a}-entrant win / ${b}-entrant win = ${pa}/${pb} = ${(pa / pb).toFixed(3)}`);
}
