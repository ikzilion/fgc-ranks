// models/StreamAsset.ts
// A TO's reusable stream-background/sponsor-banner library — shared across
// EVERY tournament they organize (scoped by organizerId, not tournamentId),
// so a recurring TO uploads an image once and can reuse it across events
// instead of re-uploading duplicate copies each time. See lib/streamAssets.ts
// for the upload-recording + retention-cap eviction logic that keeps this
// collection (and the real Vercel Blob storage behind it) bounded.
import { Schema, models, model } from "mongoose";

// Matches the existing REST /api/upload route's own "type" form-field
// values exactly (tournament-backgrounds/ vs sponsor-banners/ blob
// folders) -- no separate GraphQL enum, so there's nothing to keep in sync
// between two parallel naming schemes.
export enum StreamAssetType {
  STREAM_BG = "stream-bg",
  SPONSOR_BANNER = "sponsor-banner",
}

const StreamAssetSchema = new Schema(
  {
    organizerId: { type: Schema.Types.ObjectId, ref: "Player", required: true },
    type: { type: String, enum: Object.values(StreamAssetType), required: true },
    url: { type: String, required: true },
    // The original filename the TO uploaded (e.g. "channels4_banner.jpg"),
    // captured at upload time from the file input -- NOT the generated
    // Vercel Blob pathname (which is Date.now()-prefixed and not meant to
    // be human-readable). Optional since the 4 real assets that existed
    // before this field was added have no way to recover their original
    // name retroactively -- the picker dropdown falls back to a generic
    // label for those (see components/StreamAssetsButton.tsx).
    filename: { type: String, default: null },
  },
  { timestamps: true }
);

// Every real query here is "this organizer's most recent N uploads of one
// type" -- createdAt included directly in the index (descending) since
// that's also the sort order every read uses.
StreamAssetSchema.index({ organizerId: 1, type: 1, createdAt: -1 });

export const StreamAsset = models.StreamAsset || model("StreamAsset", StreamAssetSchema);
