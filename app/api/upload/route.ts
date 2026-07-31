// app/api/upload/route.ts
// Handles avatar image uploads to Vercel Blob storage.
import { put } from "@vercel/blob";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { maxUploadBytes, formatMaxSizeLabel } from "@/lib/uploadLimits";
import { connectToDatabase } from "@/lib/db";
import { StreamAssetType } from "@/models/StreamAsset";
import { recordStreamAssetUpload } from "@/lib/streamAssets";
import { adjustBlobStorageUsage } from "@/lib/blobStorage";
import { processAvatarImage } from "@/lib/avatarImage";
import { processLogoImage } from "@/lib/logoImage";
import { verifyImageContent, safeUploadFilename, toUploadBody } from "@/lib/uploadSecurity";
import { uploadRateLimit } from "@/lib/rateLimit";

// SVG is deliberately excluded — it can embed <script> and would execute if
// the blob URL is ever opened directly rather than used as an <img> source.
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }

  // SECURITY (July 31, 2026): this route previously had NO rate limit at all,
  // so any signed-in account could push unlimited 8-15MB files into a Blob
  // store on a hard 1GB shared quota. Keyed by playerId (an authenticated
  // action), falling back to the user id for an account with no Player yet.
  const rateKey = (session.user as any).playerId ?? (session.user as any).id ?? "unknown";
  const { success } = await uploadRateLimit.limit(String(rateKey));
  if (!success) {
    return NextResponse.json(
      { error: "Too many uploads. Please wait a while and try again." },
      { status: 429 }
    );
  }

  const form = await request.formData();
  const file = form.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  // "type" picks the folder — avatar uploads are scoped to the uploading
  // player, stream/banner uploads aren't tied to a player. Authorization for
  // *attaching* a stream asset URL to a specific tournament happens in the
  // updateTournamentStreamAssets GraphQL mutation (isOrganizer check), not
  // here — this route only checks that someone is signed in, same as avatars.
  const type = (form.get("type") as string) || "avatar";

  // Size cap first — cheapest check, and it bounds how much we're about to
  // read into memory for content verification below.
  const maxBytes = maxUploadBytes(type);
  if (file.size > maxBytes) {
    return NextResponse.json({ error: `Image must be under ${formatMaxSizeLabel(maxBytes)}` }, { status: 400 });
  }

  // The client-claimed MIME type is checked only as a fast reject. It is NOT
  // trusted — `file.type` is supplied by the client and is trivially forged.
  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json({ error: "File must be a PNG, JPEG, WEBP, or GIF image" }, { status: 400 });
  }

  // SECURITY (July 31, 2026): the real check. Decide the format from the
  // actual BYTES, never from the claimed MIME type or the filename. Before
  // this, stream-bg/sponsor-banner (and the animated-GIF logo passthrough)
  // stored raw client bytes under a client-chosen filename, and Vercel Blob
  // inferred the served Content-Type from that extension — so an ordinary
  // signed-in player could host arbitrary HTML on the Blob domain by sending
  // "payload.html" with Content-Type: image/png. See lib/uploadSecurity.ts.
  const originalBuffer = Buffer.from(await file.arrayBuffer());
  const verified = await verifyImageContent(originalBuffer);
  if (!verified) {
    return NextResponse.json(
      { error: "That file isn't a valid PNG, JPEG, WEBP, or GIF image." },
      { status: 400 }
    );
  }
  // Every stored filename below is built from this sanitized basename plus
  // the VERIFIED extension — never the raw client string.
  const safeName = safeUploadFilename(file.name, verified.extension);

  let filename: string;
  // Avatars only: resized + re-encoded server-side (lib/avatarImage.ts) —
  // storedBody/storedBytes/storedContentType track what actually ends up in
  // Blob storage, which is smaller than (and a different format from) the
  // original upload; every other type still stores the file exactly as-is.
  // storedBody defaults to the already-read verified bytes, not the File —
  // the body has been consumed by arrayBuffer() above.
  let storedBody: Buffer = originalBuffer;
  let storedBytes = originalBuffer.byteLength;
  // Always set explicitly (never left undefined) so Blob never infers the
  // served Content-Type from the pathname.
  let storedContentType: string = verified.contentType;
  if (type === "stream-bg") {
    filename = `tournament-backgrounds/${Date.now()}-${safeName}`;
  } else if (type === "sponsor-banner") {
    filename = `sponsor-banners/${Date.now()}-${safeName}`;
  } else if (type === "tournament-logo" || type === "event-logo" || type === "game-icon") {
    const folder = type === "tournament-logo" ? "tournament-logos" : type === "event-logo" ? "event-logos" : "game-icons";
    // Resized/re-encoded server-side (lib/logoImage.ts) same as avatars —
    // these had no processing at all before (performance audit, July 29,
    // 2026). processLogoImage returns null for a genuinely animated GIF, in
    // which case the original bytes are stored untouched (same passthrough
    // stream-bg/sponsor-banner already get, just decided per-file here
    // instead of per-type).
    try {
      const result = await processLogoImage(originalBuffer);
      if (result) {
        filename = `${folder}/${Date.now()}.webp`;
        storedBody = result.buffer;
        storedBytes = result.buffer.byteLength;
        storedContentType = result.contentType;
      } else {
        // Animated-GIF passthrough — sanitized name + verified extension,
        // same as stream-bg/sponsor-banner above.
        filename = `${folder}/${Date.now()}-${safeName}`;
      }
    } catch (err) {
      console.error(`[upload] Failed to process ${type} image:`, err);
      return NextResponse.json({ error: "Couldn't process that image — try a different file." }, { status: 400 });
    }
  } else {
    const playerId = (session.user as any).playerId;
    // .webp regardless of the original extension — the compressed output is
    // always re-encoded to WebP, see lib/avatarImage.ts.
    filename = `avatars/${playerId}-${Date.now()}.webp`;
    try {
      const { buffer, contentType } = await processAvatarImage(originalBuffer);
      storedBody = buffer;
      storedBytes = buffer.byteLength;
      storedContentType = contentType;
    } catch (err) {
      console.error("[upload] Failed to process avatar image:", err);
      return NextResponse.json({ error: "Couldn't process that image — try a different file." }, { status: 400 });
    }
  }

  // PRODUCTION OUTAGE FIX (July 31, 2026). Every upload 500'd with
  //   TypeError: ArrayBuffer: SharedArrayBuffer is not allowed
  // thrown from inside Next's BUNDLED fetch (@edge-runtime/primitives, which
  // wraps undici's webidl BufferSource conversion). That conversion rejects
  // any view whose backing store fails `util.types.isSharedArrayBuffer`, and
  // put() is the only fetch here with a buffer body.
  //
  // Root cause was this route's own earlier rewrite: `storedBody` used to
  // default to the `File` object, which fetch consumes natively as a Blob.
  // It was changed to `Buffer.from(await file.arrayBuffer())` — and
  // Buffer.from(ArrayBuffer) creates a VIEW, not a copy, so the body
  // inherited whatever backing store the runtime allocated for the uploaded
  // file. On Vercel that is shared memory; on a local Node build it is not,
  // which is exactly why this passed every local test and only failed in
  // production.
  //
  // Copying into a freshly allocated, exact-size, offset-0 plain ArrayBuffer
  // makes the body provably non-shared no matter which branch produced it
  // (raw passthrough, sharp avatar output, or sharp logo output) and no
  // matter how the runtime allocated the original. new Uint8Array(view)
  // copies; it does not alias.
  const uploadBody = toUploadBody(storedBody);

  // contentType is ALWAYS passed explicitly (it defaults to the verified
  // format above) — never omitted, so Blob cannot infer a served
  // Content-Type from the pathname.
  let blob;
  try {
    blob = await put(filename, uploadBody, {
      access: "public",
      contentType: storedContentType,
    });
  } catch (err) {
    // Previously this threw uncaught, so a Blob failure surfaced as an opaque
    // 500 and the client's generic "Failed to upload image. Try again." —
    // which is what made the outage take real log-digging to diagnose.
    console.error("[upload] Blob put() failed:", err);
    return NextResponse.json(
      { error: "Couldn't save that image right now. Please try again." },
      { status: 502 }
    );
  }

  // Site-wide running storage total (lib/blobStorage.ts) -- every
  // successful upload through this route increments it, regardless of
  // type. storedBytes (not file.size) so an avatar's ACTUAL, post-
  // compression footprint is what's counted. Matching decrements happen
  // wherever a blob is actually deleted (currently: recordStreamAssetUpload's
  // retention eviction below, and softDeletePlayer's avatar cleanup — both
  // already re-derive the real size via head() rather than trusting a
  // stored value, so they're unaffected by this).
  await connectToDatabase();
  await adjustBlobStorageUsage(storedBytes);

  // Stream backgrounds/sponsor banners: record every upload into the
  // uploading TO's reusable library (models/StreamAsset.ts), regardless of
  // whether they end up actually applying it this session -- the whole
  // point is "uploaded once, reusable later" (see lib/streamAssets.ts).
  // This is also the ONLY place a blob of these two types ever gets
  // deleted going forward (the retention-cap eviction inside
  // recordStreamAssetUpload) -- scoped to just these two types per this
  // task; avatar/logo/icon uploads are a separate, out-of-scope flow.
  if (type === "stream-bg" || type === "sponsor-banner") {
    const organizerId = (session.user as any).playerId;
    if (organizerId) {
      await recordStreamAssetUpload(organizerId, type as StreamAssetType, blob.url, file.name);
    }
  }

  return NextResponse.json({ url: blob.url });
}
