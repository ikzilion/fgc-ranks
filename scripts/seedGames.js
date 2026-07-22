// scripts/seedGames.js
//
// One-off: creates a curated Game document for every distinct
// Tournament.game value that doesn't already have one, with an empty
// iconUrl (generic initials placeholder — see app/games/page.tsx). This is
// what makes the initial Games list non-empty at launch, sourced from
// whatever games tournaments have actually been created under so far.
//
// Idempotent — safe to re-run; an exact-name match already curated is
// skipped. Not needed for correctness going forward (the `games` resolver
// already surfaces any un-curated game as its own drift-guard entry — see
// models/Game.ts) but a real curated Game lets an admin attach an icon and
// keeps the "Games" nav tab itself as the source of truth over time.
//
// Run: npx tsx scripts/seedGames.js

import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { Game } from "../models/Game";
import { Tournament } from "../models/Tournament";

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

async function main() {
  loadEnvLocal();
  if (!process.env.MONGODB_URI) throw new Error("Missing MONGODB_URI (checked .env.local)");
  await mongoose.connect(process.env.MONGODB_URI);

  const distinctGames = await Tournament.distinct("game");
  const existing = await Game.find();
  const existingNames = new Set(existing.map(g => g.name));

  const toCreate = distinctGames.filter(name => name && name.trim() && !existingNames.has(name));
  if (toCreate.length === 0) {
    console.log("Nothing to seed — every distinct Tournament.game value already has a curated Game.");
    await mongoose.disconnect();
    return;
  }

  console.log(`Seeding ${toCreate.length} game(s)...`);
  for (const name of toCreate) {
    await Game.create({ name });
    console.log(`  + ${name}`);
  }

  console.log("Seed complete.");
  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
