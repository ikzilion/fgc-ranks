// Verification that the playersLeaderboard query genuinely scales, not just
// "works" at this app's real (~136-player) scale: generates a large
// synthetic dataset of throwaway Player documents directly via insertMany
// (bypassing the app entirely -- same reasoning other seed scripts use:
// register/login are rate-limited, and this needs far more accounts than
// that limit allows), then runs .explain("executionStats") on the actual
// default-listing and search query shapes to confirm:
//   1. The default (no search) sort+paginate hits the rankingPoints index
//      (IXSCAN), not a full collection scan (COLLSCAN).
//   2. The prefix search hits the tag_prefix_ci collated index (IXSCAN),
//      and only examines a small fraction of the synthetic dataset -- not
//      all of it -- confirming the search is actually bounded by the
//      matching prefix, not a scan over everything.
// Cleans up every synthetic player it created afterward, real or not.
//
// Run: npx tsx scripts/testPlayersLeaderboardScaleIndexPlan.mjs

import fs from "fs";
import path from "path";

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
const { Player } = await import("../models/Player");

const SCALE_TAG_PREFIX = "ScaleTestPlayer";
const SYNTHETIC_COUNT = 25000;
const MATCHING_PREFIX_COUNT = 40; // how many synthetic tags start with a specific searchable prefix

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

  console.log(`\n=== Seeding ${SYNTHETIC_COUNT} synthetic players ===`);
  await Player.deleteMany({ tag: { $regex: `^${SCALE_TAG_PREFIX}` } });

  const docs = [];
  for (let i = 0; i < SYNTHETIC_COUNT; i++) {
    // First MATCHING_PREFIX_COUNT get a distinct, searchable sub-prefix
    // ("ScaleTestPlayerFindMe00001"...) so the search-side assertions below
    // have a known, exact expected match count against real data volume.
    const tag =
      i < MATCHING_PREFIX_COUNT
        ? `${SCALE_TAG_PREFIX}FindMe${String(i).padStart(5, "0")}`
        : `${SCALE_TAG_PREFIX}${String(i).padStart(6, "0")}`;
    docs.push({
      tag,
      rankingPoints: Math.floor(Math.random() * 5000),
      isDeleted: false,
    });
  }
  // Batched insertMany -- a single 25k-document call is fine for Atlas, but
  // batching keeps memory/network chunks reasonable regardless of scale.
  const BATCH = 2000;
  for (let i = 0; i < docs.length; i += BATCH) {
    await Player.insertMany(docs.slice(i, i + BATCH), { ordered: false });
  }
  const seededCount = await Player.countDocuments({ tag: { $regex: `^${SCALE_TAG_PREFIX}` } });
  assert(seededCount === SYNTHETIC_COUNT, `seeded exactly ${SYNTHETIC_COUNT} synthetic players (found ${seededCount})`);

  try {
    console.log("\n=== Default listing (no search): sort+paginate query plan ===");
    const listExplain = await Player.find({ isDeleted: { $ne: true } })
      .sort({ rankingPoints: -1, _id: 1 })
      .skip(100)
      .limit(20)
      .explain("executionStats");

    const listStage = JSON.stringify(listExplain.executionStats.executionStages);
    const listUsesIxscan = listStage.includes("IXSCAN");
    const listUsesCollscan = listStage.includes("COLLSCAN");
    const listUsesBlockingSort = listStage.includes('"stage":"SORT"');
    assert(listUsesIxscan && !listUsesCollscan, `default listing plan uses IXSCAN, not COLLSCAN (winning plan stages: ${summarizeStages(listExplain.executionStats.executionStages)})`);
    assert(
      !listUsesBlockingSort,
      "default listing plan has NO blocking SORT stage -- the {rankingPoints:-1,_id:1} compound index fully satisfies the sort order by itself"
    );
    assert(
      listExplain.executionStats.totalDocsExamined < 200,
      `default listing examines close to just skip+limit documents (examined ${listExplain.executionStats.totalDocsExamined}), not the whole ${SYNTHETIC_COUNT}-player collection`
    );

    console.log("\n=== Search (tag prefix): query plan + bounded scan ===");
    const searchExplain = await Player.find({ isDeleted: { $ne: true }, tag: { $regex: "^ScaleTestPlayerFindMe", $options: "i" } })
      .collation({ locale: "en", strength: 2 })
      .sort({ rankingPoints: -1, _id: 1 })
      .limit(20)
      .explain("executionStats");

    const searchStage = JSON.stringify(searchExplain.executionStats.executionStages);
    const searchUsesIxscan = searchStage.includes("IXSCAN");
    const searchUsesCollscan = searchStage.includes("COLLSCAN");
    assert(searchUsesIxscan && !searchUsesCollscan, `search plan uses IXSCAN, not COLLSCAN (winning plan stages: ${summarizeStages(searchExplain.executionStats.executionStages)})`);

    const docsExamined = searchExplain.executionStats.totalDocsExamined;
    assert(
      docsExamined < SYNTHETIC_COUNT * 0.05,
      `search only examines a small slice of the ${SYNTHETIC_COUNT}-player dataset (examined ${docsExamined} docs), not a scan over everything`
    );

    // Correctness at scale, not just plan shape: exactly MATCHING_PREFIX_COUNT
    // real matches exist -- confirm the count query agrees.
    const searchCount = await Player.countDocuments({ isDeleted: { $ne: true }, tag: { $regex: "^ScaleTestPlayerFindMe", $options: "i" } }).collation({ locale: "en", strength: 2 });
    assert(searchCount === MATCHING_PREFIX_COUNT, `search count (${searchCount}) matches the exact number seeded with that prefix (${MATCHING_PREFIX_COUNT})`);
  } finally {
    console.log("\n=== Cleanup ===");
    const deleted = await Player.deleteMany({ tag: { $regex: `^${SCALE_TAG_PREFIX}` } });
    console.log(`  Deleted ${deleted.deletedCount} synthetic player(s).`);
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

function summarizeStages(stage) {
  const stages = [];
  let node = stage;
  while (node) {
    stages.push(node.stage);
    node = node.inputStage;
  }
  return stages.join(" <- ");
}

main().catch(async err => {
  console.error(err);
  try {
    const { Player } = await import("../models/Player");
    await Player.deleteMany({ tag: { $regex: `^${SCALE_TAG_PREFIX}` } });
  } catch {
    // best-effort cleanup even on failure
  }
  process.exit(1);
});
