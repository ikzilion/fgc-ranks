// scripts/reconcileBlobStorage.js
//
// Re-syncs the running Vercel Blob storage total (lib/blobStorage.ts,
// Counter document _id: "blobStorageBytes") against the REAL current usage
// -- lists every blob in the real store and sums their actual sizes, same
// list()-based technique as the past orphaned-blob investigation
// (lib/streamAssets.ts's header comment references it), then SETS the
// counter to that real total (not $inc -- this is a full resync, not an
// adjustment).
//
// Run once to seed the counter when this feature was first introduced (so
// blobs uploaded before incremental tracking existed aren't undercounted),
// and again any time the tracked total is suspected to have drifted from
// reality (e.g. a decrement that silently failed).
//
// Run: npx tsx scripts/reconcileBlobStorage.js

import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { list } from "@vercel/blob";
import { Counter } from "../models/Counter";

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
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("Missing BLOB_READ_WRITE_TOKEN (checked .env.local)");

  let totalBytes = 0;
  let blobCount = 0;
  let cursor;
  do {
    const result = await list({ cursor, limit: 1000 });
    for (const blob of result.blobs) totalBytes += blob.size;
    blobCount += result.blobs.length;
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);

  await mongoose.connect(process.env.MONGODB_URI);
  await Counter.findOneAndUpdate(
    { _id: "blobStorageBytes" },
    { $set: { seq: totalBytes } },
    { upsert: true }
  );
  await mongoose.disconnect();

  console.log(`Reconciled: ${blobCount} blobs, ${totalBytes} bytes (${(totalBytes / (1024 * 1024)).toFixed(1)} MB). Counter set.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
