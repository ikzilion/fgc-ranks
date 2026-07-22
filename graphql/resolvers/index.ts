import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomBytes, createHash } from "crypto";
import { del } from "@vercel/blob";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db";
import { User, UserRole } from "@/models/User";
import { isAdminOrAbove, isSuperAdmin } from "@/lib/roles";
import { Player } from "@/models/Player";
import { Tournament, TournamentStatus } from "@/models/Tournament";
import { Entrant } from "@/models/Entrant";
import { Match, MatchStatus } from "@/models/Match";
import { Bracket } from "@/models/Bracket";
import { Notification } from "@/models/Notification";
import { NewsPost } from "@/models/NewsPost";
import { Event, EventStatus } from "@/models/Event";
import { Game } from "@/models/Game";
import { TORequest, TORequestStatus } from "@/models/TORequest";
import {
  loginRateLimit,
  registerRateLimit,
  passwordResetRateLimit,
  resendVerificationRateLimit,
  deleteAccountRequestRateLimit,
  createTournamentRateLimit,
  getClientIp,
} from "@/lib/rateLimit";
import { sendPasswordResetEmail, sendVerificationEmail, sendAccountDeletionEmail } from "@/lib/email";
import { verifyTurnstileToken } from "@/lib/turnstile";
import { buildDoubleEliminationBracket, resolveSeedOrder, advanceBracketMatch, nextPowerOfTwo, SeedingMethod } from "@/lib/bracket";
import { getNextSequence } from "@/lib/counter";
import { computeRankingPoints, computeRankingPointsForPlayers } from "@/lib/ranking";
import { formatPlayerNumber } from "@/lib/playerId";
import { formatEventNumber } from "@/lib/eventId";
import { NextRequest } from "next/server";

const JWT_SECRET = process.env.NEXTAUTH_SECRET || "dev-secret";

// Identifies which field a MongoDB E11000 duplicate-key error tripped on
// (e.g. "email", "tag") so a catch block can blame the right field instead
// of assuming — used by register, where User.email and Player.tag are both
// unique indexes a signup can collide on. keyPattern/keyValue are the
// reliable modern-driver fields; the index-name regex is a fallback for
// older error shapes (index names conventionally look like "email_1").
function duplicateKeyField(err: any): string | null {
  if (err?.keyPattern) return Object.keys(err.keyPattern)[0] ?? null;
  if (err?.keyValue) return Object.keys(err.keyValue)[0] ?? null;
  const match = /index:\s*(\w+?)_\d+/.exec(err?.message ?? "");
  return match ? match[1] : null;
}

// Shared soft-delete implementation — used by both the ADMIN deletePlayer
// mutation and the self-service confirmAccountDeletion flow, so the two
// paths can't drift apart. Assumes the caller has already authorized the
// action (and already fetched `player`); this function itself performs no
// permission checks. Deletes the avatar from Vercel Blob, scrubs personal
// info, anonymizes the tag, and disables login on the linked User.
async function softDeletePlayer(player: any): Promise<void> {
  if (player.isDeleted) return; // already deleted — idempotent

  if (player.avatarUrl) {
    try {
      await del(player.avatarUrl);
    } catch (err) {
      console.error("[softDeletePlayer] Failed to delete avatar blob:", err);
    }
  }

  const deletedAt = new Date();
  // Suffix guarantees uniqueness against the Player.tag unique index even
  // across repeated deletions.
  const anonymizedTag = `Deleted Player #${player._id.toString().slice(-8)}`;

  await Player.findByIdAndUpdate(player._id, {
    isDeleted: true,
    deletedAt,
    tag: anonymizedTag,
    avatarUrl: "",
    region: "",
    team: "",
  });

  if (player.userId) {
    await User.findByIdAndUpdate(player.userId, {
      isDeleted: true,
      deletedAt,
      // Frees up the real email for reuse and removes it from the account
      // entirely; the random passwordHash is redundant with authorize()'s
      // isDeleted check but scrubs the credential too.
      email: `deleted-${player._id.toString()}@deleted.local`,
      passwordHash: await bcrypt.hash(randomBytes(32).toString("hex"), 10),
      deleteAccountTokenHash: null,
      deleteAccountTokenExpiry: null,
    });
  }
}

// A player can manage a tournament if they're a global ADMIN, or if their
// playerId is in that specific tournament's organizers list (Tournament
// Organizer / TO access — scoped per-tournament, not a global role).
function isOrganizer(tournament: any, playerId?: string, role?: string): boolean {
  if (isAdminOrAbove(role)) return true;
  if (!playerId || !tournament?.organizers) return false;
  return tournament.organizers.some((orgId: any) => orgId.toString() === playerId);
}

// Same pattern as isOrganizer, for Events — managerIds is the single
// source of truth (the creator is always included in it at creation, see
// createEvent), so this one check covers both "is the creator" and "is a
// co-manager" with no separate branching.
function isEventManager(event: any, playerId?: string, role?: string): boolean {
  if (isAdminOrAbove(role)) return true;
  if (!playerId || !event?.managerIds) return false;
  return event.managerIds.some((id: any) => id.toString() === playerId);
}

// Shared by createTournament and requestTOStatus — the same minimum
// account-trust threshold (Security Push Phase 4, narrowed to account age
// alone in commit 0c3c1b1). Takes the already-fetched User doc rather than
// a playerId so callers that already loaded it (both do, for other reasons)
// don't pay for a second lookup.
function isAccountOldEnough(user: { createdAt?: Date | string } | null): boolean {
  if (!user) return false;
  const accountAgeMs = Date.now() - new Date(user.createdAt!).getTime();
  return accountAgeMs > 24 * 60 * 60 * 1000;
}

// Shared by reportResult/editMatchResult — resolves the winner/loser and the
// fields to persist, for either a normally-scored result or a forfeit. A
// forfeit skips score validation entirely (no numeric score is stored) and
// derives the winner as whichever player didn't forfeit.
function resolveMatchOutcome(
  match: { player1Id: any; player2Id: any },
  args: { player1Score?: number | null; player2Score?: number | null; isForfeit?: boolean | null; forfeitingPlayerId?: string | null }
) {
  const { player1Score, player2Score, isForfeit, forfeitingPlayerId } = args;

  if (isForfeit) {
    if (!forfeitingPlayerId) throw new Error("forfeitingPlayerId is required when reporting a forfeit");
    const p1 = match.player1Id.toString();
    const p2 = match.player2Id.toString();
    if (forfeitingPlayerId !== p1 && forfeitingPlayerId !== p2) {
      throw new Error("forfeitingPlayerId must be one of this match's players");
    }
    const winnerId = forfeitingPlayerId === p1 ? match.player2Id : match.player1Id;
    const loserId = forfeitingPlayerId === p1 ? match.player1Id : match.player2Id;
    return { winnerId, loserId, updateFields: { winnerId, isForfeit: true, player1Score: 0, player2Score: 0, status: MatchStatus.COMPLETED } };
  }

  if (player1Score == null || player2Score == null) {
    throw new Error("player1Score and player2Score are required unless reporting a forfeit");
  }
  if (player1Score === player2Score) throw new Error("Scores cannot be tied.");
  const winnerId = player1Score > player2Score ? match.player1Id : match.player2Id;
  const loserId = player1Score > player2Score ? match.player2Id : match.player1Id;
  return { winnerId, loserId, updateFields: { winnerId, isForfeit: false, player1Score, player2Score, status: MatchStatus.COMPLETED } };
}

// A bracket match can only be edited if nothing downstream has been played
// yet — a full cascade-reversal (unwinding a whole chain of subsequent
// results) is explicitly out of scope for now. Checks the winner's next
// match and the loser's next-losers-bracket match, plus the Grand Final's
// reset match as a special case: the Grand Final itself has no nextMatchId
// of its own, so a reset having already been created (meaning a second game
// was played) wouldn't show up in either of the other two checks.
async function assertBracketMatchEditable(match: any) {
  if (match.nextMatchId) {
    const next = await Match.findById(match.nextMatchId);
    if (next && next.status === MatchStatus.COMPLETED) {
      throw new Error(`Can't edit this result — "${next.round}" has already been played. Editing would require reversing that result too, which isn't supported.`);
    }
  }
  if (match.nextLoserMatchId) {
    const nextLoser = await Match.findById(match.nextLoserMatchId);
    if (nextLoser && nextLoser.status === MatchStatus.COMPLETED) {
      throw new Error(`Can't edit this result — "${nextLoser.round}" has already been played. Editing would require reversing that result too, which isn't supported.`);
    }
  }
  if (match.bracketSide === "GRAND_FINAL") {
    const reset = await Match.findOne({ bracketId: match.bracketId, bracketSide: "GRAND_FINAL_RESET" });
    if (reset) {
      throw new Error("Can't edit this result — the bracket already went to a reset match (a second game was played). Editing would require unwinding that too, which isn't supported.");
    }
  }
}

export const resolvers = {
  // ─── Queries ───────────────────────────────────────────────────────────────

  Query: {
    // Notifications
    myNotifications: async (_: unknown, __: unknown, { playerId }: { playerId?: string }) => {
      if (!playerId) return [];
      await connectToDatabase();
      return Notification.find({ playerId }).sort({ createdAt: -1 }).limit(30);
    },

    unreadNotificationCount: async (_: unknown, __: unknown, { playerId }: { playerId?: string }) => {
      if (!playerId) return 0;
      await connectToDatabase();
      return Notification.countDocuments({ playerId, read: false });
    },

    // Players
    // Excludes soft-deleted players — `$ne: true` (not `$eq: false`) so
    // pre-existing documents that predate the `isDeleted` field (no value
    // set at all) still match, with no backfill migration needed. This is
    // the single query every player search/picker in the app goes through
    // (Players list, tournament invite/organizer pickers, Event manager
    // picker, head-to-head opponent picker), so filtering it here covers
    // all of them at once.
    players: async (_: unknown, { limit = 20, offset = 0 }: { limit?: number; offset?: number }) => {
      await connectToDatabase();
      // points is now computed (see lib/ranking.ts), not a stored field, so
      // sorting by it means fetching everyone, ranking in memory, then
      // paginating — fine at this app's scale (tens of players).
      const allPlayers = await Player.find({ isDeleted: { $ne: true } });
      const pointsById = await computeRankingPointsForPlayers(allPlayers.map((p: any) => p._id.toString()));
      const sorted = [...allPlayers].sort(
        (a: any, b: any) => (pointsById.get(b._id.toString()) ?? 0) - (pointsById.get(a._id.toString()) ?? 0)
      );
      return sorted.slice(offset, offset + limit);
    },

    player: async (_: unknown, { id }: { id: string }) => {
      await connectToDatabase();
      return await Player.findById(id);
    },

    playerByTag: async (_: unknown, { tag }: { tag: string }) => {
      await connectToDatabase();
      return await Player.findOne({ tag });
    },

    // Tournaments
    // Query-time filter, not a background job — nothing is ever deleted,
    // and tournament(id) below is deliberately NOT filtered, so a stale
    // tournament's direct URL and its own creator/organizer view keep
    // working; it just drops out of this general public listing.
    tournaments: async (
      _: unknown,
      { status, limit = 20, offset = 0 }: { status?: string; limit?: number; offset?: number }
    ) => {
      await connectToDatabase();
      const filter: any = status ? { status } : {};
      const staleZeroEntrantCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      filter.$nor = [
        { status: TournamentStatus.UPCOMING, entrantCount: 0, createdAt: { $lt: staleZeroEntrantCutoff } },
      ];
      return await Tournament.find(filter).sort({ startDate: -1 }).skip(offset).limit(limit);
    },

    tournament: async (_: unknown, { id }: { id: string }) => {
      await connectToDatabase();
      return await Tournament.findById(id);
    },

    // Events
    // Public browse list — PENDING/REJECTED Events are excluded entirely,
    // even for their own creator/managers (they view/edit those via
    // event(id) instead, not this list — see the Event review-queue plan).
    events: async (_: unknown, { limit = 50, offset = 0 }: { limit?: number; offset?: number }) => {
      await connectToDatabase();
      return await Event.find({ status: EventStatus.APPROVED }).sort({ createdAt: -1 }).skip(offset).limit(limit);
    },

    event: async (_: unknown, { id }: { id: string }) => {
      await connectToDatabase();
      return await Event.findById(id);
    },

    eventByDisplayId: async (_: unknown, { displayId }: { displayId: string }) => {
      await connectToDatabase();
      // "EVT-000001" -> 1. Anything that doesn't parse to a positive
      // integer can't match a real eventNumber, so just return null rather
      // than let an ambiguous/garbage query hit the database.
      const match = displayId.trim().match(/^EVT-0*(\d+)$/i);
      if (!match) return null;
      const eventNumber = Number(match[1]);
      if (!eventNumber) return null;
      // APPROVED-only — same reasoning as `events` above: a PENDING/REJECTED
      // Event can't be looked up and linked to a Tournament by anyone,
      // including its own creator, until it's approved.
      return await Event.findOne({ eventNumber, status: EventStatus.APPROVED });
    },

    // Review queue data source — ADMIN-only.
    pendingEvents: async (_: unknown, __: unknown, { role }: { role?: string }) => {
      if (!isAdminOrAbove(role)) throw new Error("Not authorized");
      await connectToDatabase();
      return await Event.find({ status: EventStatus.PENDING }).sort({ createdAt: -1 });
    },

    // Matches
    matches: async (_: unknown, { tournamentId }: { tournamentId: string }) => {
      await connectToDatabase();
      return await Match.find({ tournamentId });
    },

    match: async (_: unknown, { id }: { id: string }) => {
      await connectToDatabase();
      return await Match.findById(id);
    },

    // Games
    // Curated Games (real documents) plus a synthetic entry for any distinct
    // Tournament.game value that isn't curated yet — see models/Game.ts for
    // why this drift-guard exists. Orphan entries are plain objects, not
    // Mongoose docs, so `id` is set directly (no `_id` virtual to fall back
    // on) using a prefix that can never collide with a real ObjectId hex string.
    games: async () => {
      await connectToDatabase();
      const curated = await Game.find();
      const curatedNames = new Set(curated.map((g: any) => g.name));
      const distinctTournamentGames: string[] = await Tournament.distinct("game");
      const orphans = distinctTournamentGames
        .filter(name => name && !curatedNames.has(name))
        .map(name => ({ id: `orphan-${Buffer.from(name).toString("base64url")}`, name, iconUrl: "" }));
      return [...curated, ...orphans].sort((a: any, b: any) => a.name.localeCompare(b.name));
    },

    // TO permission overhaul
    myTORequest: async (_: unknown, __: unknown, { playerId }: { playerId?: string }) => {
      if (!playerId) return null;
      await connectToDatabase();
      return TORequest.findOne({ playerId }).sort({ createdAt: -1 });
    },

    pendingTORequests: async (_: unknown, __: unknown, { role }: { role?: string }) => {
      if (!isAdminOrAbove(role)) throw new Error("Not authorized");
      await connectToDatabase();
      return TORequest.find({ status: TORequestStatus.PENDING }).sort({ createdAt: -1 });
    },

    // News
    newsPosts: async (_: unknown, { limit = 20, offset = 0, eventId }: { limit?: number; offset?: number; eventId?: string }) => {
      await connectToDatabase();
      // eventId omitted -> global homepage posts only. Mongo's `null`
      // query matches both explicitly-null AND missing fields, so this
      // correctly includes every pre-Events post that has no eventId field
      // at all, same as it always has.
      const filter = eventId ? { eventId } : { eventId: null };
      return await NewsPost.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit);
    },

    // Auth
    me: async (_: unknown, __: unknown, { userId }: { userId?: string }) => {
      if (!userId) return null;
      await connectToDatabase();
      return await User.findById(userId);
    },
  },

  // ─── Mutations ─────────────────────────────────────────────────────────────

  Mutation: {
    // Auth
    register: async (
      _: unknown,
      { email, password, tag, turnstileToken }: { email: string; password: string; tag: string; turnstileToken: string },
      { req }: { req: NextRequest }
    ) => {
      const ip = getClientIp(req);

      // CAPTCHA check runs first — fail fast before rate limiting, trust
      // checks, or touching the database at all.
      const captchaValid = await verifyTurnstileToken(turnstileToken, ip);
      if (!captchaValid) throw new Error("CAPTCHA verification failed. Please complete the challenge and try again.");

      const { success } = await registerRateLimit.limit(ip);
      if (!success) throw new Error("Too many accounts created from this IP. Please try again later.");

      await connectToDatabase();
      const passwordHash = await bcrypt.hash(password, 10);

      // New accounts start unverified — same hashed-token-with-expiry
      // pattern as the password reset flow, just a longer expiry (24h,
      // standard for email verification vs. the 1h reset window).
      const rawToken = randomBytes(32).toString("hex");
      const emailVerificationTokenHash = createHash("sha256").update(rawToken).digest("hex");
      const emailVerificationTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

      let user;
      try {
        user = await User.create({
          email,
          passwordHash,
          emailVerified: false,
          emailVerificationTokenHash,
          emailVerificationTokenExpiry,
        });
      } catch (err: any) {
        if (err?.code === 11000) throw new Error("This email is already registered. Try signing in instead.");
        throw err;
      }

      const playerNumber = await getNextSequence("playerNumber");
      let player;
      try {
        player = await Player.create({ userId: user._id, tag, playerNumber });
      } catch (err: any) {
        // The User row was already created with the (now-unique) email —
        // roll it back so a failed registration doesn't silently consume
        // that email and block the person from ever retrying with it.
        await User.findByIdAndDelete(user._id);
        if (err?.code === 11000) {
          const field = duplicateKeyField(err);
          if (field === "tag") throw new Error("That player tag is already taken. Please choose another.");
          throw new Error("That information is already in use. Please try different values.");
        }
        throw err;
      }
      await User.findByIdAndUpdate(user._id, { playerId: player._id });

      const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
      const verifyUrl = `${baseUrl}/verify-email?token=${rawToken}`;
      await sendVerificationEmail(email, verifyUrl);

      const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: "7d" });
      return { token, user };
    },

    login: async (
      _: unknown,
      { email, password }: { email: string; password: string },
      { req }: { req: NextRequest }
    ) => {
      const ip = getClientIp(req);
      const { success } = await loginRateLimit.limit(ip);
      if (!success) throw new Error("Too many login attempts. Please try again later.");

      await connectToDatabase();
      const user = await User.findOne({ email });
      if (!user) throw new Error("Invalid email or password");
      // Same generic error as a wrong password — don't leak deletion status.
      if (user.isDeleted) throw new Error("Invalid email or password");
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) throw new Error("Invalid email or password");
      // `=== false` (not falsy) — grandfathered legacy accounts (field
      // never set) must NOT be blocked here.
      if (user.emailVerified === false) throw new Error("Please verify your email before signing in. Check your inbox for the verification link.");
      const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: "7d" });
      return { token, user };
    },

    requestPasswordReset: async (
      _: unknown,
      { email }: { email: string },
      { req }: { req: NextRequest }
    ) => {
      const ip = getClientIp(req);
      const { success } = await passwordResetRateLimit.limit(ip);
      if (!success) throw new Error("Too many requests. Please try again later.");

      await connectToDatabase();
      const user = await User.findOne({ email });

      // Only generate/send a token if the account exists, but always return
      // true either way — this prevents the endpoint from being used to
      // enumerate which emails have accounts.
      if (user) {
        const rawToken = randomBytes(32).toString("hex");
        const resetTokenHash = createHash("sha256").update(rawToken).digest("hex");
        const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
        await User.findByIdAndUpdate(user._id, { resetTokenHash, resetTokenExpiry });

        const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
        const resetUrl = `${baseUrl}/reset-password?token=${rawToken}`;
        await sendPasswordResetEmail(email, resetUrl);
      }

      return true;
    },

    resetPassword: async (
      _: unknown,
      { token, newPassword }: { token: string; newPassword: string }
    ) => {
      await connectToDatabase();
      const resetTokenHash = createHash("sha256").update(token).digest("hex");
      const user = await User.findOne({ resetTokenHash, resetTokenExpiry: { $gt: new Date() } });
      if (!user) throw new Error("Invalid or expired reset link");

      const passwordHash = await bcrypt.hash(newPassword, 10);
      await User.findByIdAndUpdate(user._id, {
        passwordHash,
        resetTokenHash: null,
        resetTokenExpiry: null,
      });
      return true;
    },

    verifyEmail: async (_: unknown, { token }: { token: string }) => {
      await connectToDatabase();
      const emailVerificationTokenHash = createHash("sha256").update(token).digest("hex");
      const user = await User.findOne({
        emailVerificationTokenHash,
        emailVerificationTokenExpiry: { $gt: new Date() },
      });
      if (!user) throw new Error("Invalid or expired verification link");

      await User.findByIdAndUpdate(user._id, {
        emailVerified: true,
        emailVerificationTokenHash: null,
        emailVerificationTokenExpiry: null,
      });
      return true;
    },

    resendVerificationEmail: async (
      _: unknown,
      { email }: { email: string },
      { req }: { req: NextRequest }
    ) => {
      const ip = getClientIp(req);
      const { success } = await resendVerificationRateLimit.limit(ip);
      if (!success) throw new Error("Too many requests. Please try again later.");

      await connectToDatabase();
      const user = await User.findOne({ email });

      // Only send if there's an account that actually still needs
      // verifying (`=== false`, not falsy — never re-verify a grandfathered
      // account), but always return true either way, same
      // anti-enumeration convention as requestPasswordReset.
      if (user && user.emailVerified === false) {
        const rawToken = randomBytes(32).toString("hex");
        const emailVerificationTokenHash = createHash("sha256").update(rawToken).digest("hex");
        const emailVerificationTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await User.findByIdAndUpdate(user._id, { emailVerificationTokenHash, emailVerificationTokenExpiry });

        const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
        const verifyUrl = `${baseUrl}/verify-email?token=${rawToken}`;
        await sendVerificationEmail(email, verifyUrl);
      }

      return true;
    },

    // Self-service account deletion, step 1 — authenticated, always targets
    // the calling session's own account (no id argument, nothing for a
    // caller to point at someone else's account). Rate-limited the same way
    // as resendVerificationEmail/requestPasswordReset for consistency, even
    // though this only ever emails the account holder's own inbox.
    requestAccountDeletion: async (
      _: unknown,
      __: unknown,
      // Untyped context here — combining playerId + req (needed together
      // for this resolver only) confuses Apollo's context-type inference
      // across the resolver map, since every other resolver only ever
      // destructures one or the other, never both.
      { playerId, req }: any
    ) => {
      if (!playerId) throw new Error("Not authorized");

      const ip = getClientIp(req);
      const { success } = await deleteAccountRequestRateLimit.limit(ip);
      if (!success) throw new Error("Too many requests. Please try again later.");

      await connectToDatabase();
      const player = await Player.findById(playerId);
      if (!player?.userId) throw new Error("Player not found");
      const user = await User.findById(player.userId);
      if (!user) throw new Error("Account not found");
      if (user.isDeleted) return true; // already deleted — idempotent, nothing to send

      const rawToken = randomBytes(32).toString("hex");
      const deleteAccountTokenHash = createHash("sha256").update(rawToken).digest("hex");
      const deleteAccountTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour, same as password reset
      await User.findByIdAndUpdate(user._id, { deleteAccountTokenHash, deleteAccountTokenExpiry });

      const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
      const confirmUrl = `${baseUrl}/delete-account/confirm?token=${rawToken}`;
      await sendAccountDeletionEmail(user.email, confirmUrl);

      return true;
    },

    // Self-service account deletion, step 2 — token-only, no login required
    // to use the link (same precedent as resetPassword: clicking an email
    // link from a different device/session is normal). Runs the exact same
    // soft-delete as the ADMIN deletePlayer mutation via softDeletePlayer().
    confirmAccountDeletion: async (_: unknown, { token }: { token: string }) => {
      await connectToDatabase();
      const deleteAccountTokenHash = createHash("sha256").update(token).digest("hex");
      const user = await User.findOne({
        deleteAccountTokenHash,
        deleteAccountTokenExpiry: { $gt: new Date() },
      });
      if (!user) throw new Error("Invalid or expired confirmation link");

      const player = user.playerId ? await Player.findById(user.playerId) : null;
      if (!player) throw new Error("Player not found");

      await softDeletePlayer(player);
      return true;
    },

    // Players
    updatePlayer: async (
      _: unknown,
      { id, tag, region, avatarUrl, characters, team }: { id: string; tag?: string; region?: string; avatarUrl?: string; characters?: string[]; team?: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      if (playerId !== id && !isAdminOrAbove(role)) throw new Error("Not authorized");

      await connectToDatabase();
      const update: any = { tag, region, characters };
      if (avatarUrl !== undefined) update.avatarUrl = avatarUrl;
      if (team !== undefined) update.team = team;
      return Player.findByIdAndUpdate(id, update, { new: true });
    },

    // ADMIN-only soft-delete. Keeps the Player document (and every
    // Match/Entrant/Tournament/Event reference to it) intact — only scrubs
    // personal info and disables login. See models/Player.ts and
    // models/User.ts for what `isDeleted` means on each.
    deletePlayer: async (
      _: unknown,
      { id }: { id: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      if (!isAdminOrAbove(role)) throw new Error("Not authorized");
      // Guards against an admin locking themselves out by mistake.
      if (playerId === id) throw new Error("You can't delete your own account");

      await connectToDatabase();
      const player = await Player.findById(id);
      if (!player) throw new Error("Player not found");

      await softDeletePlayer(player);
      return true;
    },

    // SUPER_ADMIN-only — the one in-app way to grant/revoke ADMIN. Regular
    // ADMINs cannot call these (isSuperAdmin, not isAdminOrAbove).
    grantAdmin: async (
      _: unknown,
      { playerId }: { playerId: string },
      { role }: { role?: string }
    ) => {
      if (!isSuperAdmin(role)) throw new Error("Not authorized");
      await connectToDatabase();
      const player = await Player.findById(playerId);
      if (!player) throw new Error("Player not found");
      if (!player.userId) throw new Error("This player has no linked account");

      const user = await User.findById(player.userId);
      if (!user) throw new Error("Linked account not found");
      // Refuses to downgrade a Super Admin to plain ADMIN — guards against
      // accidentally granting "admin" to a Super Admin account (including
      // the caller's own) and losing the SUPER_ADMIN tier.
      if (user.role === UserRole.SUPER_ADMIN) throw new Error("This account is already Super Admin");

      await User.findByIdAndUpdate(player.userId, { role: UserRole.ADMIN });
      return true;
    },

    revokeAdmin: async (
      _: unknown,
      { playerId }: { playerId: string },
      { role }: { role?: string }
    ) => {
      if (!isSuperAdmin(role)) throw new Error("Not authorized");
      await connectToDatabase();
      const player = await Player.findById(playerId);
      if (!player) throw new Error("Player not found");
      if (!player.userId) throw new Error("This player has no linked account");

      const user = await User.findById(player.userId);
      if (!user) throw new Error("Linked account not found");
      // The Super Admin account can't be demoted through this mutation —
      // there's no in-app way to grant SUPER_ADMIN back, so this would be
      // an irreversible self-lockout (or lockout of the one fixed account).
      if (user.role === UserRole.SUPER_ADMIN) throw new Error("Cannot revoke the Super Admin account");

      await User.findByIdAndUpdate(player.userId, { role: UserRole.PLAYER });
      return true;
    },

    // TO permission overhaul — request/approval flow.
    requestTOStatus: async (
      _: unknown,
      { reason }: { reason?: string },
      { playerId }: { playerId?: string }
    ) => {
      if (!playerId) throw new Error("Not authorized");
      await connectToDatabase();

      const player = await Player.findById(playerId);
      const user = player?.userId ? await User.findById(player.userId) : null;
      if (user?.isTO) throw new Error("You already have TO status.");
      if (!isAccountOldEnough(user)) {
        throw new Error("Your account needs to be at least 24 hours old before requesting TO status.");
      }

      // Enforced here (not just the UI disabling the button) — a raw API
      // call can't queue a second request while one is already pending, and
      // a rejected request blocks re-requesting until its 7-day cooldown
      // (measured from resolvedAt) has passed. Only the single most recent
      // request matters — an old rejection from before a since-approved (and
      // later revoked) cycle should NOT re-trigger its cooldown.
      const lastRequest = await TORequest.findOne({ playerId }).sort({ createdAt: -1 });
      if (lastRequest?.status === TORequestStatus.PENDING) {
        throw new Error("You already have a pending TO request.");
      }
      if (lastRequest?.status === TORequestStatus.REJECTED && lastRequest.resolvedAt) {
        const cooldownMs = 7 * 24 * 60 * 60 * 1000;
        const elapsedMs = Date.now() - new Date(lastRequest.resolvedAt).getTime();
        if (elapsedMs < cooldownMs) {
          const daysLeft = Math.ceil((cooldownMs - elapsedMs) / (24 * 60 * 60 * 1000));
          throw new Error(`Your last TO request was rejected. You can request again in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`);
        }
      }

      return TORequest.create({ playerId, reason: reason?.trim() || "" });
    },

    // ADMIN-only. Approving is what actually grants TO status.
    approveTORequest: async (
      _: unknown,
      { id }: { id: string },
      { role }: { role?: string }
    ) => {
      if (!isAdminOrAbove(role)) throw new Error("Not authorized");
      await connectToDatabase();
      const request = await TORequest.findById(id);
      if (!request) throw new Error("Request not found");
      if (request.status !== TORequestStatus.PENDING) throw new Error("This request has already been resolved.");

      const player = await Player.findById(request.playerId);
      if (player?.userId) await User.findByIdAndUpdate(player.userId, { isTO: true });

      return TORequest.findByIdAndUpdate(id, { status: TORequestStatus.APPROVED, resolvedAt: new Date() }, { new: true });
    },

    // ADMIN-only. Reason is required, same convention as rejectEvent.
    rejectTORequest: async (
      _: unknown,
      { id, reason }: { id: string; reason: string },
      { role }: { role?: string }
    ) => {
      if (!isAdminOrAbove(role)) throw new Error("Not authorized");
      if (!reason.trim()) throw new Error("A rejection reason is required");
      await connectToDatabase();
      const request = await TORequest.findById(id);
      if (!request) throw new Error("Request not found");
      if (request.status !== TORequestStatus.PENDING) throw new Error("This request has already been resolved.");

      return TORequest.findByIdAndUpdate(
        id,
        { status: TORequestStatus.REJECTED, rejectionReason: reason.trim(), resolvedAt: new Date() },
        { new: true }
      );
    },

    // ADMIN-only direct grant/revoke — mirrors grantAdmin/revokeAdmin, no
    // request required first (covers a real-world-trusted TO who hasn't
    // gotten around to requesting it).
    grantTOStatus: async (
      _: unknown,
      { playerId }: { playerId: string },
      { role }: { role?: string }
    ) => {
      if (!isAdminOrAbove(role)) throw new Error("Not authorized");
      await connectToDatabase();
      const player = await Player.findById(playerId);
      if (!player) throw new Error("Player not found");
      if (!player.userId) throw new Error("This player has no linked account");

      await User.findByIdAndUpdate(player.userId, { isTO: true });
      // A dangling PENDING request for this player is auto-resolved
      // (approved) rather than left sitting in the queue — both paths
      // result in the same TO status either way.
      await TORequest.updateMany(
        { playerId, status: TORequestStatus.PENDING },
        { status: TORequestStatus.APPROVED, resolvedAt: new Date() }
      );
      return true;
    },

    revokeTOStatus: async (
      _: unknown,
      { playerId }: { playerId: string },
      { role }: { role?: string }
    ) => {
      if (!isAdminOrAbove(role)) throw new Error("Not authorized");
      await connectToDatabase();
      const player = await Player.findById(playerId);
      if (!player) throw new Error("Player not found");
      if (!player.userId) throw new Error("This player has no linked account");

      await User.findByIdAndUpdate(player.userId, { isTO: false });
      return true;
    },

    // Tournaments
    createTournament: async (
      _: unknown,
      {
        name,
        game,
        startDate,
        logoUrl,
        isOnlineOnly,
        address,
        twitchUrl,
        format,
        capacity,
        entryFee,
        prizePot,
        eventId,
      }: {
        name: string;
        game: string;
        startDate: Date;
        logoUrl?: string;
        isOnlineOnly?: boolean;
        address?: string;
        twitchUrl?: string;
        format?: string;
        capacity?: number;
        entryFee?: string;
        prizePot?: string;
        eventId?: string;
      },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      if (!playerId) throw new Error("Not authorized");

      // Keyed by playerId (authenticated action), not IP.
      const { success } = await createTournamentRateLimit.limit(playerId);
      if (!success) throw new Error("You've created too many tournaments today. Please try again tomorrow.");

      await connectToDatabase();

      // Minimum trust threshold — anti-spam floor for ALL tournament
      // creation. Account age alone gates this (the "has entered a
      // tournament" alternative from Security Push Phase 4 was removed in
      // commit 0c3c1b1: a brand-new account can no longer bypass the 24h
      // wait just by joining someone else's tournament first).
      const player = await Player.findById(playerId);
      const user = player?.userId ? await User.findById(player.userId) : null;
      if (!isAccountOldEnough(user)) {
        throw new Error("Your account needs to be at least 24 hours old before you can create a tournament.");
      }

      // TO permission overhaul (user request, July 20, 2026): only an
      // admin-granted TO (User.isTO) or an admin themselves can create a
      // "full" tournament. Everyone else still can, but restricted — forced
      // PRIVATE (permanently; updateTournamentVisibility refuses PUBLIC on
      // an isRestricted tournament) and, per the isRestricted field's own
      // comment on the model, no stream background/sponsor banner and no
      // ranking points. Decided once here, at creation, and never
      // re-derived — a later TO grant/revoke doesn't retroactively change
      // an already-created tournament.
      const isRestricted = !isAdminOrAbove(role) && user?.isTO !== true;

      // eventId is client-resolved (the form looks it up by displayId and
      // shows a confirmation first) but still validated here server-side —
      // never trust a raw id from the client without confirming it's real.
      if (eventId) {
        const event = await Event.findById(eventId);
        if (!event) throw new Error("Event not found");
      }
      // The creator automatically becomes the tournament's first organizer.
      // Metadata fields are all optional at creation — schema defaults
      // (empty string / false / undefined) apply for anything omitted.
      return Tournament.create({
        name,
        game,
        startDate,
        organizers: [playerId],
        logoUrl,
        isOnlineOnly,
        address,
        twitchUrl,
        format,
        capacity,
        entryFee,
        prizePot,
        eventId: eventId || undefined,
        isRestricted,
        // Overrides the schema's PUBLIC default — omitted (letting the
        // default apply) for a full tournament, unchanged from before this
        // feature existed.
        ...(isRestricted ? { visibility: "PRIVATE" } : {}),
      });
    },

    updateTournamentDetails: async (
      _: unknown,
      {
        id,
        logoUrl,
        isOnlineOnly,
        address,
        twitchUrl,
        format,
        capacity,
        entryFee,
        prizePot,
        eventId,
      }: {
        id: string;
        logoUrl?: string;
        isOnlineOnly?: boolean;
        address?: string;
        twitchUrl?: string;
        format?: string;
        capacity?: number;
        entryFee?: string;
        prizePot?: string;
        eventId?: string;
      },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const tournament = await Tournament.findById(id);
      if (!tournament) throw new Error("Tournament not found");
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");

      // Partial-update style, same pattern as updateTournamentStreamAssets —
      // only fields actually provided get applied.
      const update: any = {};
      if (logoUrl !== undefined) update.logoUrl = logoUrl;
      if (isOnlineOnly !== undefined) update.isOnlineOnly = isOnlineOnly;
      if (address !== undefined) update.address = address;
      if (twitchUrl !== undefined) update.twitchUrl = twitchUrl;
      if (format !== undefined) update.format = format;
      if (capacity !== undefined) update.capacity = capacity;
      if (entryFee !== undefined) update.entryFee = entryFee;
      if (prizePot !== undefined) update.prizePot = prizePot;
      if (eventId !== undefined) {
        if (eventId) {
          // Same server-side validation as createTournament — the client
          // already confirmed this Event exists via eventByDisplayId, but
          // never trust that alone.
          const event = await Event.findById(eventId);
          if (!event) throw new Error("Event not found");
          update.eventId = eventId;
        } else {
          // Explicit empty/null clears the link — unlinking, not "leave
          // unchanged" (that's what omitting the arg entirely does).
          update.eventId = null;
        }
      }

      return Tournament.findByIdAndUpdate(id, update, { new: true });
    },

    updateTournamentStatus: async (
      _: unknown,
      { id, status }: { id: string; status: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const tournament = await Tournament.findById(id);
      if (!tournament) throw new Error("Tournament not found");
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");

      const updated = await Tournament.findByIdAndUpdate(id, { status }, { new: true });

      // Notify all entrants when a tournament goes live or ends
      if (status === "LIVE" || status === "ENDED") {
        const entrants = await Entrant.find({ tournamentId: id });
        const notifType = status === "LIVE" ? "TOURNAMENT_LIVE" : "TOURNAMENT_ENDED";
        const msg = status === "LIVE" ? `${updated.name} is now live!` : `${updated.name} has ended.`;
        await Notification.create(
          entrants.map(e => ({ playerId: e.playerId, type: notifType, message: msg, link: `/tournaments/${id}` }))
        );
      }

      return updated;
    },

    cancelTournament: async (
      _: unknown,
      { id, reason }: { id: string; reason: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      if (!reason || !reason.trim()) throw new Error("A cancellation reason is required.");

      await connectToDatabase();
      const tournament = await Tournament.findById(id);
      if (!tournament) throw new Error("Tournament not found");
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");
      if (tournament.status === "CANCELLED") throw new Error("Tournament is already cancelled.");

      const updated = await Tournament.findByIdAndUpdate(
        id,
        { status: "CANCELLED", cancellationReason: reason.trim() },
        { new: true }
      );

      const entrants = await Entrant.find({ tournamentId: id });
      await Notification.create(
        entrants.map(e => ({
          playerId: e.playerId,
          type: "TOURNAMENT_ENDED",
          message: `${updated.name} was cancelled: ${reason.trim()}`,
          link: `/tournaments/${id}`,
        }))
      );

      return updated;
    },

    updateTournamentVisibility: async (
      _: unknown,
      { id, visibility }: { id: string; visibility: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const tournament = await Tournament.findById(id);
      if (!tournament) throw new Error("Tournament not found");
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");
      // A restricted tournament (TO permission overhaul) was forced PRIVATE
      // at creation and stays that way permanently — not even an organizer
      // or admin can flip it, since the restriction is a property of the
      // tournament itself, not of whoever currently manages it.
      if (visibility === "PUBLIC" && tournament.isRestricted) {
        throw new Error("This tournament was created without TO status and can never be made public.");
      }

      return Tournament.findByIdAndUpdate(id, { visibility }, { new: true });
    },

    inviteToTournament: async (
      _: unknown,
      { tournamentId, playerId: inviteeId }: { tournamentId: string; playerId: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const tournament = await Tournament.findById(tournamentId);
      if (!tournament) throw new Error("Tournament not found");
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");

      const invitee = await Player.findById(inviteeId);
      if (!invitee) throw new Error("Player not found");

      const alreadyEntrant = await Entrant.findOne({ tournamentId, playerId: inviteeId });
      if (alreadyEntrant) throw new Error("Player is already an entrant in this tournament.");

      const alreadyInvited = tournament.invitedPlayerIds.some((id: any) => id.toString() === inviteeId);
      if (!alreadyInvited) {
        tournament.invitedPlayerIds.push(inviteeId);
        await tournament.save();

        await Notification.create({
          playerId: inviteeId,
          type: "PLAYER_JOINED",
          message: `You've been invited to join ${tournament.name}`,
          link: `/tournaments/${tournamentId}`,
        });
      }

      return tournament;
    },

    cancelTournamentInvite: async (
      _: unknown,
      { tournamentId, playerId: inviteeId }: { tournamentId: string; playerId: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const tournament = await Tournament.findById(tournamentId);
      if (!tournament) throw new Error("Tournament not found");
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");

      tournament.invitedPlayerIds = tournament.invitedPlayerIds.filter(
        (id: any) => id.toString() !== inviteeId
      );
      await tournament.save();

      return tournament;
    },

    declineTournamentInvite: async (
      _: unknown,
      { tournamentId, playerId: inviteeId }: { tournamentId: string; playerId: string },
      { playerId: callerPlayerId, role }: { playerId?: string; role?: string }
    ) => {
      if (callerPlayerId !== inviteeId && !isAdminOrAbove(role)) throw new Error("Not authorized");

      await connectToDatabase();
      const tournament = await Tournament.findById(tournamentId);
      if (!tournament) throw new Error("Tournament not found");

      tournament.invitedPlayerIds = tournament.invitedPlayerIds.filter(
        (id: any) => id.toString() !== inviteeId
      );
      await tournament.save();

      return tournament;
    },

    addTournamentOrganizer: async (
      _: unknown,
      { tournamentId, playerId: newOrganizerId }: { tournamentId: string; playerId: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const tournament = await Tournament.findById(tournamentId);
      if (!tournament) throw new Error("Tournament not found");
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");

      const newPlayer = await Player.findById(newOrganizerId);
      if (!newPlayer) throw new Error("Player not found");

      const alreadyOrganizer = tournament.organizers.some((id: any) => id.toString() === newOrganizerId);
      if (!alreadyOrganizer) {
        tournament.organizers.push(newOrganizerId);
        await tournament.save();

        await Notification.create({
          playerId: newOrganizerId,
          type: "PLAYER_JOINED",
          message: `You've been made a Tournament Organizer for ${tournament.name}`,
          link: `/tournaments/${tournamentId}`,
        });
      }

      return tournament;
    },

    removeTournamentOrganizer: async (
      _: unknown,
      { tournamentId, playerId: targetOrganizerId }: { tournamentId: string; playerId: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const tournament = await Tournament.findById(tournamentId);
      if (!tournament) throw new Error("Tournament not found");
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");

      if (tournament.organizers.length <= 1) {
        throw new Error("Cannot remove the last organizer from a tournament");
      }

      tournament.organizers = tournament.organizers.filter(
        (id: any) => id.toString() !== targetOrganizerId
      );
      await tournament.save();

      return tournament;
    },

    updateTournamentStreamAssets: async (
      _: unknown,
      { id, streamBackgroundUrl, sponsorBannerUrl }: { id: string; streamBackgroundUrl?: string; sponsorBannerUrl?: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const tournament = await Tournament.findById(id);
      if (!tournament) throw new Error("Tournament not found");
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");
      // A restricted tournament (TO permission overhaul) can never get a
      // stream background/sponsor banner — StreamAssetsButton's UI already
      // skips calling this mutation at all for one (it only ever sends its
      // OTHER mutation, for bracket colors, in that case), so this is a
      // defense-in-depth backstop against a direct API call, not something
      // the normal UI flow should ever actually hit.
      if (tournament.isRestricted && (streamBackgroundUrl || sponsorBannerUrl)) {
        throw new Error("This tournament was created without TO status and can't set a stream background or sponsor banner.");
      }

      const update: any = {};
      if (streamBackgroundUrl !== undefined) update.streamBackgroundUrl = streamBackgroundUrl;
      if (sponsorBannerUrl !== undefined) update.sponsorBannerUrl = sponsorBannerUrl;

      return Tournament.findByIdAndUpdate(id, update, { new: true });
    },

    updateTournamentBracketLineColor: async (
      _: unknown,
      { id, bracketLineColor, bracketBoxColor, bracketFontColor }: { id: string; bracketLineColor: string; bracketBoxColor?: string; bracketFontColor?: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const tournament = await Tournament.findById(id);
      if (!tournament) throw new Error("Tournament not found");
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");

      const update: any = { bracketLineColor };
      if (bracketBoxColor !== undefined) update.bracketBoxColor = bracketBoxColor;
      if (bracketFontColor !== undefined) update.bracketFontColor = bracketFontColor;

      return Tournament.findByIdAndUpdate(id, update, { new: true });
    },

    // Entrants
    joinTournament: async (
      _: unknown,
      { tournamentId, playerId }: { tournamentId: string; playerId: string },
      { playerId: callerPlayerId, role }: { playerId?: string; role?: string }
    ) => {
      if (callerPlayerId !== playerId && !isAdminOrAbove(role)) throw new Error("Not authorized");

      await connectToDatabase();
      const tournament = await Tournament.findById(tournamentId);
      if (tournament && (tournament.status === "LIVE" || tournament.status === "ENDED")) {
        throw new Error("Cannot join a tournament that is already live or has ended");
      }
      if (tournament && tournament.visibility === "PRIVATE") {
        const isInvited = tournament.invitedPlayerIds.some((id: any) => id.toString() === playerId);
        if (!isInvited) throw new Error("This tournament is private — you need an invite from an organizer to join.");
      }

      const existingEntrant = await Entrant.findOne({ tournamentId, playerId });
      if (existingEntrant) {
        return existingEntrant;
      }
      const entrant = await Entrant.create({ tournamentId, playerId });
      if (tournament && tournament.visibility === "PRIVATE") {
        // Invite consumed — remove from the pending list now that they've joined
        tournament.invitedPlayerIds = tournament.invitedPlayerIds.filter(
          (id: any) => id.toString() !== playerId
        );
        await tournament.save();
      }
      // Keep entrantCount in sync
      await Tournament.findByIdAndUpdate(tournamentId, { $inc: { entrantCount: 1 } });

      // Notify existing entrants that someone new joined
      const joiningPlayer = await Player.findById(playerId);
      const others = await Entrant.find({ tournamentId, playerId: { $ne: playerId } });
      if (others.length > 0 && tournament && joiningPlayer) {
        await Notification.create(
          others.map(e => ({
            playerId: e.playerId,
            type: "PLAYER_JOINED",
            message: `${joiningPlayer.tag} joined ${tournament.name}`,
            link: `/tournaments/${tournamentId}`,
          }))
        );
      }

      return entrant;
    },

    setPlacement: async (
      _: unknown,
      { entrantId, placement }: { entrantId: string; placement: number },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      if (!Number.isInteger(placement) || placement < 1) {
        throw new Error("Placement must be a positive whole number");
      }

      await connectToDatabase();
      const entrant = await Entrant.findById(entrantId);
      if (!entrant) throw new Error("Entrant not found");

      const tournament = await Tournament.findById(entrant.tournamentId);
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");

      // Marks this as a manual override -- the automatic bracket-placement
      // logic (lib/bracket.ts) skips any entrant with this flag set, even if
      // it re-runs later.
      return Entrant.findByIdAndUpdate(entrantId, { placement, placementSetManually: true }, { new: true });
    },

    // Brackets
    generateBracket: async (
      _: unknown,
      { tournamentId, seedingMethod, manualSeedOrder }: { tournamentId: string; seedingMethod: SeedingMethod; manualSeedOrder?: string[] },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const tournament = await Tournament.findById(tournamentId);
      if (!tournament) throw new Error("Tournament not found");
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");
      if (tournament.status === "ENDED" || tournament.status === "CANCELLED") {
        throw new Error("Cannot generate a bracket for a tournament that has ended or was cancelled");
      }

      const existing = await Bracket.findOne({ tournamentId });
      if (existing) throw new Error("This tournament already has a bracket — delete it first to regenerate");

      const entrants = await Entrant.find({ tournamentId });
      if (entrants.length < 2) throw new Error("Need at least 2 entrants to generate a bracket");

      const orderedPlayerIds = await resolveSeedOrder(seedingMethod, entrants, manualSeedOrder);

      // Reflect the computed seed number back onto each Entrant — reuses the
      // existing `seed` field already displayed in the entrant sidebar.
      await Promise.all(
        orderedPlayerIds.map((pid, i) => Entrant.updateOne({ tournamentId, playerId: pid }, { seed: i + 1 }))
      );

      const bracketId = new Types.ObjectId();
      const { matches } = buildDoubleEliminationBracket({ tournamentId, bracketId, orderedPlayerIds });

      const bracket = await Bracket.create({
        _id: bracketId,
        tournamentId,
        seedingMethod,
        seedOrder: orderedPlayerIds,
        size: nextPowerOfTwo(orderedPlayerIds.length),
      });

      if (matches.length > 0) await Match.insertMany(matches);

      return bracket;
    },

    deleteBracket: async (
      _: unknown,
      { tournamentId }: { tournamentId: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const tournament = await Tournament.findById(tournamentId);
      if (!tournament) throw new Error("Tournament not found");
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");

      const bracket = await Bracket.findOne({ tournamentId });
      if (!bracket) return false;

      await Match.deleteMany({ bracketId: bracket._id });
      await Bracket.findByIdAndDelete(bracket._id);
      return true;
    },

    reportResult: async (
      _: unknown,
      { matchId, player1Score, player2Score, isForfeit, forfeitingPlayerId }: { matchId: string; player1Score?: number | null; player2Score?: number | null; isForfeit?: boolean | null; forfeitingPlayerId?: string | null },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const match = await Match.findById(matchId);
      if (!match) throw new Error("Match not found");

      const tournament = await Tournament.findById(match.tournamentId);
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");

      if (!match.player1Id || !match.player2Id) {
        throw new Error("This match isn't ready to be reported yet — waiting on both players to be determined.");
      }

      const { winnerId, loserId, updateFields } = resolveMatchOutcome(match, { player1Score, player2Score, isForfeit, forfeitingPlayerId });

      // Update match result
      const updated = await Match.findByIdAndUpdate(matchId, updateFields, { new: true });

      // Update win/loss records on both players
      await Player.findByIdAndUpdate(winnerId, { $inc: { wins: 1 } });
      await Player.findByIdAndUpdate(loserId, { $inc: { losses: 1 } });

      // Notify both players their match result was reported
      await Notification.create([
        { playerId: winnerId, type: "MATCH_REPORTED", message: `You won your ${match.round} match!`, link: `/tournaments/${match.tournamentId}` },
        { playerId: loserId, type: "MATCH_REPORTED", message: `Your ${match.round} match result was reported.`, link: `/tournaments/${match.tournamentId}` },
      ]);

      // Bracket matches auto-advance the winner/loser into their next slots
      // (and handle the grand-final bracket-reset case) — see lib/bracket.ts.
      if (updated.bracketId) {
        await advanceBracketMatch(updated, winnerId, loserId);
      }

      return updated;
    },

    editMatchResult: async (
      _: unknown,
      { matchId, player1Score, player2Score, isForfeit, forfeitingPlayerId }: { matchId: string; player1Score?: number | null; player2Score?: number | null; isForfeit?: boolean | null; forfeitingPlayerId?: string | null },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const match = await Match.findById(matchId);
      if (!match) throw new Error("Match not found");

      const tournament = await Tournament.findById(match.tournamentId);
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");

      if (match.bracketId) {
        // Allowed only if nothing downstream has been played yet — full
        // cascade-reversal is out of scope. Throws with a specific reason if not.
        await assertBracketMatchEditable(match);
      }

      if (match.status !== MatchStatus.COMPLETED) {
        throw new Error("This match hasn't been reported yet — use reportResult instead");
      }

      // Reverse the previously-applied win/loss effects before applying the
      // corrected result, so stats don't get double-counted (same pattern
      // deleteMatch uses).
      let previousLoserId: any;
      if (match.winnerId) {
        previousLoserId =
          match.winnerId.toString() === match.player1Id.toString() ? match.player2Id : match.player1Id;
        await Player.findByIdAndUpdate(match.winnerId, { $inc: { wins: -1 } });
        await Player.findByIdAndUpdate(previousLoserId, { $inc: { losses: -1 } });

        // Bracket matches: undo this match's OLD contribution to its
        // downstream match(es) — clear only the slot our old winner/loser
        // actually filled, leaving whatever's in the other slot (fed by a
        // different match) untouched. advanceBracketMatch below re-fills
        // these with the new result.
        if (match.bracketId) {
          if (match.nextMatchId) {
            const field = match.nextMatchSlot === 1 ? "player1Id" : "player2Id";
            await Match.findOneAndUpdate({ _id: match.nextMatchId, [field]: match.winnerId }, { [field]: null });
          }
          if (match.nextLoserMatchId) {
            const field = match.nextLoserMatchSlot === 1 ? "player1Id" : "player2Id";
            await Match.findOneAndUpdate({ _id: match.nextLoserMatchId, [field]: previousLoserId }, { [field]: null });
          }
        }
      }

      const { winnerId, loserId, updateFields } = resolveMatchOutcome(match, { player1Score, player2Score, isForfeit, forfeitingPlayerId });

      const updated = await Match.findByIdAndUpdate(matchId, updateFields, { new: true });

      await Player.findByIdAndUpdate(winnerId, { $inc: { wins: 1 } });
      await Player.findByIdAndUpdate(loserId, { $inc: { losses: 1 } });

      // Re-run the same bracket-advancement the match would have gotten from
      // a fresh reportResult, so the new winner/loser correctly land in the
      // (now-cleared) downstream slot(s). isCorrection: true so a corrected
      // Grand Final result is treated as final (not misread as "game 1 of a
      // new set") -- see advanceBracketMatch's comment.
      if (updated.bracketId) {
        await advanceBracketMatch(updated, winnerId, loserId, { isCorrection: true });
      }

      // Intentionally no notification here — this is a correction, not a new
      // reportable event, and would be noisy/confusing for players.

      return updated;
    },

    deleteMatch: async (_: unknown, { id }: { id: string }, { playerId, role }: { playerId?: string; role?: string }) => {
      await connectToDatabase();
      const match = await Match.findById(id);
      if (!match) return false;

      const tournament = await Tournament.findById(match.tournamentId);
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");

      if (match.bracketId) {
        throw new Error("Bracket matches can't be deleted individually — delete the whole bracket instead.");
      }

      // Undo the win/loss effects reportResult applied, so deleting a
      // completed match doesn't leave stale stats behind.
      if (match.status === MatchStatus.COMPLETED && match.winnerId) {
        const loserId = match.winnerId.toString() === match.player1Id.toString() ? match.player2Id : match.player1Id;
        await Player.findByIdAndUpdate(match.winnerId, { $inc: { wins: -1 } });
        await Player.findByIdAndUpdate(loserId, { $inc: { losses: -1 } });
      }

      await Match.findByIdAndDelete(id);
      return true;
    },

    deleteTournament: async (
      _: unknown,
      { id }: { id: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const tournament = await Tournament.findById(id);
      if (!tournament) return false;
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");

      // Undo the win/loss effects reportResult applied for any completed
      // matches, so deleting the tournament doesn't leave stale stats.
      const completedMatches = await Match.find({ tournamentId: id, status: MatchStatus.COMPLETED, winnerId: { $ne: null } });
      for (const match of completedMatches) {
        const loserId = match.winnerId.toString() === match.player1Id.toString() ? match.player2Id : match.player1Id;
        await Player.findByIdAndUpdate(match.winnerId, { $inc: { wins: -1 } });
        await Player.findByIdAndUpdate(loserId, { $inc: { losses: -1 } });
      }

      // Clean up related matches, bracket, and entrants first
      await Match.deleteMany({ tournamentId: id });
      await Bracket.deleteMany({ tournamentId: id });
      await Entrant.deleteMany({ tournamentId: id });
      const result = await Tournament.findByIdAndDelete(id);
      return !!result;
    },

    leaveTournament: async (
      _: unknown,
      { entrantId }: { entrantId: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const entrant = await Entrant.findById(entrantId);
      if (!entrant) return false;

      const tournament = await Tournament.findById(entrant.tournamentId);
      const isSelf = entrant.playerId.toString() === playerId;
      // isOrganizer already treats ADMIN as an organizer for any tournament, so this
      // one check covers both TOs and global admins — same as every other resolver here.
      const isManager = isOrganizer(tournament, playerId, role);
      if (!isSelf && !isManager) throw new Error("Not authorized");

      if (tournament) {
        if (isSelf) {
          // Self-leave stays locked once the tournament is LIVE or ENDED, unchanged.
          if (tournament.status === "LIVE" || tournament.status === "ENDED") {
            throw new Error("Cannot leave a tournament that is already live or has ended");
          }
        } else {
          // Organizer/admin removal: allowed while LIVE (e.g. removing a no-show),
          // still blocked once ENDED.
          if (tournament.status === "ENDED") {
            throw new Error("Cannot remove a player from a tournament that has already ended");
          }
        }
      }

      await Entrant.findByIdAndDelete(entrantId);
      await Tournament.findByIdAndUpdate(entrant.tournamentId, { $inc: { entrantCount: -1 } });
      return true;
    },

    // Notifications
    markNotificationRead: async (_: unknown, { id }: { id: string }, { playerId }: { playerId?: string }) => {
      if (!playerId) throw new Error("Not authorized");
      await connectToDatabase();
      const result = await Notification.findOneAndUpdate({ _id: id, playerId }, { read: true });
      return !!result;
    },

    markAllNotificationsRead: async (_: unknown, __: unknown, { playerId }: { playerId?: string }) => {
      if (!playerId) throw new Error("Not authorized");
      await connectToDatabase();
      await Notification.updateMany({ playerId, read: false }, { read: true });
      return true;
    },

    // News — ADMIN-only, same role-gating pattern deleteTournament used
    // before the per-tournament TO role existed.
    // eventId set -> that Event's creator/managers can post; unset -> the
    // original global-homepage-post behavior, ADMIN-only, unchanged.
    createNewsPost: async (
      _: unknown,
      { title, content, eventId }: { title: string; content: string; eventId?: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      if (!playerId) throw new Error("Not authorized");
      await connectToDatabase();

      if (eventId) {
        const event = await Event.findById(eventId);
        if (!event) throw new Error("Event not found");
        if (!isEventManager(event, playerId, role)) throw new Error("Not authorized");
      } else if (!isAdminOrAbove(role)) {
        throw new Error("Not authorized");
      }

      return NewsPost.create({ title, content, authorId: playerId, eventId: eventId || undefined });
    },

    // Same branching: an Event post is gated on that Event's own
    // creator/managers (looked up from the post itself, since the mutation
    // doesn't take eventId again — it can't change which Event a post
    // belongs to), a global post stays ADMIN-only.
    updateNewsPost: async (
      _: unknown,
      { id, title, content }: { id: string; title?: string; content?: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const post = await NewsPost.findById(id);
      if (!post) throw new Error("News post not found");

      if (post.eventId) {
        const event = await Event.findById(post.eventId);
        if (!event || !isEventManager(event, playerId, role)) throw new Error("Not authorized");
      } else if (!isAdminOrAbove(role)) {
        throw new Error("Not authorized");
      }

      const update: any = {};
      if (title !== undefined) update.title = title;
      if (content !== undefined) update.content = content;
      return await NewsPost.findByIdAndUpdate(id, update, { new: true });
    },

    deleteNewsPost: async (
      _: unknown,
      { id }: { id: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const post = await NewsPost.findById(id);
      if (!post) return false;

      if (post.eventId) {
        const event = await Event.findById(post.eventId);
        if (!event || !isEventManager(event, playerId, role)) throw new Error("Not authorized");
      } else if (!isAdminOrAbove(role)) {
        throw new Error("Not authorized");
      }

      const result = await NewsPost.findByIdAndDelete(id);
      return !!result;
    },

    // Games — ADMIN-only curation. name is unique; a duplicate is caught
    // (E11000) and re-thrown as a friendly message, same pattern as
    // register's duplicateKeyField handling.
    createGame: async (
      _: unknown,
      { name, iconUrl }: { name: string; iconUrl?: string },
      { role }: { role?: string }
    ) => {
      if (!isAdminOrAbove(role)) throw new Error("Not authorized");
      if (!name.trim()) throw new Error("Game name is required.");
      await connectToDatabase();
      try {
        return await Game.create({ name: name.trim(), iconUrl });
      } catch (err: any) {
        if (err?.code === 11000) throw new Error("A game with that name already exists.");
        throw err;
      }
    },

    updateGame: async (
      _: unknown,
      { id, name, iconUrl }: { id: string; name?: string; iconUrl?: string },
      { role }: { role?: string }
    ) => {
      if (!isAdminOrAbove(role)) throw new Error("Not authorized");
      await connectToDatabase();

      const update: any = {};
      if (name !== undefined) {
        if (!name.trim()) throw new Error("Game name is required.");
        update.name = name.trim();
      }
      if (iconUrl !== undefined) update.iconUrl = iconUrl;

      try {
        const updated = await Game.findByIdAndUpdate(id, update, { new: true });
        if (!updated) throw new Error("Game not found");
        return updated;
      } catch (err: any) {
        if (err?.code === 11000) throw new Error("A game with that name already exists.");
        throw err;
      }
    },

    deleteGame: async (_: unknown, { id }: { id: string }, { role }: { role?: string }) => {
      if (!isAdminOrAbove(role)) throw new Error("Not authorized");
      await connectToDatabase();
      const result = await Game.findByIdAndDelete(id);
      return !!result;
    },

    // Events
    createEvent: async (
      _: unknown,
      { name, isOnlineOnly, address, logoUrl, twitchUrl }: { name: string; isOnlineOnly?: boolean; address?: string; logoUrl?: string; twitchUrl?: string },
      { playerId }: { playerId?: string }
    ) => {
      if (!playerId) throw new Error("Not authorized");
      await connectToDatabase();

      const eventNumber = await getNextSequence("eventNumber");
      // The creator is included in managerIds up front — see the Event
      // model comment, managerIds is the single source of truth for who
      // can manage this Event, no separate creator-only path.
      // status is PENDING regardless of who creates it (even an ADMIN) —
      // it must go through approveEvent to become public/linkable.
      return Event.create({
        name,
        isOnlineOnly,
        address,
        logoUrl,
        twitchUrl,
        eventNumber,
        status: EventStatus.PENDING,
        creatorId: playerId,
        managerIds: [playerId],
      });
    },

    updateEvent: async (
      _: unknown,
      {
        id,
        name,
        isOnlineOnly,
        address,
        logoUrl,
        twitchUrl,
      }: { id: string; name?: string; isOnlineOnly?: boolean; address?: string; logoUrl?: string; twitchUrl?: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const event = await Event.findById(id);
      if (!event) throw new Error("Event not found");
      if (!isEventManager(event, playerId, role)) throw new Error("Not authorized");

      const update: any = {};
      if (name !== undefined) update.name = name;
      if (isOnlineOnly !== undefined) update.isOnlineOnly = isOnlineOnly;
      if (address !== undefined) update.address = address;
      if (logoUrl !== undefined) update.logoUrl = logoUrl;
      if (twitchUrl !== undefined) update.twitchUrl = twitchUrl;

      // Resubmission: any edit to a REJECTED Event re-enters the review
      // queue automatically, rather than needing a separate "resubmit"
      // action — clear the old reason since it no longer applies.
      if (event.status === EventStatus.REJECTED) {
        update.status = EventStatus.PENDING;
        update.rejectionReason = "";
      }

      return Event.findByIdAndUpdate(id, update, { new: true });
    },

    // Allowed even with tournaments still linked to it — no block. Those
    // tournaments' address/logoUrl/twitchUrl field resolvers already fall
    // back to the tournament's own stored fields whenever Event.findById
    // comes back empty, which a deleted Event's id naturally does, so
    // nothing extra needs cleaning up here.
    deleteEvent: async (_: unknown, { id }: { id: string }, { playerId, role }: { playerId?: string; role?: string }) => {
      await connectToDatabase();
      const event = await Event.findById(id);
      if (!event) return false;
      if (!isEventManager(event, playerId, role)) throw new Error("Not authorized");

      await Event.findByIdAndDelete(id);
      return true;
    },

    addEventManager: async (
      _: unknown,
      { eventId, playerId: newManagerId }: { eventId: string; playerId: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const event = await Event.findById(eventId);
      if (!event) throw new Error("Event not found");
      if (!isEventManager(event, playerId, role)) throw new Error("Not authorized");

      const newManager = await Player.findById(newManagerId);
      if (!newManager) throw new Error("Player not found");

      const alreadyManager = event.managerIds.some((id: any) => id.toString() === newManagerId);
      if (!alreadyManager) {
        event.managerIds.push(newManagerId);
        await event.save();
      }

      return event;
    },

    removeEventManager: async (
      _: unknown,
      { eventId, playerId: targetManagerId }: { eventId: string; playerId: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const event = await Event.findById(eventId);
      if (!event) throw new Error("Event not found");
      if (!isEventManager(event, playerId, role)) throw new Error("Not authorized");

      if (event.managerIds.length <= 1) {
        throw new Error("Cannot remove the last manager from an Event");
      }

      event.managerIds = event.managerIds.filter((id: any) => id.toString() !== targetManagerId);
      await event.save();

      return event;
    },

    // Edit-and-approve in one call, not a separate two-step — any field
    // left undefined keeps its current value, same partial-update
    // convention as updateEvent.
    approveEvent: async (
      _: unknown,
      {
        id,
        name,
        isOnlineOnly,
        address,
        logoUrl,
        twitchUrl,
      }: { id: string; name?: string; isOnlineOnly?: boolean; address?: string; logoUrl?: string; twitchUrl?: string },
      { role }: { role?: string }
    ) => {
      if (!isAdminOrAbove(role)) throw new Error("Not authorized");
      await connectToDatabase();
      const event = await Event.findById(id);
      if (!event) throw new Error("Event not found");

      const update: any = { status: EventStatus.APPROVED, rejectionReason: "" };
      if (name !== undefined) update.name = name;
      if (isOnlineOnly !== undefined) update.isOnlineOnly = isOnlineOnly;
      if (address !== undefined) update.address = address;
      if (logoUrl !== undefined) update.logoUrl = logoUrl;
      if (twitchUrl !== undefined) update.twitchUrl = twitchUrl;

      return Event.findByIdAndUpdate(id, update, { new: true });
    },

    rejectEvent: async (_: unknown, { id, reason }: { id: string; reason: string }, { role }: { role?: string }) => {
      if (!isAdminOrAbove(role)) throw new Error("Not authorized");
      if (!reason.trim()) throw new Error("A rejection reason is required");
      await connectToDatabase();
      const event = await Event.findById(id);
      if (!event) throw new Error("Event not found");

      return Event.findByIdAndUpdate(id, { status: EventStatus.REJECTED, rejectionReason: reason.trim() }, { new: true });
    },
  },

  // ─── Field resolvers (populate references) ─────────────────────────────────

  User: {
    player: async (parent: { playerId: string }) => await Player.findById(parent.playerId),
    // Same missing-field-on-legacy-documents issue as Tournament.isRestricted
    // below — every account created before the TO permission overhaul has
    // `isTO` genuinely absent, not `false`, in its stored document.
    isTO: (parent: { isTO?: boolean }) => parent.isTO ?? false,
  },

  Player: {
    user: async (parent: { userId: string }) => await User.findById(parent.userId),
    // Computed at read time (best-10, 52-week-rolling ranking points) — see
    // lib/ranking.ts. Player.points is no longer a stored counter.
    points: async (parent: { _id: string }) => await computeRankingPoints(parent._id.toString()),
    tournaments: async (parent: { _id: string }) => await Entrant.find({ playerId: parent._id }),
    displayId: (parent: { playerNumber?: number }) =>
      parent.playerNumber != null ? formatPlayerNumber(parent.playerNumber) : null,
    winRate: (parent: { wins: number; losses: number }) => {
      const total = parent.wins + parent.losses;
      return total === 0 ? 0 : Math.round((parent.wins / total) * 100) / 100;
    },
    headToHead: async (parent: { _id: string }, { opponentId }: { opponentId: string }) => {
      await connectToDatabase();
      const opponent = await Player.findById(opponentId);
      if (!opponent) throw new Error("Opponent not found");

      // Forfeits are intentionally included — resolveMatchOutcome already
      // gives them a real winnerId/COMPLETED status, same as a played match.
      const matches = await Match.find({
        status: MatchStatus.COMPLETED,
        $or: [
          { player1Id: parent._id, player2Id: opponentId },
          { player1Id: opponentId, player2Id: parent._id },
        ],
      });

      let wins = 0;
      let losses = 0;
      for (const m of matches) {
        if (m.winnerId?.toString() === parent._id.toString()) wins++;
        else if (m.winnerId?.toString() === opponentId) losses++;
      }

      return { opponent, wins, losses };
    },
  },

  Tournament: {
    // Mongoose schema defaults only apply to newly-created documents, not
    // ones hydrated from data that predates this field — every tournament
    // created before the TO permission overhaul has `isRestricted` genuinely
    // absent (not `false`) in its stored document, which a non-null GraphQL
    // field can't return as-is. Coalescing here is what actually makes
    // "existing tournaments unaffected" (full capabilities) true in practice.
    isRestricted: (parent: { isRestricted?: boolean }) => parent.isRestricted ?? false,
    entrants: async (parent: { _id: string }) => await Entrant.find({ tournamentId: parent._id }),
    matches: async (parent: { _id: string }) => await Match.find({ tournamentId: parent._id }),
    isEntered: async (parent: { _id: string }, { playerId }: { playerId?: string }) => {
      if (!playerId) return false;
      const entrant = await Entrant.findOne({ tournamentId: parent._id, playerId });
      return !!entrant;
    },
    organizers: async (parent: { organizers?: string[] }) =>
      parent.organizers ? await Player.find({ _id: { $in: parent.organizers } }) : [],
    isOrganizer: (parent: { organizers?: string[] }, { playerId }: { playerId?: string }) => {
      if (!playerId || !parent.organizers) return false;
      return parent.organizers.some((id: any) => id.toString() === playerId);
    },
    invitedPlayers: async (parent: { invitedPlayerIds?: string[] }) =>
      parent.invitedPlayerIds ? await Player.find({ _id: { $in: parent.invitedPlayerIds } }) : [],
    isInvited: (parent: { invitedPlayerIds?: string[] }, { playerId }: { playerId?: string }) => {
      if (!playerId || !parent.invitedPlayerIds) return false;
      return parent.invitedPlayerIds.some((id: any) => id.toString() === playerId);
    },
    bracket: async (parent: { _id: string }) => await Bracket.findOne({ tournamentId: parent._id }),
    event: async (parent: { eventId?: string }) => (parent.eventId ? await Event.findById(parent.eventId) : null),
    // Live-link overrides: when eventId is set, these three resolve from
    // the LINKED EVENT's current data instead of this tournament's own
    // stored field — re-fetched on every read, never copied at link time.
    // If the Event was since deleted (deleteEvent allows this with
    // tournaments still linked, no block), Event.findById comes back null
    // and this falls through to the tournament's own field automatically,
    // same as a tournament that was never linked at all.
    address: async (parent: { eventId?: string; address?: string }) => {
      if (parent.eventId) {
        const event = await Event.findById(parent.eventId);
        if (event) return event.address;
      }
      return parent.address;
    },
    logoUrl: async (parent: { eventId?: string; logoUrl?: string }) => {
      if (parent.eventId) {
        const event = await Event.findById(parent.eventId);
        if (event) return event.logoUrl;
      }
      return parent.logoUrl;
    },
    twitchUrl: async (parent: { eventId?: string; twitchUrl?: string }) => {
      if (parent.eventId) {
        const event = await Event.findById(parent.eventId);
        if (event) return event.twitchUrl;
      }
      return parent.twitchUrl;
    },
  },

  Event: {
    displayId: (parent: { eventNumber?: number }) =>
      parent.eventNumber != null ? formatEventNumber(parent.eventNumber) : null,
    creator: async (parent: { creatorId?: string }) => (parent.creatorId ? await Player.findById(parent.creatorId) : null),
    managers: async (parent: { managerIds?: string[] }) =>
      parent.managerIds ? await Player.find({ _id: { $in: parent.managerIds } }) : [],
    tournaments: async (parent: { _id: string }) => await Tournament.find({ eventId: parent._id }),
    newsPosts: async (parent: { _id: string }) => await NewsPost.find({ eventId: parent._id }).sort({ createdAt: -1 }),
    // Lean count/distinct queries — avoid populating full Tournament docs
    // just to display a number on the browse-page card.
    tournamentCount: async (parent: { _id: string }) => await Tournament.countDocuments({ eventId: parent._id }),
    gameCount: async (parent: { _id: string }) => (await Tournament.distinct("game", { eventId: parent._id })).length,
  },

  Entrant: {
    player: async (parent: { playerId: string }) => await Player.findById(parent.playerId),
    tournament: async (parent: { tournamentId: string }) => await Tournament.findById(parent.tournamentId),
  },

  Game: {
    // Works identically for a real Game doc or a synthetic orphan entry
    // (see the `games` resolver) — both are just objects with a `name`.
    tournamentCount: async (parent: { name: string }) => {
      await connectToDatabase();
      return await Tournament.countDocuments({ game: parent.name });
    },
  },

  TORequest: {
    player: async (parent: { playerId: string }) => await Player.findById(parent.playerId),
  },

  Match: {
    player1: async (parent: { player1Id?: string }) => (parent.player1Id ? await Player.findById(parent.player1Id) : null),
    player2: async (parent: { player2Id?: string }) => (parent.player2Id ? await Player.findById(parent.player2Id) : null),
    winner: async (parent: { winnerId?: string }) =>
      parent.winnerId ? await Player.findById(parent.winnerId) : null,
    tournament: async (parent: { tournamentId: string }) => await Tournament.findById(parent.tournamentId),
    bracket: async (parent: { bracketId?: string }) => (parent.bracketId ? await Bracket.findById(parent.bracketId) : null),
    nextMatch: async (parent: { nextMatchId?: string }) => (parent.nextMatchId ? await Match.findById(parent.nextMatchId) : null),
    nextLoserMatch: async (parent: { nextLoserMatchId?: string }) =>
      parent.nextLoserMatchId ? await Match.findById(parent.nextLoserMatchId) : null,
  },

  NewsPost: {
    author: async (parent: { authorId?: string }) => (parent.authorId ? await Player.findById(parent.authorId) : null),
  },

  Bracket: {
    tournament: async (parent: { tournamentId: string }) => await Tournament.findById(parent.tournamentId),
    seedOrder: async (parent: { seedOrder?: string[] }) => {
      if (!parent.seedOrder) return [];
      // Mongo's $in doesn't preserve array order, so re-sort the fetched
      // players back into seed order (index 0 = seed 1) ourselves.
      const players = await Player.find({ _id: { $in: parent.seedOrder } });
      const byId = new Map(players.map((p: any) => [p._id.toString(), p]));
      return parent.seedOrder.map((id: any) => byId.get(id.toString())).filter(Boolean);
    },
    matches: async (parent: { _id: string }) =>
      await Match.find({ bracketId: parent._id }).sort({ bracketRound: 1, bracketPosition: 1 }),
  },
};
