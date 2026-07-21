// lib/turnstile.ts
// Cloudflare Turnstile CAPTCHA — registration only (Security Push Phase 5).
//
// Cloudflare's own dummy test keys (publicly documented, not sensitive —
// safe to hardcode): always pass, so local dev/testing isn't blocked by a
// real challenge. Real keys (TURNSTILE_SITE_KEY/TURNSTILE_SECRET_KEY) come
// from env and are only used in production.
const DUMMY_SITE_KEY = "1x00000000000000000000AA";
const DUMMY_SECRET_KEY = "1x0000000000000000000000000000000AA";

export function getTurnstileSiteKey(): string {
  if (process.env.NODE_ENV !== "production") return DUMMY_SITE_KEY;
  return process.env.TURNSTILE_SITE_KEY || DUMMY_SITE_KEY;
}

function getTurnstileSecretKey(): string {
  if (process.env.NODE_ENV !== "production") return DUMMY_SECRET_KEY;
  return process.env.TURNSTILE_SECRET_KEY || DUMMY_SECRET_KEY;
}

// Verifies a widget token against Cloudflare's siteverify endpoint — never
// trust the frontend alone. Returns false (rather than throwing) for any
// missing token or verification failure, so callers can fail fast with one
// simple check.
export async function verifyTurnstileToken(token: string | undefined | null, remoteip?: string): Promise<boolean> {
  if (!token) return false;

  const body = new URLSearchParams({ secret: getTurnstileSecretKey(), response: token });
  if (remoteip) body.append("remoteip", remoteip);

  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error("[verifyTurnstileToken] siteverify request failed:", err);
    return false;
  }
}
