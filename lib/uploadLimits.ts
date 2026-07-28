// lib/uploadLimits.ts
// Shared by both the client upload components (fast feedback before
// attempting an upload) and app/api/upload/route.ts (the real enforcement —
// client-side checks alone can be bypassed by a direct request to the route).
// Backgrounds/banners get a slightly higher cap since they're full-bleed
// stream overlay images rather than small avatar/logo thumbnails.
//
// avatar is a raw pre-processing sanity/DoS ceiling on the REQUEST, not what
// ends up stored — every avatar upload is resized/re-encoded down to a much
// smaller, tighter target regardless of input size (see
// lib/avatarImage.ts's AVATAR_TARGET_BYTES). Set higher than the other
// still-stored-as-is types specifically so a normal (even large) phone photo
// is never rejected outright — it just gets compressed down instead.
export const MAX_UPLOAD_BYTES: Record<string, number> = {
  avatar: 15 * 1024 * 1024,
  "tournament-logo": 5 * 1024 * 1024,
  "event-logo": 5 * 1024 * 1024,
  "game-icon": 5 * 1024 * 1024,
  "stream-bg": 8 * 1024 * 1024,
  "sponsor-banner": 8 * 1024 * 1024,
};

export function maxUploadBytes(type: string): number {
  return MAX_UPLOAD_BYTES[type] ?? MAX_UPLOAD_BYTES.avatar;
}

export function formatMaxSizeLabel(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}
