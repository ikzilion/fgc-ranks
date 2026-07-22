import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Every limiter below uses a flat 5-minute window (user request, July 23,
// 2026) — previously each had its own duration (15m/1h/1d, noted per limiter
// below for reference). Uniform across every account, no role-based
// exceptions (an ADMIN/TO account is rate-limited identically to anyone else
// — see lib/auth.ts's authorize(), which never branches on role).
export const loginRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "5 m"), // 5 attempts per 5 min (was 15 min)
  prefix: "ratelimit:login",
});

export const registerRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(3, "5 m"), // 3 accounts per 5 min (was 1 hour)
  prefix: "ratelimit:register",
});

// Raised in dev so local testing doesn't get stuck waiting out the window — prod stays at 3.
const passwordResetLimit = process.env.NODE_ENV === "production" ? 3 : 20;

export const passwordResetRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(passwordResetLimit, "5 m"), // was 1 hour
  prefix: "ratelimit:password-reset",
});

// Same reasoning/shape as passwordResetRateLimit — prevents the "resend
// verification email" action from being used to spam an inbox.
const resendVerificationLimit = process.env.NODE_ENV === "production" ? 3 : 20;

export const resendVerificationRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(resendVerificationLimit, "5 m"), // was 1 hour
  prefix: "ratelimit:resend-verification",
});

// Same reasoning/shape as resendVerificationRateLimit — this only ever
// emails the account holder's own inbox, but the same defensive pattern
// keeps the "request account deletion" action from being spammed.
const deleteAccountRequestLimit = process.env.NODE_ENV === "production" ? 3 : 20;

export const deleteAccountRequestRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(deleteAccountRequestLimit, "5 m"), // was 1 hour
  prefix: "ratelimit:delete-account-request",
});

// Keyed by playerId (an authenticated action), not IP.
export const createTournamentRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "5 m"), // 5 per 5 min (was 5 per day)
  prefix: "ratelimit:create-tournament",
});

// Next.js 15+ dropped NextRequest#ip — Vercel's edge network sets these headers instead.
// Accepts any Web-standard Request (NextRequest, or the raw Request NextAuth's authorize() receives).
export function getClientIp(req: Request): string {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
