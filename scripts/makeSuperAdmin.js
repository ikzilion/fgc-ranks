// scripts/makeSuperAdmin.js
//
// One-off: promotes an existing account to SUPER_ADMIN by email. Mirrors
// scripts/makeAdmin.js one level up (same connection setup, same
// find-by-email/set-role/save approach). SUPER_ADMIN is meant to stay a
// single fixed account — there's deliberately no in-app way to grant it
// (grantAdmin/revokeAdmin only ever move an account between ADMIN and
// PLAYER) — but this script doesn't hard-block promoting a second one; that
// would be a deliberate manual action at the same trust level as having DB
// access in the first place, so it just warns instead of refusing.
//
// Run: npx tsx scripts/makeSuperAdmin.js someone@example.com

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
    console.error("Usage: npx tsx scripts/makeSuperAdmin.js <email>");
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

  const existing = await User.findOne({ role: "SUPER_ADMIN" });
  if (existing && existing.email !== email) {
    console.warn(`Warning: ${existing.email} is already SUPER_ADMIN. Continuing anyway — promoting a second account is a deliberate manual choice this script doesn't block.`);
  }

  user.role = "SUPER_ADMIN";
  await user.save();
  console.log(`${email} is now SUPER_ADMIN.`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
