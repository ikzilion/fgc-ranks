// scripts/makeAdmin.js
//
// One-off: promotes an existing account to ADMIN by email. Doesn't create
// the account — register normally through the app first, then run this to
// grant access. Referenced throughout CLAUDE.md/project docs but never
// actually existed in the repo until now (flagged during the Phase 2
// security-push task) — added here since Phase 3's scripts/makeSuperAdmin.js
// is meant to mirror this file's exact pattern one level up.
//
// Run: npx tsx scripts/makeAdmin.js someone@example.com

import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { User } from "../models/User";

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
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: npx tsx scripts/makeAdmin.js <email>");
    process.exit(1);
  }

  loadEnvLocal();
  if (!process.env.MONGODB_URI) throw new Error("Missing MONGODB_URI (checked .env.local)");
  await mongoose.connect(process.env.MONGODB_URI);

  const user = await User.findOne({ email });
  if (!user) {
    console.error(`No account found for ${email}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  user.role = "ADMIN";
  await user.save();
  console.log(`${email} is now ADMIN.`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
