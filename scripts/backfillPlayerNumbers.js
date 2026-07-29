// scripts/backfillPlayerNumbers.js
//
// One-off backfill: assigns a sequential playerNumber (displayed as e.g.
// "FGC-000001" — see lib/playerId.ts) to every existing Player that doesn't
// have one yet, ordered by createdAt so the oldest accounts get the lowest
// numbers. Uses the same Counter-based atomic sequence
// (lib/counter.ts/getNextSequence) that the register resolver now uses for
// new signups, so the counter is left pointing at exactly the right next
// value for future registrations to continue from — no separate "seed the
// counter" step needed.
//
// Idempotent — safe to re-run; players that already have a playerNumber are
// skipped, and the counter only advances for players actually assigned one.
//
// Run: npx tsx scripts/backfillPlayerNumbers.js

import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { Player } from "../models/Player";
import { getNextSequence } from "../lib/counter";
import { formatPlayerNumber } from "../lib/playerId";

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

  const unnumbered = await Player.find({ playerNumber: { $exists: false } }).sort({ createdAt: 1 });
  if (unnumbered.length === 0) {
    console.log("No players need backfilling — every Player already has a playerNumber.");
    await mongoose.disconnect();
    return;
  }

  console.log(`Backfilling ${unnumbered.length} player(s), oldest first...`);
  for (const player of unnumbered) {
    const playerNumber = await getNextSequence("playerNumber");
    await Player.findByIdAndUpdate(player._id, { playerNumber });
    console.log(`  ${player.tag} -> ${formatPlayerNumber(playerNumber)}`);
  }

  console.log("Backfill complete.");
  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
