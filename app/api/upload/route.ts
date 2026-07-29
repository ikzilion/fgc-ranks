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

// SVG is deliberately excluded — it can embed <script> and would execute if
// the blob URL is ever opened directly rather than used as an <img> source.
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
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

  // Basic validation — only images, size cap depends on upload type. This is
  // the real enforcement: the matching client-side check in each upload
  // component is just for fast feedback and can be bypassed, so this check
  // has to stand on its own regardless of what the client claims.
  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json({ error: "File must be a PNG, JPEG, WEBP, or GIF image" }, { status: 400 });
  }
  const maxBytes = maxUploadBytes(type);
  if (file.size > maxBytes) {
    return NextResponse.json({ error: `Image must be under ${formatMaxSizeLabel(maxBytes)}` }, { status: 400 });
  }

  let filename: string;
  // Avatars only: resized + re-encoded server-side (lib/avatarImage.ts) —
  // storedBody/storedBytes/storedContentType track what actually ends up in
  // Blob storage, which is smaller than (and a different format from) the
  // original upload; every other type still stores the file exactly as-is.
  let storedBody: File | Buffer = file;
  let storedBytes = file.size;
  let storedContentType: string | undefined;
  if (type === "stream-bg") {
    filename = `tournament-backgrounds/${Date.now()}-${file.name}`;
  } else if (type === "sponsor-banner") {
    filename = `sponsor-banners/${Date.now()}-${file.name}`;
  } else if (type === "tournament-logo" || type === "event-logo" || type === "game-icon") {
    const folder = type === "tournament-logo" ? "tournament-logos" : type === "event-logo" ? "event-logos" : "game-icons";
    // Resized/re-encoded server-side (lib/logoImage.ts) same as avatars —
    // these had no processing at all before (performance audit, July 29,
    // 2026). processLogoImage returns null for a genuinely animated GIF, in
    // which case the original bytes are stored untouched (same passthrough
    // stream-bg/sponsor-banner already get, just decided per-file here
    // instead of per-type).
    try {
      const result = await processLogoImage(Buffer.from(await file.arrayBuffer()));
      if (result) {
        filename = `${folder}/${Date.now()}.webp`;
        storedBody = result.buffer;
        storedBytes = result.buffer.byteLength;
        storedContentType = result.contentType;
      } else {
        filename = `${folder}/${Date.now()}-${file.name}`;
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
      const { buffer, contentType } = await processAvatarImage(Buffer.from(await file.arrayBuffer()));
      storedBody = buffer;
      storedBytes = buffer.byteLength;
      storedContentType = contentType;
    } catch (err) {
      console.error("[upload] Failed to process avatar image:", err);
      return NextResponse.json({ error: "Couldn't process that image — try a different file." }, { status: 400 });
    }
  }

  const blob = await put(filename, storedBody, {
    access: "public",
    ...(storedContentType ? { contentType: storedContentType } : {}),
  });

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
