// lib/uploadLimits.ts
// Shared by both the client upload components (fast feedback before
// attempting an upload) and app/api/upload/route.ts (the real enforcement —
// client-side checks alone can be bypassed by a direct request to the route).
// Backgrounds/banners get a slightly higher cap since they're full-bleed
// stream overlay images rather than small avatar/logo thumbnails.
export const MAX_UPLOAD_BYTES: Record<string, number> = {
  avatar: 5 * 1024 * 1024,
  "tournament-logo": 5 * 1024 * 1024,
  "event-logo": 5 * 1024 * 1024,
  "stream-bg": 8 * 1024 * 1024,
  "sponsor-banner": 8 * 1024 * 1024,
};

export function maxUploadBytes(type: string): number {
  return MAX_UPLOAD_BYTES[type] ?? MAX_UPLOAD_BYTES.avatar;
}

export function formatMaxSizeLabel(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}
