// lib/blobStorage.ts
// Site-wide running total of Vercel Blob storage usage — display-only,
// shown on the admin dashboard. Tracked incrementally (not computed on
// demand) via a single Counter document (_id: "blobStorageBytes"), same
// atomic $inc pattern lib/counter.ts already uses for playerNumber/
// eventNumber sequences, just storing a byte total instead of a sequence.
//
// Every successful upload (app/api/upload/route.ts) increments this by the
// uploaded file's size. Every place that actually deletes a blob must
// decrement it by that blob's real size — currently that's
// lib/streamAssets.ts's retention-cap eviction and softDeletePlayer's
// avatar cleanup (graphql/resolvers/index.ts). If a new blob-deleting code
// path is ever added, it needs to call adjustBlobStorageUsage too, or this
// total will silently drift high.
//
// Seeded to the REAL usage at feature-introduction time via
// scripts/reconcileBlobStorage.ts (list()-based, same technique as the
// past orphaned-blob investigation) rather than starting at 0 — otherwise
// every blob uploaded before this feature existed would be undercounted
// forever. Re-run that script if this total is ever suspected to have
// drifted from reality (e.g. a decrement that silently failed).
import { Counter } from "@/models/Counter";

const COUNTER_ID = "blobStorageBytes";

// Vercel's Hobby plan blob storage limit. Hardcoded per the settled scope
// (display-only — not read dynamically from Vercel's API, not admin-
// configurable). UPDATE THIS if the plan tier ever changes.
export const BLOB_STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024; // 1 GB

// Callers must have already called connectToDatabase(), same convention as
// lib/counter.ts's getNextSequence.
export async function adjustBlobStorageUsage(deltaBytes: number): Promise<void> {
  if (!deltaBytes) return;
  await Counter.findOneAndUpdate({ _id: COUNTER_ID }, { $inc: { seq: deltaBytes } }, { upsert: true });
}

export async function getBlobStorageUsageBytes(): Promise<number> {
  const counter = await Counter.findById(COUNTER_ID);
  // Never negative in what's displayed, even if real-world drift (e.g. a
  // decrement whose size lookup failed) ever pushed the raw total below
  // zero — see this file's header comment for how to re-sync if suspected.
  return Math.max(0, counter?.seq ?? 0);
}
