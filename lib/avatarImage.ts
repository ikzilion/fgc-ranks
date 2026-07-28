// lib/avatarImage.ts
// Server-side resize/compression for player avatars specifically -- see
// app/api/upload/route.ts, which calls this only for the avatar upload
// path. Backgrounds/sponsor banners/tournament-logos/event-logos/game-icons
// are untouched (settled scope, July 27, 2026) -- they're already bounded
// by the reusable stream-asset library's 10-per-organizer retention cap
// (lib/streamAssets.ts) and legitimately need higher resolution than a
// small avatar thumbnail.
//
// Avatars are the real long-term risk to the 1GB Vercel Blob Hobby limit
// (lib/blobStorage.ts) -- they scale with player count (uncapped) rather
// than event count. This is a SEPARATE, tighter target for the STORED file
// from the existing generic per-file upload ceiling
// (lib/uploadLimits.ts's MAX_UPLOAD_BYTES.avatar) -- that ceiling is a raw
// pre-processing sanity/DoS check on the request itself; this is what
// actually ends up in Blob storage.
//
// sharp was already present in node_modules as an optional dependency of
// Next.js itself (next/image's production encoder) -- promoted to a real
// top-level dependency in package.json rather than relying on that
// incidental, optional presence.
import sharp from "sharp";

// Avatars are shown small everywhere in this app -- the biggest real
// on-screen use is the zoomed lightbox view, capped at min(90vw,
// 480px)/80vh (see components/ZoomableAvatar.tsx); everywhere else it's a
// w-16 h-16 or smaller circle. 512px gives comfortable headroom for that
// lightbox plus 2-3x DPI on the small thumbnails, without storing
// resolution nobody will ever actually see.
export const AVATAR_MAX_DIMENSION = 512;

// Target for the STORED file (not a rejection threshold -- the raw-upload
// ceiling in lib/uploadLimits.ts already rejects truly oversized requests
// before this ever runs). Middle of the settled 500KB-1MB range. At 512x512
// WebP this is comfortably hit by any normal photo well before the quality
// floor below is reached -- the ladder exists as a defensive backstop, not
// the expected path.
export const AVATAR_TARGET_BYTES = 750 * 1024;

const QUALITY_LADDER = [80, 65, 50, 35, 20];

// Resizes to a square AVATAR_MAX_DIMENSION crop (fit: "cover", matching how
// every avatar call site already renders it with object-cover) and
// re-encodes as WebP -- better compression than JPEG/PNG at equivalent
// quality, and keeps an alpha channel if the source had one. Steps down the
// quality ladder until the result fits AVATAR_TARGET_BYTES.
//
// A multi-frame GIF avatar is flattened to its first frame -- avatars were
// never in scope for animation (that was sponsor banners specifically, see
// the "Sponsor banner slideshow + animated GIF banner support" feature),
// and flattening is the same size-reduction goal this whole feature exists
// for.
//
// Always returns SOME buffer (the lowest-quality ladder attempt) even if it
// can't hit the target -- a slightly-over-budget avatar beats a failed
// upload. Throws only if sharp can't decode the input at all (caller should
// treat that as a 400, not a 500 -- see app/api/upload/route.ts).
export async function processAvatarImage(input: Buffer): Promise<{ buffer: Buffer; contentType: string }> {
  const pipeline = sharp(input)
    // Applies EXIF orientation before the metadata carrying it is stripped
    // by re-encoding below -- otherwise a phone photo shot sideways/upside
    // down would be stored that way.
    .rotate()
    .resize(AVATAR_MAX_DIMENSION, AVATAR_MAX_DIMENSION, { fit: "cover", position: "centre" });

  let last: Buffer | null = null;
  for (const quality of QUALITY_LADDER) {
    // clone() branches a fresh output stage off the already-decoded/resized
    // pipeline above, so each quality attempt doesn't re-decode the input.
    const buffer = await pipeline.clone().webp({ quality }).toBuffer();
    last = buffer;
    if (buffer.byteLength <= AVATAR_TARGET_BYTES) {
      return { buffer, contentType: "image/webp" };
    }
  }
  return { buffer: last!, contentType: "image/webp" };
}
