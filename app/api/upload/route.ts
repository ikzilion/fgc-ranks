// app/api/upload/route.ts
// Handles avatar image uploads to Vercel Blob storage.
import { put } from "@vercel/blob";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { maxUploadBytes, formatMaxSizeLabel } from "@/lib/uploadLimits";

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
  if (type === "stream-bg") {
    filename = `tournament-backgrounds/${Date.now()}-${file.name}`;
  } else if (type === "sponsor-banner") {
    filename = `sponsor-banners/${Date.now()}-${file.name}`;
  } else if (type === "tournament-logo") {
    filename = `tournament-logos/${Date.now()}-${file.name}`;
  } else if (type === "event-logo") {
    filename = `event-logos/${Date.now()}-${file.name}`;
  } else {
    const playerId = (session.user as any).playerId;
    filename = `avatars/${playerId}-${Date.now()}-${file.name}`;
  }

  const blob = await put(filename, file, {
    access: "public",
  });

  return NextResponse.json({ url: blob.url });
}
