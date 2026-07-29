// lib/logoImage.ts
// Server-side resize/compression for tournament logos, event logos, and
// game icons -- these were the one remaining gap after avatars got the same
// treatment (lib/avatarImage.ts): despite lib/avatarImage.ts's own header
// comment grouping them in with stream-bg/sponsor-banner as "untouched,
// settled scope, July 27, 2026, already bounded by the reusable stream-
// asset library's retention cap" -- that's not actually true for these
// three. Only stream-bg/sponsor-banner ever go through
// lib/streamAssets.ts's recordStreamAssetUpload (see app/api/upload/route.ts's
// `if (type === "stream-bg" || type === "sponsor-banner")` gate) -- logos
// and icons have no retention cap, no eviction, and multiply once per
// tournament/event/game created (unbounded, same long-term Blob-storage
// risk class as avatars, arguably worse since there's one per entity
// rather than one per player). Found and fixed during the July 29, 2026
// performance audit.
//
// Every real render site (app/games/page.tsx, app/tournaments/[id]/page.tsx,
// app/events/[id]/page.tsx, components/AdminGameManager.tsx) shows these in
// a small w-14 h-14 (or smaller) square with object-cover -- same
// "shown small everywhere, no reason to store full resolution" reasoning
// lib/avatarImage.ts already uses for avatars, so this reuses its exact
// target dimension/quality ladder rather than inventing new numbers.
import sharp from "sharp";
import { AVATAR_MAX_DIMENSION, AVATAR_TARGET_BYTES } from "@/lib/avatarImage";

export const LOGO_MAX_DIMENSION = AVATAR_MAX_DIMENSION;
export const LOGO_TARGET_BYTES = AVATAR_TARGET_BYTES;

const QUALITY_LADDER = [80, 65, 50, 35, 20];

// Unlike avatars (never in scope for animation, always flattened), a logo
// or icon is a plausible place for someone to intentionally upload an
// animated GIF -- so this checks sharp's reported page/frame count first
// and passes a genuinely animated file through UNTOUCHED (still subject to
// the existing raw byte cap in lib/uploadLimits.ts) rather than silently
// flattening it. Only single-frame images get resized/re-encoded.
//
// If sharp can't even read the metadata (an unusual/malformed-but-still-
// MIME-valid file), this also falls back to untouched passthrough rather
// than rejecting the upload -- this whole resize step is a bonus
// optimization on top of a path that always worked before it existed, so a
// probe failure should degrade to the old "store as-is" behavior, not turn
// into a new upload failure a user didn't have before.
export async function processLogoImage(input: Buffer): Promise<{ buffer: Buffer; contentType: string } | null> {
  let meta;
  try {
    meta = await sharp(input, { animated: true }).metadata();
  } catch {
    return null;
  }
  if ((meta.pages ?? 1) > 1) {
    return null; // Animated -- caller stores the original bytes as-is.
  }

  const pipeline = sharp(input)
    .rotate()
    .resize(LOGO_MAX_DIMENSION, LOGO_MAX_DIMENSION, { fit: "cover", position: "centre" });

  let last: Buffer | null = null;
  for (const quality of QUALITY_LADDER) {
    const buffer = await pipeline.clone().webp({ quality }).toBuffer();
    last = buffer;
    if (buffer.byteLength <= LOGO_TARGET_BYTES) {
      return { buffer, contentType: "image/webp" };
    }
  }
  return { buffer: last!, contentType: "image/webp" };
}
