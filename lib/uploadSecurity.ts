// lib/uploadSecurity.ts
// SECURITY (July 31, 2026) — content and filename validation for /api/upload.
//
// WHAT WAS WRONG: the route's only content check was
// `ALLOWED_TYPES.includes(file.type)`. `file.type` is the multipart
// Content-Type the CLIENT supplies, so it is trivially forged. Avatar and
// logo uploads happened to be safe by accident (sharp re-encodes them, which
// fails on non-images), but stream-bg and sponsor-banner — and the animated-
// GIF passthrough branch for logos — stored the raw bytes untouched. The
// stored blob key was `${folder}/${Date.now()}-${file.name}` with file.name
// straight from the client, and put() was called with no explicit
// contentType, so Vercel Blob inferred it from that attacker-chosen
// extension.
//
// Verified end to end before the fix, as an ORDINARY player (not a TO, not an
// admin): uploading a valid PNG named "x.html" with Content-Type image/png
// produced a public blob URL that Vercel then served as `text/html` — i.e.
// any registered user could host arbitrary HTML/JS on the project's Blob
// domain. Not same-origin with fgc-ranks.com (so not session-stealing XSS),
// but real phishing/malware-hosting abuse under a trusted-looking domain.
//
// THE FIX, in two parts:
//   1. Decide the format from the actual BYTES (sharp's own header parse),
//      never from the client's claimed MIME type or file extension.
//   2. Build the stored filename from a sanitized basename plus the
//      VERIFIED extension, and always pass an explicit contentType to put()
//      so Blob never infers one from the path.

import sharp from "sharp";

// Mirrors app/api/upload/route.ts's ALLOWED_TYPES. SVG stays excluded — it
// can embed <script> and would execute if the blob URL is opened directly.
const ALLOWED_FORMATS = ["png", "jpeg", "webp", "gif"] as const;
type AllowedFormat = (typeof ALLOWED_FORMATS)[number];

const EXTENSION: Record<AllowedFormat, string> = {
  png: "png",
  jpeg: "jpg",
  webp: "webp",
  gif: "gif",
};

const CONTENT_TYPE: Record<AllowedFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export type VerifiedImage = {
  format: AllowedFormat;
  extension: string;
  contentType: string;
};

// Returns null when the bytes are not a real image in an allowed format —
// including the "sharp cannot parse this at all" case. Deliberately stricter
// than lib/logoImage.ts's own unreadable-metadata fallback, which passes such
// a file through untouched: that fallback is fine as a RESIZE decision, but
// it must not also decide whether the file is allowed to be stored.
export async function verifyImageContent(buffer: Buffer): Promise<VerifiedImage | null> {
  try {
    // animated: true so a multi-frame GIF reports correctly rather than
    // being read as a single frame.
    const metadata = await sharp(buffer, { animated: true }).metadata();
    const format = metadata.format as AllowedFormat | undefined;
    if (!format || !ALLOWED_FORMATS.includes(format)) return null;
    // A zero-dimension "image" is not something we should be storing.
    if (!metadata.width || !metadata.height) return null;
    return { format, extension: EXTENSION[format], contentType: CONTENT_TYPE[format] };
  } catch {
    return null;
  }
}

// Reduces a client-supplied filename to a safe basename and forces the
// verified extension onto it. Strips any directory component (both separators
// — a Windows client can legitimately send backslashes), so "../" and
// absolute paths cannot survive into the blob key.
export function safeUploadFilename(originalName: string | undefined, extension: string): string {
  const base = (originalName ?? "").split(/[\\/]/).pop() ?? "";
  const stem = base
    .replace(/\.[^.]*$/, "") // drop the client's extension; we impose our own
    .replace(/[^a-zA-Z0-9._-]/g, "-") // whitelist, so no %00, newlines, quotes, etc.
    .replace(/^[.\-]+/, "") // no leading dots/dashes ("..", hidden files)
    .slice(0, 60);
  return `${stem || "upload"}.${extension}`;
}
