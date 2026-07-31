import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Login is the only limiter on a 5-minute window (user request, July 23,
// 2026, revised) — every other limiter below was reverted back to its
// original duration after a brief stint where all of them were flattened
// to 5 minutes.
export const loginRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "5 m"), // 5 attempts per 5 min
  prefix: "ratelimit:login",
});

export const registerRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(3, "1 h"), // 3 accounts per hour
  prefix: "ratelimit:register",
});

// Raised in dev so local testing doesn't get stuck waiting out the 1h window — prod stays at 3.
const passwordResetLimit = process.env.NODE_ENV === "production" ? 3 : 20;

export const passwordResetRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(passwordResetLimit, "1 h"),
  prefix: "ratelimit:password-reset",
});

// Same reasoning/shape as passwordResetRateLimit — prevents the "resend
// verification email" action from being used to spam an inbox.
const resendVerificationLimit = process.env.NODE_ENV === "production" ? 3 : 20;

export const resendVerificationRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(resendVerificationLimit, "1 h"),
  prefix: "ratelimit:resend-verification",
});

// Same reasoning/shape as resendVerificationRateLimit — this only ever
// emails the account holder's own inbox, but the same defensive pattern
// keeps the "request account deletion" action from being spammed.
const deleteAccountRequestLimit = process.env.NODE_ENV === "production" ? 3 : 20;

export const deleteAccountRequestRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(deleteAccountRequestLimit, "1 h"),
  prefix: "ratelimit:delete-account-request",
});

// Keyed by playerId (an authenticated action), not IP — 5/day is enough for
// a legitimate TO running several brackets, while stopping rapid-fire spam.
export const createTournamentRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "1 d"),
  prefix: "ratelimit:create-tournament",
});

// SECURITY (July 31, 2026) — /api/upload had NO rate limit at all. It only
// checks that SOMEONE is signed in, so any registered account could push
// unlimited files (up to 8-15MB each) straight into the Blob store, which is
// on a hard 1GB Hobby quota shared by the whole site — exhausting it breaks
// avatar/logo/banner uploads for every real user. Keyed by playerId (an
// authenticated action) rather than IP, same as createTournamentRateLimit.
// 30/hour is far above any real editing session (avatar + a few banners)
// while making bulk storage exhaustion impractical.
export const uploadRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, "1 h"),
  prefix: "ratelimit:upload",
});

// Next.js 15+ dropped NextRequest#ip — Vercel's edge network sets these headers instead.
// Accepts any Web-standard Request (NextRequest, or the raw Request NextAuth's authorize() receives).
export function getClientIp(req: Request): string {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
