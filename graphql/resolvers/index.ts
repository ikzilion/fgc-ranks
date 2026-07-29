import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { GraphQLError } from "graphql";
import { randomBytes, createHash } from "crypto";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db";
import { User, UserRole } from "@/models/User";
import { isAdminOrAbove, isSuperAdmin } from "@/lib/roles";
import { Player } from "@/models/Player";
import { softDeletePlayer, logAccountDeletionEvent, DELETION_GRACE_PERIOD_MS } from "@/lib/accountDeletion";
import { AccountDeletionAuditAction } from "@/models/AccountDeletionAuditLog";
import { Tournament, TournamentStatus } from "@/models/Tournament";
import { Entrant } from "@/models/Entrant";
import { Match, MatchStatus } from "@/models/Match";
import { Bracket } from "@/models/Bracket";
import { Pool } from "@/models/Pool";
import { Notification } from "@/models/Notification";
import { NewsPost } from "@/models/NewsPost";
import { Event, EventStatus } from "@/models/Event";
import { Game } from "@/models/Game";
import { HiddenGameName } from "@/models/HiddenGameName";
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
import { sendPasswordResetEmail, sendVerificationEmail, sendAccountDeletionEmail, sendAccountDeletionScheduledEmail } from "@/lib/email";
import { verifyTurnstileToken } from "@/lib/turnstile";
import { buildDoubleEliminationBracket, resolveSeedOrder, validateManualSlotAssignment, advanceBracketMatch, nextPowerOfTwo, computeMainBracketSeedOrder, shuffle, SeedingMethod, undoMatchEffects, MODEL_B_MIN_ENTRANTS, computeModelBInitialPoolCount, computeNextRepooledRound, buildFinalsCutoffBracket, extractPoolSurvivors, PoolSurvivors } from "@/lib/bracket";
import { buildRoundRobinMatches, computeRoundRobinStandings } from "@/lib/roundRobin";
import { getNextSequence } from "@/lib/counter";
import { computeRankingPoints, computeRankingPointsForPlayers, computeGameRankingsForPlayer, computeGameLeaderboard } from "@/lib/ranking";
import { formatPlayerNumber } from "@/lib/playerId";
import { extractTwitchUsername } from "@/lib/twitch";
import { getBlobStorageUsageBytes } from "@/lib/blobStorage";
import { Loaders } from "@/graphql/loaders";
import { StreamAssetType } from "@/models/StreamAsset";
import { listStreamAssets } from "@/lib/streamAssets";
import { formatEventNumber } from "@/lib/eventId";
import { NextRequest } from "next/server";

// Tags rate-limit rejections with a structured extensions.code instead of a
// plain Error -- lets client-side error handling reliably distinguish "you're
// being throttled" from a genuine backend error by checking the code rather
// than fragile-to-rewording message-text matching (see the "generic error
// masks real causes" bug this fixes).
function rateLimitedError(message: string) {
  return new GraphQLError(message, { extensions: { code: "RATE_LIMITED" } });
}

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

// softDeletePlayer moved to lib/accountDeletion.ts (settled July 28, 2026)
// -- lib/auth.ts's authorize() needs to call it too (the lazy elapsed-scrub
// check at login time), and a resolver-local function isn't importable from
// there.

// A player can manage a tournament if they're a global ADMIN, or if their
// playerId is in that specific tournament's organizers list (Tournament
// Organizer / TO access — scoped per-tournament, not a global role).
function isOrganizer(tournament: any, playerId?: string, role?: string): boolean {
  if (isAdminOrAbove(role)) return true;
  if (!playerId || !tournament?.organizers) return false;
  return tournament.organizers.some((orgId: any) => orgId.toString() === playerId);
}

// Pool play + top-cut: auto-suggested pool count targeting ~6-8 entrants per
// pool (7 as the midpoint) — a pure function of entrant count, purely a UI
// convenience the TO can always override with a direct number.
function suggestPoolCount(entrantCount: number): number {
  return Math.max(1, Math.round(entrantCount / 7));
}

// A bracket is "decided" the same way computeAndApplyBracketPlacements
// (lib/bracket.ts) treats it: if a Grand Final Reset match exists at all, it
// (not the original Grand Final) is the true decider — advanceBracketMatch
// only ever creates one synchronously alongside marking the original Grand
// Final COMPLETED, so a reader never observes "reset needed but not yet
// created" as separate states. No reset match at all means the Grand Final
// itself was a straight, non-reset win.
async function isBracketDecided(bracketId: any): Promise<boolean> {
  const resetMatch = await Match.findOne({ bracketId, bracketSide: "GRAND_FINAL_RESET" });
  if (resetMatch) return resetMatch.status === "COMPLETED";
  const grandFinal = await Match.findOne({ bracketId, bracketSide: "GRAND_FINAL" });
  return grandFinal?.status === "COMPLETED";
}

// A pool is "complete" differently depending on which pool model generated
// it: a Model B/C pool has its own Bracket document, "complete" once its
// Grand Final (or Reset) has been decided (see isBracketDecided) -- EXCEPT a
// Model B Finals-cutoff round (Pool.isFinalsCutoff), whose bracket has no
// Grand Final at all by design (buildFinalsCutoffBracket) and so is complete
// once every one of its matches has been reported instead. A Model A
// (round-robin) pool has no Bracket at all — its matches are found by
// poolId instead — so "complete" there just means every one of its matches
// has actually been reported. Branching on whether a Bracket exists (rather
// than looking at Tournament.poolModel) keeps this self-contained: it needs
// nothing but the Pool doc itself to know which check applies.
async function isPoolComplete(pool: { _id: any; isFinalsCutoff?: boolean }): Promise<boolean> {
  const bracket = await Bracket.findOne({ poolId: pool._id });
  if (bracket) {
    if (pool.isFinalsCutoff) {
      const total = await Match.countDocuments({ bracketId: bracket._id });
      if (total === 0) return false;
      const incomplete = await Match.countDocuments({ bracketId: bracket._id, status: { $ne: "COMPLETED" } });
      return incomplete === 0;
    }
    return await isBracketDecided(bracket._id);
  }

  const total = await Match.countDocuments({ poolId: pool._id });
  if (total === 0) return false; // pool generation failed/hasn't populated matches yet
  const incomplete = await Match.countDocuments({ poolId: pool._id, status: { $ne: "COMPLETED" } });
  return incomplete === 0;
}

// Pool play + top-cut: true only once every Pool for this tournament (or, if
// roundNumber is given, every Pool of that specific round -- Pool format
// Model B only, which is the only model where a tournament can have more
// than one round's worth of pools at once) is complete (see isPoolComplete
// above, for whichever model generated it). False (not an error) when there
// are no matching pools yet, so it's safe to use directly as a boolean
// field/gate.
async function arePoolsComplete(tournamentId: string, roundNumber?: number): Promise<boolean> {
  const query: Record<string, unknown> = { tournamentId };
  if (roundNumber !== undefined) query.roundNumber = roundNumber;
  const pools = await Pool.find(query);
  if (pools.length === 0) return false;
  for (const pool of pools) {
    if (!(await isPoolComplete(pool))) return false;
  }
  return true;
}

// Pool format Model B only — persists one repooled round's worth of ONE
// pool (a normal Round 2+ pool, or a Finals-cutoff Semifinal round) exactly
// the way generateModelBPools persists Round 1: resolve each advancing
// player back to their existing Entrant document (never re-created --
// Entrant is a per-tournament join record, not per-round), then write the
// real Pool + Bracket + Match documents.
async function persistRepooledPool(params: {
  tournamentId: string;
  roundNumber: number;
  poolNumber: number;
  playerIds: string[];
  bracketId: Types.ObjectId;
  matches: any[];
  bracketSize: number;
  isFinalsCutoff?: boolean;
  finalsCutoffFinalistSpecs?: unknown[];
}) {
  const { tournamentId, roundNumber, poolNumber, playerIds, bracketId, matches, bracketSize, isFinalsCutoff, finalsCutoffFinalistSpecs } = params;

  const entrants = await Entrant.find({ tournamentId, playerId: { $in: playerIds } });
  const entrantByPlayerId = new Map(entrants.map((e: any) => [e.playerId.toString(), e]));
  const entrantIds = playerIds.map(id => {
    const entrant = entrantByPlayerId.get(id);
    if (!entrant) throw new Error(`Internal error: no Entrant found for advancing player ${id}`);
    return entrant._id;
  });

  const pool = await Pool.create({
    tournamentId,
    poolNumber,
    roundNumber,
    entrantIds,
    ...(isFinalsCutoff ? { isFinalsCutoff: true, finalsCutoffFinalistSpecs } : {}),
  });

  await Bracket.create({
    _id: bracketId,
    tournamentId,
    poolId: pool._id,
    seedingMethod: "RANDOM",
    seedOrder: playerIds,
    size: bracketSize,
  });

  if (matches.length > 0) await Match.insertMany(matches);
  return pool;
}

// Model A (round-robin) only — the top 2 finishers of a completed pool by
// the standings tiebreak order (see lib/roundRobin.ts), as player IDs.
async function roundRobinAdvancers(pool: { _id: any; entrantIds?: any[] }): Promise<{ first: string; second: string }> {
  const entrants = await Entrant.find({ _id: { $in: pool.entrantIds ?? [] } });
  const playerIds = entrants.map((e: any) => e.playerId.toString());
  const standings = await computeRoundRobinStandings(pool._id, playerIds);
  if (standings.length < 2) throw new Error(`Pool needs at least 2 entrants to determine advancers`);
  return { first: standings[0].playerId, second: standings[1].playerId };
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

// Shared partial-update helper for the 7 social-link fields (settled July
// 28, 2026) — same fixed platform set + one generic slot on both Player and
// Event, applied identically across updatePlayer/updateEvent/approveEvent
// (createEvent just spreads them directly into Event.create instead, since
// undefined there already falls through to the schema's own defaults).
// Centralized so those 3 partial-update call sites can't drift apart on
// which fields this feature touches.
function applySocialLinkFields(
  update: any,
  fields: {
    twitterUrl?: string;
    instagramUrl?: string;
    youtubeUrl?: string;
    discordUrl?: string;
    tiktokUrl?: string;
    otherLinkUrl?: string;
    otherLinkLabel?: string;
  }
): void {
  if (fields.twitterUrl !== undefined) update.twitterUrl = fields.twitterUrl;
  if (fields.instagramUrl !== undefined) update.instagramUrl = fields.instagramUrl;
  if (fields.youtubeUrl !== undefined) update.youtubeUrl = fields.youtubeUrl;
  if (fields.discordUrl !== undefined) update.discordUrl = fields.discordUrl;
  if (fields.tiktokUrl !== undefined) update.tiktokUrl = fields.tiktokUrl;
  if (fields.otherLinkUrl !== undefined) update.otherLinkUrl = fields.otherLinkUrl;
  if (fields.otherLinkLabel !== undefined) update.otherLinkLabel = fields.otherLinkLabel;
}

// Basic (not exhaustive/RFC-compliant) email format check — used by
// requestTOStatus's required contactEmail field.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

    myStreamAssets: async (_: unknown, { type }: { type: string }, { playerId }: { playerId?: string }) => {
      if (!playerId) return [];
      await connectToDatabase();
      return listStreamAssets(playerId, type as StreamAssetType);
    },

    // The full ranked leaderboard for one game (/games/[game]) — every
    // player with an in-window result, not a top-N slice. Excludes
    // soft-deleted players the same way Query.players does, BEFORE
    // assigning rank, so rank stays contiguous (no gaps for a deleted
    // player's old slot) rather than preserving gaps from the raw
    // computation.
    gameLeaderboard: async (_: unknown, { game }: { game: string }) => {
      await connectToDatabase();
      const leaderboard = await computeGameLeaderboard(game);
      if (leaderboard.length === 0) return [];

      const players = await Player.find({ _id: { $in: leaderboard.map(e => e.playerId) }, isDeleted: { $ne: true } });
      const playerById = new Map(players.map((p: any) => [p._id.toString(), p]));

      return leaderboard
        .filter(e => playerById.has(e.playerId))
        .map((e, i) => ({ player: playerById.get(e.playerId), points: e.points, rank: i + 1 }));
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

    playerByDisplayId: async (_: unknown, { displayId }: { displayId: string }) => {
      await connectToDatabase();
      // "FGC-000001" -> 1, same parsing convention as eventByDisplayId.
      const match = displayId.trim().match(/^FGC-0*(\d+)$/i);
      if (!match) return null;
      const playerNumber = Number(match[1]);
      if (!playerNumber) return null;
      // Excludes soft-deleted players, same as the `players` list query —
      // a deleted account shouldn't be addable as an organizer.
      return await Player.findOne({ playerNumber, isDeleted: { $ne: true } });
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

    blobStorageUsageBytes: async (_: unknown, __: unknown, { role }: { role?: string }) => {
      if (!isAdminOrAbove(role)) throw new Error("Not authorized");
      await connectToDatabase();
      return await getBlobStorageUsageBytes();
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
    // Admin management gap for uncurated game entries (settled July 26,
    // 2026): an orphan name an admin has hidden (hideUncuratedGame) is
    // dropped here too — the single shared list every caller (public /games,
    // /admin/games, the tournament-creation game dropdown) draws from.
    games: async () => {
      await connectToDatabase();
      const curated = await Game.find();
      const curatedNames = new Set(curated.map((g: any) => g.name));
      const hiddenNames = new Set((await HiddenGameName.find().select("name").lean()).map((h: any) => h.name));
      const distinctTournamentGames: string[] = await Tournament.distinct("game");
      const orphans = distinctTournamentGames
        .filter(name => name && !curatedNames.has(name) && !hiddenNames.has(name))
        .map(name => ({ id: `orphan-${Buffer.from(name).toString("base64url")}`, name, iconUrl: "" }));
      return [...curated, ...orphans].sort((a: any, b: any) => a.name.localeCompare(b.name));
    },

    // ADMIN-only — the /admin/games "hidden entries" section's data source
    // (see hideUncuratedGame/unhideUncuratedGame).
    hiddenGameNames: async (_: unknown, __: unknown, { role }: { role?: string }) => {
      if (!isAdminOrAbove(role)) throw new Error("Not authorized");
      await connectToDatabase();
      const hidden = await HiddenGameName.find().select("name").sort({ name: 1 }).lean();
      return hidden.map((h: any) => h.name);
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

    // SUPER_ADMIN-only (settled July 28, 2026) — the admin restore tool's
    // data source. scrubBackupTag non-null is exactly "restorable right
    // now" (see models/Player.ts); purgeExpiredScrubBackups clears it once
    // the retention window elapses, which is what naturally drops a player
    // out of this list without a separate expiry check here.
    restorableDeletedPlayers: async (_: unknown, __: unknown, { role }: { role?: string }) => {
      if (!isSuperAdmin(role)) throw new Error("Not authorized");
      await connectToDatabase();
      return Player.find({ isDeleted: true, scrubBackupTag: { $ne: null } }).sort({ deletedAt: -1 });
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
      if (!success) throw rateLimitedError("Too many accounts created from this IP. Please try again later.");

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
      try {
        await sendVerificationEmail(email, verifyUrl);
      } catch (err) {
        // Both documents already exist at this point — roll both back, same
        // reasoning as the tag-collision rollback above, so a transient
        // Resend/network failure doesn't leave an orphaned, unverifiable
        // account behind that silently consumes the email/tag forever with
        // no way for the person to log in or cleanly re-register.
        await Player.findByIdAndDelete(player._id);
        await User.findByIdAndDelete(user._id);
        throw new Error("We couldn't send your verification email. Please try registering again.");
      }

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
      if (!success) throw rateLimitedError("Too many login attempts. Please try again later.");

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
      if (!success) throw rateLimitedError("Too many requests. Please try again later.");

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
      if (!success) throw rateLimitedError("Too many requests. Please try again later.");

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
      if (!success) throw rateLimitedError("Too many requests. Please try again later.");

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

      // Logged before the (fallible) email send -- a Resend hiccup should
      // still leave a REQUESTED entry in the trail, same reasoning as
      // confirmAccountDeletion below.
      await logAccountDeletionEvent(player._id, AccountDeletionAuditAction.REQUESTED, { ip });

      const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
      const confirmUrl = `${baseUrl}/delete-account/confirm?token=${rawToken}`;
      await sendAccountDeletionEmail(user.email, confirmUrl);

      return true;
    },

    // Self-service account deletion, step 2 — token-only, no login required
    // to use the link (same precedent as resetPassword: clicking an email
    // link from a different device/session is normal). Grace-period account
    // deletion (settled July 28, 2026): this no longer scrubs immediately —
    // it starts a 7-day pending-deletion window instead, and sends a
    // separate email with a cancel link + the exact scrub date. The actual
    // soft-delete (softDeletePlayer, same shared implementation the ADMIN
    // deletePlayer mutation uses) only runs once that window elapses,
    // enforced lazily (see lib/accountDeletion.ts — this app has no cron/
    // scheduled-job infrastructure).
    confirmAccountDeletion: async (_: unknown, { token }: { token: string }, { req }: any) => {
      await connectToDatabase();
      const deleteAccountTokenHash = createHash("sha256").update(token).digest("hex");
      const user = await User.findOne({
        deleteAccountTokenHash,
        deleteAccountTokenExpiry: { $gt: new Date() },
      });
      if (!user) throw new Error("Invalid or expired confirmation link");

      const player = user.playerId ? await Player.findById(user.playerId) : null;
      if (!player) throw new Error("Player not found");
      if (player.isDeleted) return true; // already fully scrubbed — idempotent

      const requestedAt = new Date();
      const scheduledScrubAt = new Date(requestedAt.getTime() + DELETION_GRACE_PERIOD_MS);
      const rawCancelToken = randomBytes(32).toString("hex");
      const cancelDeletionTokenHash = createHash("sha256").update(rawCancelToken).digest("hex");

      await User.findByIdAndUpdate(user._id, {
        pendingDeletionRequestedAt: requestedAt,
        scheduledScrubAt,
        deleteAccountTokenHash: null,
        deleteAccountTokenExpiry: null,
        cancelDeletionTokenHash,
        // Valid through the full grace window — softDeletePlayer clears
        // this hash outright once the scrub actually runs, so in practice
        // the token stops working the moment the account is scrubbed,
        // whichever comes first.
        cancelDeletionTokenExpiry: scheduledScrubAt,
      });

      const ip = getClientIp(req);
      await logAccountDeletionEvent(player._id, AccountDeletionAuditAction.CONFIRMED, { ip });

      const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
      const cancelUrl = `${baseUrl}/delete-account/cancel?token=${rawCancelToken}`;
      await sendAccountDeletionScheduledEmail(user.email, cancelUrl, scheduledScrubAt);

      return true;
    },

    // Cancels a pending deletion via the emailed cancel link — token-only,
    // no login required, same precedent as confirmAccountDeletion.
    cancelAccountDeletion: async (_: unknown, { token }: { token: string }, { req }: any) => {
      await connectToDatabase();
      const cancelDeletionTokenHash = createHash("sha256").update(token).digest("hex");
      const user = await User.findOne({
        cancelDeletionTokenHash,
        cancelDeletionTokenExpiry: { $gt: new Date() },
      });
      if (!user) throw new Error("Invalid or expired cancellation link");
      if (!user.scheduledScrubAt) return true; // already cancelled / not pending — idempotent

      await User.findByIdAndUpdate(user._id, {
        pendingDeletionRequestedAt: null,
        scheduledScrubAt: null,
        cancelDeletionTokenHash: null,
        cancelDeletionTokenExpiry: null,
      });

      if (user.playerId) {
        await logAccountDeletionEvent(user.playerId, AccountDeletionAuditAction.CANCELLED, { ip: getClientIp(req) });
      }
      return true;
    },

    // Cancels a pending deletion for the calling session's own account — the
    // "sign back in and cancel" path (settled July 28, 2026): sign-in still
    // works normally while pending, see lib/auth.ts's authorize(). No token
    // needed since the session already establishes ownership, same
    // no-argument-always-targets-self convention as requestAccountDeletion.
    cancelMyPendingDeletion: async (_: unknown, __: unknown, { playerId, req }: any) => {
      if (!playerId) throw new Error("Not authorized");
      await connectToDatabase();
      const player = await Player.findById(playerId);
      if (!player?.userId) throw new Error("Player not found");
      const user = await User.findById(player.userId);
      if (!user) throw new Error("Account not found");
      if (!user.scheduledScrubAt) return true; // idempotent

      await User.findByIdAndUpdate(user._id, {
        pendingDeletionRequestedAt: null,
        scheduledScrubAt: null,
        cancelDeletionTokenHash: null,
        cancelDeletionTokenExpiry: null,
      });

      await logAccountDeletionEvent(playerId, AccountDeletionAuditAction.CANCELLED, { ip: getClientIp(req) });
      return true;
    },

    // Players
    updatePlayer: async (
      _: unknown,
      {
        id,
        tag,
        region,
        avatarUrl,
        characters,
        team,
        twitchUrl,
        twitterUrl,
        instagramUrl,
        youtubeUrl,
        discordUrl,
        tiktokUrl,
        otherLinkUrl,
        otherLinkLabel,
      }: {
        id: string;
        tag?: string;
        region?: string;
        avatarUrl?: string;
        characters?: string[];
        team?: string;
        twitchUrl?: string;
        twitterUrl?: string;
        instagramUrl?: string;
        youtubeUrl?: string;
        discordUrl?: string;
        tiktokUrl?: string;
        otherLinkUrl?: string;
        otherLinkLabel?: string;
      },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      if (playerId !== id && !isAdminOrAbove(role)) throw new Error("Not authorized");

      await connectToDatabase();
      const update: any = { tag, region, characters };
      if (avatarUrl !== undefined) update.avatarUrl = avatarUrl;
      if (team !== undefined) update.team = team;
      if (twitchUrl !== undefined) update.twitchUrl = twitchUrl;
      applySocialLinkFields(update, { twitterUrl, instagramUrl, youtubeUrl, discordUrl, tiktokUrl, otherLinkUrl, otherLinkLabel });
      return Player.findByIdAndUpdate(id, update, { new: true });
    },

    // ADMIN-only soft-delete. Keeps the Player document (and every
    // Match/Entrant/Tournament/Event reference to it) intact — only scrubs
    // personal info and disables login. See models/Player.ts and
    // models/User.ts for what `isDeleted` means on each.
    deletePlayer: async (
      _: unknown,
      { id }: { id: string },
      { playerId, role, req }: { playerId?: string; role?: string; req?: Request }
    ) => {
      if (!isAdminOrAbove(role)) throw new Error("Not authorized");
      // Guards against an admin locking themselves out by mistake.
      if (playerId === id) throw new Error("You can't delete your own account");

      await connectToDatabase();
      const player = await Player.findById(id);
      if (!player) throw new Error("Player not found");

      await softDeletePlayer(player, { ip: req ? getClientIp(req) : undefined, performedByPlayerId: playerId ?? null });
      return true;
    },

    // SUPER_ADMIN-only (settled July 28, 2026) — reverses a scrub within its
    // restore window. Player.scrubBackupTag/User.scrubBackupEmail are the
    // ONLY things restored: the account's passwordHash was randomized at
    // scrub time (softDeletePlayer) and is genuinely, deliberately not part
    // of the backup — the restored player needs a fresh password reset.
    restoreDeletedPlayer: async (
      _: unknown,
      { playerId: targetPlayerId }: { playerId: string },
      { playerId: callerPlayerId, role, req }: { playerId?: string; role?: string; req?: Request }
    ) => {
      if (!isSuperAdmin(role)) throw new Error("Not authorized");

      await connectToDatabase();
      const player = await Player.findById(targetPlayerId);
      if (!player) throw new Error("Player not found");
      if (!player.isDeleted || !player.scrubBackupTag) {
        throw new Error("This player has no restorable backup — either it isn't deleted, or its restore window has expired.");
      }

      const user = player.userId ? await User.findById(player.userId) : null;
      if (!user?.scrubBackupEmail) {
        throw new Error("This player's account backup is missing or has expired — the tag can't be safely restored without it.");
      }

      // Pre-check both potential collisions before touching either
      // document — this app doesn't use multi-document transactions
      // anywhere else, so avoiding a half-applied restore (tag restored,
      // email restore failed, or vice versa) means checking feasibility
      // up front rather than rolling back after a partial failure.
      const tagTaken = await Player.exists({ tag: player.scrubBackupTag, _id: { $ne: player._id } });
      if (tagTaken) throw new Error(`Can't restore — the tag "${player.scrubBackupTag}" is now in use by another player.`);
      const emailTaken = await User.exists({ email: user.scrubBackupEmail, _id: { $ne: user._id } });
      if (emailTaken) throw new Error("Can't restore — this email is now in use by another account.");

      await Player.findByIdAndUpdate(player._id, {
        isDeleted: false,
        deletedAt: null,
        tag: player.scrubBackupTag,
        scrubBackupTag: null,
      });
      await User.findByIdAndUpdate(user._id, {
        isDeleted: false,
        deletedAt: null,
        email: user.scrubBackupEmail,
        scrubBackupEmail: null,
        scrubBackupExpiresAt: null,
      });

      await logAccountDeletionEvent(player._id, AccountDeletionAuditAction.RESTORED, {
        ip: req ? getClientIp(req) : undefined,
        performedByPlayerId: callerPlayerId ?? null,
      });

      return Player.findById(player._id);
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
      { contactEmail, reason }: { contactEmail: string; reason?: string },
      { playerId }: { playerId?: string }
    ) => {
      if (!playerId) throw new Error("Not authorized");
      // Basic format check (not exhaustive/RFC-compliant, matching the
      // "basic email format validation" ask) — real enforcement, since the
      // matching client-side check in RequestTOButton can be bypassed by a
      // direct API call.
      if (!EMAIL_REGEX.test(contactEmail.trim())) {
        throw new Error("Please enter a valid contact email.");
      }
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

      return TORequest.create({ playerId, contactEmail: contactEmail.trim(), reason: reason?.trim() || "" });
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

      // Session-staleness caveat (isTO is JWT-cached, same as role) — the
      // player won't actually see their new capabilities until they
      // re-authenticate, so the notification says so up front rather than
      // leaving them confused when nothing changes mid-session.
      await Notification.create({
        playerId: request.playerId,
        type: "TO_STATUS_GRANTED",
        message: "Your Tournament Organizer (TO) status has been granted! Sign out and back in for it to take effect.",
        link: `/players/${request.playerId}`,
      });

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

      // Same notification as approveTORequest — both paths grant the exact
      // same TO status, so the player hears about it the same way either way.
      await Notification.create({
        playerId,
        type: "TO_STATUS_GRANTED",
        message: "Your Tournament Organizer (TO) status has been granted! Sign out and back in for it to take effect.",
        link: `/players/${playerId}`,
      });

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
        poolModel,
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
        poolModel?: string;
      },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      if (!playerId) throw new Error("Not authorized");

      // Keyed by playerId (authenticated action), not IP.
      const { success } = await createTournamentRateLimit.limit(playerId);
      if (!success) throw rateLimitedError("You've created too many tournaments today. Please try again tomorrow.");

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
        poolModel: poolModel || undefined,
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
      if (format !== undefined) {
        // Once pools exist, the tournament's whole data model (Pool
        // documents, per-pool Brackets, mainBracketId) is committed to the
        // Pools + Bracket flow — switching format away at that point would
        // orphan them with no corresponding UI. Changing INTO this format is
        // still allowed at any time (it only starts to matter once pools
        // are actually generated).
        if (tournament.format === "Pools + Bracket" && format !== "Pools + Bracket" && (await Pool.exists({ tournamentId: id }))) {
          throw new Error("Can't change format away from Pools + Bracket once pools have been generated");
        }
        update.format = format;
      }
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
      {
        id,
        streamBackgroundUrl,
        sponsorBannerUrl,
        sponsorBannerUrls,
        sponsorBannerIntervalSeconds,
      }: {
        id: string;
        streamBackgroundUrl?: string;
        sponsorBannerUrl?: string;
        sponsorBannerUrls?: { url: string; linkUrl?: string | null }[];
        sponsorBannerIntervalSeconds?: number | null;
      },
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
      if (
        tournament.isRestricted &&
        (streamBackgroundUrl || sponsorBannerUrl || (sponsorBannerUrls && sponsorBannerUrls.length > 0))
      ) {
        throw new Error("This tournament was created without TO status and can't set a stream background or sponsor banner.");
      }

      const update: any = {};
      if (streamBackgroundUrl !== undefined) update.streamBackgroundUrl = streamBackgroundUrl;
      if (sponsorBannerUrl !== undefined) update.sponsorBannerUrl = sponsorBannerUrl;

      // Slideshow — a rotation needs an interval to rotate BY, so 2+ final
      // URLs (whichever of this call's array or the already-saved one wins,
      // same for the interval) must resolve to a valid 1-3600s interval.
      // A single selected URL (or zero) doesn't need one — the stream view
      // just renders it statically, same as the plain sponsorBannerUrl case.
      // linkUrl is per-slide and independent — trimmed/normalized to "" (not
      // null/undefined) same empty-is-unset convention as every other
      // optional URL field on this model, so a slide with no link just
      // isn't clickable, no separate error/validation needed.
      const finalUrls =
        sponsorBannerUrls !== undefined
          ? sponsorBannerUrls.filter(b => b && b.url).map(b => ({ url: b.url, linkUrl: b.linkUrl?.trim() || "" }))
          : (tournament.sponsorBannerUrls ?? []);
      const finalInterval = sponsorBannerIntervalSeconds !== undefined ? sponsorBannerIntervalSeconds : tournament.sponsorBannerIntervalSeconds;
      if (finalUrls.length >= 2 && (!finalInterval || finalInterval < 1)) {
        throw new Error("Set a rotation interval to enable the sponsor banner slideshow.");
      }

      if (sponsorBannerUrls !== undefined) update.sponsorBannerUrls = finalUrls;
      if (sponsorBannerIntervalSeconds !== undefined) {
        update.sponsorBannerIntervalSeconds =
          sponsorBannerIntervalSeconds === null ? null : Math.min(3600, Math.max(1, sponsorBannerIntervalSeconds));
      }

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

    // Organizer/admin-initiated add — the ORGANIZER-side counterpart to
    // joinTournament (which only ever lets a player add themselves, or an
    // admin add anyone). Powers the QR-scan "add player" flow (a TO scans a
    // real walk-up player's Player ID QR code and adds them directly).
    // Reuses joinTournament's exact LIVE/ENDED status gate and
    // duplicate-entry handling, but deliberately does NOT enforce
    // joinTournament's PRIVATE-visibility invite check — an organizer
    // manually adding someone from their own roster-management view is
    // already the authority over who's in their tournament, invite or not.
    addEntrantByOrganizer: async (
      _: unknown,
      { tournamentId, playerId }: { tournamentId: string; playerId: string },
      { playerId: callerPlayerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const tournament = await Tournament.findById(tournamentId);
      if (!tournament) throw new Error("Tournament not found");
      if (!isOrganizer(tournament, callerPlayerId, role)) throw new Error("Not authorized");
      if (tournament.status === "LIVE" || tournament.status === "ENDED") {
        throw new Error("Cannot add a player to a tournament that is already live or has ended");
      }

      const player = await Player.findById(playerId);
      if (!player || player.isDeleted) throw new Error("Player not found");

      const existingEntrant = await Entrant.findOne({ tournamentId, playerId });
      if (existingEntrant) {
        return { entrant: existingEntrant, alreadyEntered: true };
      }

      const entrant = await Entrant.create({ tournamentId, playerId });
      // Same invite-consumption behavior as joinTournament — if this player
      // happened to have a pending invite, being added directly satisfies
      // it, so it shouldn't linger as a stale pending invite afterward.
      if (tournament.visibility === "PRIVATE" && tournament.invitedPlayerIds.some((id: any) => id.toString() === playerId)) {
        tournament.invitedPlayerIds = tournament.invitedPlayerIds.filter((id: any) => id.toString() !== playerId);
        await tournament.save();
      }
      await Tournament.findByIdAndUpdate(tournamentId, { $inc: { entrantCount: 1 } });

      // Same "someone new joined" notification as joinTournament.
      const others = await Entrant.find({ tournamentId, playerId: { $ne: playerId } });
      if (others.length > 0) {
        await Notification.create(
          others.map(e => ({
            playerId: e.playerId,
            type: "PLAYER_JOINED",
            message: `${player.tag} joined ${tournament.name}`,
            link: `/tournaments/${tournamentId}`,
          }))
        );
      }

      return { entrant, alreadyEntered: false };
    },

    // Self check-in (isSelf) or TO/admin check-in on someone else's behalf
    // (isManager) — same isSelf-OR-isManager shape as leaveTournament, not
    // addEntrantByOrganizer's manager-only shape, since unlike adding an
    // entrant this is legitimately something the entrant does for
    // themselves. Idempotent: checking in an already-checked-in entrant
    // doesn't overwrite their original checkedInAt (arrival order stays
    // meaningful), it just reports alreadyCheckedIn: true.
    checkInEntrant: async (
      _: unknown,
      { tournamentId, playerId }: { tournamentId: string; playerId: string },
      { playerId: callerPlayerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const tournament = await Tournament.findById(tournamentId);
      if (!tournament) throw new Error("Tournament not found");

      const isSelf = callerPlayerId === playerId;
      const isManager = isOrganizer(tournament, callerPlayerId, role);
      if (!isSelf && !isManager) throw new Error("Not authorized");

      if (tournament.status === "ENDED" || tournament.status === "CANCELLED") {
        throw new Error("Cannot check in to a tournament that has already ended or was cancelled");
      }

      const entrant = await Entrant.findOne({ tournamentId, playerId });
      if (!entrant) throw new Error("This player hasn't joined this tournament yet.");

      if (entrant.checkedInAt) {
        return { entrant, alreadyCheckedIn: true };
      }

      const updated = await Entrant.findByIdAndUpdate(entrant._id, { checkedInAt: new Date() }, { new: true });
      return { entrant: updated, alreadyCheckedIn: false };
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

    clearPlacement: async (
      _: unknown,
      { entrantId }: { entrantId: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const entrant = await Entrant.findById(entrantId);
      if (!entrant) throw new Error("Entrant not found");

      const tournament = await Tournament.findById(entrant.tournamentId);
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");

      // Resets placementSetManually along with the value, not just the
      // value alone -- clearing is meant to undo the manual override
      // entirely, returning this entrant to the same state as one that's
      // never had a placement touched. Leaving placementSetManually true
      // with placement null would permanently lock this entrant out of
      // computeAndApplyBracketPlacements (lib/bracket.ts skips any entrant
      // with that flag set, even on a re-run) -- on a bracket that's still
      // live and could still recompute placements (e.g. an editMatchResult
      // correction on the Grand Final), that would silently leave this one
      // entrant stuck without a placement forever, instead of letting it be
      // reclaimed automatically like every other entrant.
      return Entrant.findByIdAndUpdate(entrantId, { placement: null, placementSetManually: false }, { new: true });
    },

    // Brackets
    generateBracket: async (
      _: unknown,
      { tournamentId, seedingMethod, manualSeedOrder, manualSlotAssignment }: { tournamentId: string; seedingMethod: SeedingMethod; manualSeedOrder?: string[]; manualSlotAssignment?: (string | null)[] },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const tournament = await Tournament.findById(tournamentId);
      if (!tournament) throw new Error("Tournament not found");
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");
      if (tournament.status === "ENDED" || tournament.status === "CANCELLED") {
        throw new Error("Cannot generate a bracket for a tournament that has ended or was cancelled");
      }
      if (tournament.format === "Pools + Bracket") {
        throw new Error("This tournament uses Pools + Bracket format — generate pools and the main bracket separately");
      }

      const existing = await Bracket.findOne({ tournamentId, poolId: null });
      if (existing) throw new Error("This tournament already has a bracket — delete it first to regenerate");

      const entrants = await Entrant.find({ tournamentId });
      if (entrants.length < 2) throw new Error("Need at least 2 entrants to generate a bracket");

      const bracketId = new Types.ObjectId();
      let matches: ReturnType<typeof buildDoubleEliminationBracket>["matches"];
      let seedOrderForDisplay: string[];
      let bracketSize: number;

      if (seedingMethod === "MANUAL_BRACKET") {
        const entrantPlayerIds = entrants.map((e: any) => e.playerId.toString());
        validateManualSlotAssignment(entrantPlayerIds, manualSlotAssignment);
        ({ matches } = buildDoubleEliminationBracket({ tournamentId, bracketId, orderedPlayerIds: [], manualSlots: manualSlotAssignment! }));
        seedOrderForDisplay = manualSlotAssignment!.filter((id): id is string => id != null);
        bracketSize = manualSlotAssignment!.length;
      } else {
        const orderedPlayerIds = await resolveSeedOrder(seedingMethod, entrants, manualSeedOrder);
        ({ matches } = buildDoubleEliminationBracket({ tournamentId, bracketId, orderedPlayerIds }));
        seedOrderForDisplay = orderedPlayerIds;
        bracketSize = nextPowerOfTwo(orderedPlayerIds.length);
      }

      // Reflect the computed seed number back onto each Entrant — reuses the
      // existing `seed` field already displayed in the entrant sidebar. For
      // MANUAL_BRACKET this is "position among filled slots," not a ranking
      // in the traditional sense, but keeps the same UI convention working.
      await Promise.all(
        seedOrderForDisplay.map((pid, i) => Entrant.updateOne({ tournamentId, playerId: pid }, { seed: i + 1 }))
      );

      const bracket = await Bracket.create({
        _id: bracketId,
        tournamentId,
        seedingMethod,
        seedOrder: seedOrderForDisplay,
        size: bracketSize,
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
      if (tournament.format === "Pools + Bracket") {
        throw new Error("This tournament uses Pools + Bracket format — generate pools and the main bracket separately");
      }

      const bracket = await Bracket.findOne({ tournamentId, poolId: null });
      if (!bracket) return false;

      await Match.deleteMany({ bracketId: bracket._id });
      await Bracket.findByIdAndDelete(bracket._id);
      return true;
    },

    // Pool play + top-cut bracket format. Splits every current entrant
    // evenly across poolCount pools (round-robin over a shuffled order —
    // pool ASSIGNMENT is a simple even/random split, not skill-based;
    // skill-aware seeding only applies later, to the main bracket) and
    // generates each pool's own double-elimination Bracket via the exact
    // same generator generateBracket uses, scoped to that pool's entrant
    // subset. Entrant itself is never duplicated — Pool.entrantIds just
    // references the tournament's existing Entrant documents.
    generatePools: async (
      _: unknown,
      { tournamentId, poolCount }: { tournamentId: string; poolCount?: number },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const tournament = await Tournament.findById(tournamentId);
      if (!tournament) throw new Error("Tournament not found");
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");
      if (tournament.format !== "Pools + Bracket") {
        throw new Error("This tournament isn't using the Pools + Bracket format");
      }
      if (tournament.status === "ENDED" || tournament.status === "CANCELLED") {
        throw new Error("Cannot generate pools for a tournament that has ended or was cancelled");
      }

      const existingPools = await Pool.countDocuments({ tournamentId });
      if (existingPools > 0) throw new Error("Pools have already been generated for this tournament");

      const entrants = await Entrant.find({ tournamentId });
      if (entrants.length < 4) throw new Error("Need at least 4 entrants to generate pools");

      const count = poolCount && poolCount >= 1 ? Math.floor(poolCount) : suggestPoolCount(entrants.length);
      if (entrants.length < count * 2) {
        throw new Error("Not enough entrants for that many pools — each pool needs at least 2 entrants");
      }

      const shuffledEntrants = shuffle([...entrants]);
      const poolEntrantGroups: (typeof entrants)[] = Array.from({ length: count }, () => []);
      shuffledEntrants.forEach((entrant, i) => poolEntrantGroups[i % count].push(entrant));

      // Model A (round-robin) coalesces the same way isRestricted/poolModel
      // itself does elsewhere — a tournament created before this field
      // existed has it genuinely absent, not "C".
      const isModelA = (tournament.poolModel ?? "C") === "A";

      const createdPools = [];
      for (let i = 0; i < count; i++) {
        const group = poolEntrantGroups[i];
        if (group.length === 0) continue;

        const pool = await Pool.create({
          tournamentId,
          poolNumber: i + 1,
          entrantIds: group.map((e: any) => e._id),
        });

        const orderedPlayerIds = group.map((e: any) => e.playerId.toString());

        if (isModelA) {
          // Model A: true round-robin, no elimination bracket — every
          // match is independent (Match.poolId, no bracketId), so there's
          // no Bracket document for this pool at all.
          const { matches } = buildRoundRobinMatches({ tournamentId, poolId: pool._id, playerIds: orderedPlayerIds });
          if (matches.length > 0) await Match.insertMany(matches);
          createdPools.push(pool);
          continue;
        }

        const bracketId = new Types.ObjectId();
        const { matches } = buildDoubleEliminationBracket({ tournamentId, bracketId, orderedPlayerIds });

        await Bracket.create({
          _id: bracketId,
          tournamentId,
          poolId: pool._id,
          seedingMethod: "RANDOM",
          seedOrder: orderedPlayerIds,
          size: nextPowerOfTwo(orderedPlayerIds.length),
        });

        if (matches.length > 0) await Match.insertMany(matches);
        createdPools.push(pool);
      }

      return createdPools;
    },

    // Pool format Model B (lib/bracket.ts's generateModelBTournament) only.
    // Builds Round 1 ONLY -- structurally identical to a normal Model A/C
    // pool round (flat entrant list -> a real Pool + its own Bracket/Match
    // documents, same generator/DB-write pattern as generatePools above), so
    // it reuses that exact shape rather than inventing a new one. Round 2+
    // needs the repooling machinery (computeNextRepooledRound) driven off
    // real match results once a round completes -- that round-to-round
    // advancement trigger is a separate, later mechanism, not this mutation.
    generateModelBPools: async (
      _: unknown,
      { tournamentId }: { tournamentId: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const tournament = await Tournament.findById(tournamentId);
      if (!tournament) throw new Error("Tournament not found");
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");
      if (tournament.format !== "Pools + Bracket") {
        throw new Error("This tournament isn't using the Pools + Bracket format");
      }
      if ((tournament.poolModel ?? "C") !== "B") {
        throw new Error("This tournament isn't using Pool format Model B");
      }
      if (tournament.status === "ENDED" || tournament.status === "CANCELLED") {
        throw new Error("Cannot generate pools for a tournament that has ended or was cancelled");
      }

      const existingPools = await Pool.countDocuments({ tournamentId });
      if (existingPools > 0) throw new Error("Pools have already been generated for this tournament");

      const entrants = await Entrant.find({ tournamentId });
      if (entrants.length < MODEL_B_MIN_ENTRANTS) {
        throw new Error(
          `Model B needs at least ${MODEL_B_MIN_ENTRANTS} entrants (got ${entrants.length}) -- use Model A or C for smaller fields`
        );
      }

      // Same power-of-two, ~15-entrants/pool sizing generateModelBTournament's
      // own Phase 3 logic uses, then split evenly across it -- identical
      // shuffle + round-robin distribution generatePools uses above for
      // Model A/C.
      const count = computeModelBInitialPoolCount(entrants.length);
      const shuffledEntrants = shuffle([...entrants]);
      const poolEntrantGroups: (typeof entrants)[] = Array.from({ length: count }, () => []);
      shuffledEntrants.forEach((entrant, i) => poolEntrantGroups[i % count].push(entrant));

      const createdPools = [];
      for (let i = 0; i < count; i++) {
        const group = poolEntrantGroups[i];
        if (group.length === 0) continue;

        const pool = await Pool.create({
          tournamentId,
          poolNumber: i + 1,
          entrantIds: group.map((e: any) => e._id),
        });

        const orderedPlayerIds = group.map((e: any) => e.playerId.toString());
        const bracketId = new Types.ObjectId();
        const { matches } = buildDoubleEliminationBracket({ tournamentId, bracketId, orderedPlayerIds });

        await Bracket.create({
          _id: bracketId,
          tournamentId,
          poolId: pool._id,
          seedingMethod: "RANDOM",
          seedOrder: orderedPlayerIds,
          size: nextPowerOfTwo(orderedPlayerIds.length),
        });

        if (matches.length > 0) await Match.insertMany(matches);
        createdPools.push(pool);
      }

      return createdPools;
    },

    // Pool format Model B only. Advances one real round to the next -- see
    // the schema doc comment above advanceModelBRound for the full picture.
    // Manual/TO-triggered, same precedent as generateMainBracket ("same UX
    // as today's existing Generate Bracket action... rather than
    // auto-generating the moment the last pool finishes").
    advanceModelBRound: async (
      _: unknown,
      { tournamentId }: { tournamentId: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const tournament = await Tournament.findById(tournamentId);
      if (!tournament) throw new Error("Tournament not found");
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");
      if ((tournament.poolModel ?? "C") !== "B") {
        throw new Error("This tournament isn't using Pool format Model B");
      }
      if (tournament.mainBracketId) {
        throw new Error("This tournament's Finals bracket has already been generated -- there's nothing left to advance");
      }

      const allPools = await Pool.find({ tournamentId });
      if (allPools.length === 0) throw new Error("No pools have been generated yet -- call generateModelBPools first");

      const currentRound = Math.max(...allPools.map((p: any) => p.roundNumber ?? 1));
      const currentRoundPools = allPools
        .filter((p: any) => (p.roundNumber ?? 1) === currentRound)
        .sort((a: any, b: any) => a.poolNumber - b.poolNumber);

      for (const pool of currentRoundPools) {
        if (!(await isPoolComplete(pool))) {
          throw new Error(
            `Round ${currentRound} isn't complete yet -- every pool must finish (Grand Final, and Reset if played, COMPLETED) before advancing`
          );
        }
      }

      // ── Case A: the current round is a Finals-cutoff round -- its own
      // bracket has no Grand Final by design (buildFinalsCutoffBracket), so
      // there's nothing left to regroup. Resolve its 8 real qualifiers
      // (stored at generation time -- see Pool.finalsCutoffFinalistSpecs)
      // and generate the tournament's real Finals bracket. ──
      if (currentRoundPools.length === 1 && currentRoundPools[0].isFinalsCutoff) {
        const cutoffPool = currentRoundPools[0];
        const finalistPlayerIds: string[] = [];
        for (const spec of cutoffPool.finalsCutoffFinalistSpecs ?? []) {
          if (spec.kind === "PLAYER") {
            finalistPlayerIds.push(spec.playerId.toString());
          } else {
            const m = await Match.findById(spec.matchId);
            if (!m?.winnerId) {
              throw new Error("Internal error: a Finals-cutoff qualifying match has no winner despite the round being marked complete");
            }
            finalistPlayerIds.push(m.winnerId.toString());
          }
        }

        const finalsBracketId = new Types.ObjectId();
        const { matches: finalsMatches } = buildDoubleEliminationBracket({
          tournamentId,
          bracketId: finalsBracketId,
          orderedPlayerIds: finalistPlayerIds,
        });
        await Bracket.create({
          _id: finalsBracketId,
          tournamentId,
          poolId: null,
          seedingMethod: "RANDOM",
          seedOrder: finalistPlayerIds,
          size: nextPowerOfTwo(finalistPlayerIds.length),
        });
        if (finalsMatches.length > 0) await Match.insertMany(finalsMatches);
        await Tournament.findByIdAndUpdate(tournamentId, { mainBracketId: finalsBracketId });

        // No new Pool this call -- the real Finals bracket is now exposed
        // via the same Tournament.mainBracket slot Model A/C's
        // generateMainBracket already fills.
        return [];
      }

      // ── Case B: an ordinary round -- read this round's REAL results
      // (extractPoolSurvivors, not placeholders) and regroup them. ──
      const poolSurvivors: PoolSurvivors[] = [];
      for (const pool of currentRoundPools) {
        const bracket = await Bracket.findOne({ poolId: pool._id });
        if (!bracket) throw new Error(`Internal error: Pool ${pool.poolNumber} has no Bracket document`);
        const survivors = await extractPoolSurvivors(bracket);
        poolSurvivors.push({ entrantCount: pool.entrantIds.length, ...survivors });
      }

      const result = computeNextRepooledRound({ tournamentId, pools: poolSurvivors });
      const nextRound = currentRound + 1;
      let nextPoolNumber = (await Pool.countDocuments({ tournamentId })) + 1;

      if (result.stage === "MERGE" || !result.splitsIntoFinals) {
        // MERGE stage, or a final consolidated pool small enough that its
        // OWN Grand Final simply IS the tournament's real final -- persist
        // as a normal pool round, same write pattern generateModelBPools
        // uses for Round 1.
        const createdPools = [];
        for (const np of result.newPools) {
          const pool = await persistRepooledPool({
            tournamentId,
            roundNumber: nextRound,
            poolNumber: nextPoolNumber++,
            playerIds: [...np.winnersSurvivorIds, ...np.losersSurvivorIds],
            bracketId: np.bracketId,
            matches: np.matches,
            bracketSize: np.winnersEntrySize,
          });
          createdPools.push(pool);
        }
        return createdPools;
      }

      // ── FINAL_CONSOLIDATION, splitsIntoFinals -- persist the Semifinal
      // round as a Finals-cutoff pool (buildFinalsCutoffBracket) instead of
      // a normal pool bracket; its own real Grand Final never gets built at
      // all. The real Finals bracket itself is generated on a LATER
      // advanceModelBRound call, once THIS round's own matches are actually
      // played (Case A above) -- the 8-finalist SHAPE is already known
      // (Phase 2.5/3), but real results from a real round of matches are
      // still required before real identities exist. ──
      const finalPool = result.newPools[0];
      // Reuses finalPool.bracketId -- computeNextRepooledRound built a full
      // (wrong, never-actually-played) bracket under that ID via
      // buildRepooledBracket internally, but its matches were never
      // persisted above, so there's nothing to collide with; this just
      // avoids minting a second ObjectId for no reason.
      const finalsCutoff = buildFinalsCutoffBracket({
        tournamentId,
        bracketId: finalPool.bracketId,
        winnersSurvivorIds: finalPool.winnersSurvivorIds,
        winnersEntrySize: finalPool.winnersEntrySize,
        losersSurvivorIds: finalPool.losersSurvivorIds,
      });

      const finalistSpecs = finalsCutoff.finalistSlots.map((slot: any) => {
        if (slot.kind === "PLAYER") return { kind: "PLAYER", playerId: slot.playerId };
        if (slot.kind === "PENDING") return { kind: "PENDING", matchId: slot.draft._id };
        throw new Error("Internal error: a Model B Finals-cutoff finalist slot was an unresolved bye");
      });

      const semifinalPool = await persistRepooledPool({
        tournamentId,
        roundNumber: nextRound,
        poolNumber: nextPoolNumber,
        playerIds: [...finalPool.winnersSurvivorIds, ...finalPool.losersSurvivorIds],
        bracketId: finalPool.bracketId,
        matches: finalsCutoff.matches,
        bracketSize: finalPool.winnersEntrySize,
        isFinalsCutoff: true,
        finalsCutoffFinalistSpecs: finalistSpecs,
      });

      return [semifinalPool];
    },

    // Pool play + top-cut only. Requires every pool to be complete (see
    // isPoolComplete). Seeds a fresh main bracket from the 2 advancers per
    // pool — for a Model B/C pool that's its Grand Final player1/player2
    // (the winners-finalist and losers-finalist, by the same convention
    // lib/bracket.ts's Grand Final build always uses, regardless of who
    // actually won that Grand Final); for a Model A (round-robin) pool it's
    // the top 2 finishers by standings (see roundRobinAdvancers). Either
    // way the "first"/"second" advancer plays the same role in
    // computeMainBracketSeedOrder's AVOID_SAME_POOL low-seed/high-seed split.
    generateMainBracket: async (
      _: unknown,
      { tournamentId, seedingMethod, manualSlotAssignment }: { tournamentId: string; seedingMethod: "RANDOM" | "AVOID_SAME_POOL" | "MANUAL_BRACKET"; manualSlotAssignment?: (string | null)[] },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const tournament = await Tournament.findById(tournamentId);
      if (!tournament) throw new Error("Tournament not found");
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");
      if (tournament.format !== "Pools + Bracket") {
        throw new Error("This tournament isn't using the Pools + Bracket format");
      }
      if (tournament.mainBracketId) {
        throw new Error("The main bracket has already been generated");
      }
      if (seedingMethod !== "RANDOM" && seedingMethod !== "AVOID_SAME_POOL" && seedingMethod !== "MANUAL_BRACKET") {
        throw new Error("Main bracket seeding must be Random, Avoid same-pool matchups, or Manual");
      }

      const pools = await Pool.find({ tournamentId }).sort({ poolNumber: 1 });
      if (pools.length === 0) throw new Error("No pools have been generated yet");
      if (!(await arePoolsComplete(tournamentId))) {
        throw new Error("Every pool must finish before generating the main bracket");
      }

      const winnersFinalistIds: string[] = [];
      const losersFinalistIds: string[] = [];
      for (const pool of pools) {
        const poolBracket = await Bracket.findOne({ poolId: pool._id });
        if (poolBracket) {
          const grandFinal = await Match.findOne({ bracketId: poolBracket._id, bracketSide: "GRAND_FINAL" });
          if (!grandFinal?.player1Id || !grandFinal?.player2Id) {
            throw new Error(`Pool ${pool.poolNumber} doesn't have a complete Grand Final yet`);
          }
          winnersFinalistIds.push(grandFinal.player1Id.toString());
          losersFinalistIds.push(grandFinal.player2Id.toString());
        } else {
          // Model A (round-robin) pool — no Bracket, advancers come from
          // standings instead.
          const { first, second } = await roundRobinAdvancers(pool);
          winnersFinalistIds.push(first);
          losersFinalistIds.push(second);
        }
      }

      const bracketId = new Types.ObjectId();
      let matches: ReturnType<typeof buildDoubleEliminationBracket>["matches"];
      let seedOrderForDisplay: string[];
      let bracketSize: number;

      if (seedingMethod === "MANUAL_BRACKET") {
        const participantIds = [...winnersFinalistIds, ...losersFinalistIds];
        validateManualSlotAssignment(participantIds, manualSlotAssignment);
        ({ matches } = buildDoubleEliminationBracket({ tournamentId, bracketId, orderedPlayerIds: [], manualSlots: manualSlotAssignment! }));
        seedOrderForDisplay = manualSlotAssignment!.filter((id): id is string => id != null);
        bracketSize = manualSlotAssignment!.length;
      } else {
        const orderedPlayerIds = computeMainBracketSeedOrder(winnersFinalistIds, losersFinalistIds, seedingMethod);
        ({ matches } = buildDoubleEliminationBracket({ tournamentId, bracketId, orderedPlayerIds }));
        seedOrderForDisplay = orderedPlayerIds;
        bracketSize = nextPowerOfTwo(orderedPlayerIds.length);
      }

      // Reflect the main-bracket seed number onto each advancing Entrant —
      // same convention generateBracket uses for a standard tournament.
      await Promise.all(
        seedOrderForDisplay.map((pid, i) => Entrant.updateOne({ tournamentId, playerId: pid }, { seed: i + 1 }))
      );

      const bracket = await Bracket.create({
        _id: bracketId,
        tournamentId,
        poolId: null,
        seedingMethod,
        seedOrder: seedOrderForDisplay,
        size: bracketSize,
      });

      if (matches.length > 0) await Match.insertMany(matches);

      await Tournament.findByIdAndUpdate(tournamentId, { mainBracketId: bracket._id });

      return bracket;
    },

    // Pool play + top-cut only. Reverts back to "entrants only, no pools",
    // same mirror-of-deleteBracket cleanup (Match then Bracket documents),
    // scoped to every Pool's own Bracket instead of the tournament's single
    // non-pool one. Blocked while a main bracket already exists — it was
    // seeded from these pools' Grand Final results, so deleting the pools
    // out from under it would leave it referencing data that no longer
    // makes sense; the TO must delete the main bracket first.
    //
    // No placement reset needed here (unlike deleteMainBracket below): a
    // pool's own Grand Final completing never calls
    // computeAndApplyBracketPlacements in the first place — advanceBracketMatch
    // gates it out for any bracket with a poolId (lib/bracket.ts) — so pool
    // play never wrote automatic placements for this to undo.
    deletePools: async (
      _: unknown,
      { tournamentId }: { tournamentId: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const tournament = await Tournament.findById(tournamentId);
      if (!tournament) throw new Error("Tournament not found");
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");
      if (tournament.format !== "Pools + Bracket") {
        throw new Error("This tournament isn't using the Pools + Bracket format");
      }
      if (tournament.mainBracketId) {
        throw new Error("Delete the main bracket first — it was seeded from these pools' results");
      }

      const pools = await Pool.find({ tournamentId });
      if (pools.length === 0) return false;

      for (const pool of pools) {
        const bracket = await Bracket.findOne({ poolId: pool._id });
        if (bracket) {
          await Match.deleteMany({ bracketId: bracket._id });
          await Bracket.findByIdAndDelete(bracket._id);
        } else {
          // Model A (round-robin) pool — no Bracket document; its matches
          // are found by poolId instead.
          await Match.deleteMany({ poolId: pool._id });
        }
      }
      await Pool.deleteMany({ tournamentId });

      return true;
    },

    // Pool play + top-cut only. Reverts back to "pools complete, no main
    // bracket yet" — mirrors deleteBracket's Match-then-Bracket cleanup,
    // scoped to the tournament's mainBracketId instead of its single
    // non-pool bracket, and additionally clears that pointer field. Pools
    // themselves are left completely untouched.
    deleteMainBracket: async (
      _: unknown,
      { tournamentId }: { tournamentId: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const tournament = await Tournament.findById(tournamentId);
      if (!tournament) throw new Error("Tournament not found");
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");
      if (tournament.format !== "Pools + Bracket") {
        throw new Error("This tournament isn't using the Pools + Bracket format");
      }
      if (!tournament.mainBracketId) return false;

      const bracket = await Bracket.findById(tournament.mainBracketId);
      if (bracket) {
        await Match.deleteMany({ bracketId: bracket._id });
        // The main bracket is the ONE bracket in a Pools + Bracket
        // tournament that ever calls computeAndApplyBracketPlacements
        // (pool brackets are gated out, see deletePools' comment above),
        // so it's the only one that could have written automatic
        // placements — reset those back to unset. Scoped to exactly this
        // bracket's own seeded entrants (bracket.seedOrder), never a
        // tournament entrant unrelated to this bracket, and never a TO's
        // own manual override (placementSetManually) — same respect for
        // manual overrides computeAndApplyBracketPlacements itself has.
        await Entrant.updateMany(
          { tournamentId, playerId: { $in: bracket.seedOrder }, placementSetManually: { $ne: true } },
          { placement: null }
        );
        await Bracket.findByIdAndDelete(bracket._id);
      }
      await Tournament.findByIdAndUpdate(tournamentId, { mainBracketId: null });

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

    // Replaces the old deleteMatch/deleteMatchWithCascade (removed — its
    // arbitrary-depth cascade was found to be silently breaking live
    // brackets in production). Only ever valid on a bracket's current
    // terminal match (see isMatchUndoable/Match.canUndo below) — nothing
    // downstream has been played yet, so there's no cascade needed: just
    // this one match's own score/winner back to PENDING, its win/loss
    // effects reversed (undoMatchEffects, reused from lib/bracket.ts
    // unchanged), and any automatic placement it triggered un-applied
    // (also inside undoMatchEffects) without touching a manual override.
    undoMatchResult: async (_: unknown, { matchId }: { matchId: string }, { playerId, role }: { playerId?: string; role?: string }) => {
      await connectToDatabase();
      const match = await Match.findById(matchId);
      if (!match) throw new Error("Match not found");

      const tournament = await Tournament.findById(match.tournamentId);
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");

      if (!match.bracketId) {
        throw new Error("Undo is only available for bracket matches.");
      }
      if (match.status !== MatchStatus.COMPLETED) {
        throw new Error("This match hasn't been reported yet — nothing to undo.");
      }
      // Same "nothing downstream played" gate editMatchResult already uses
      // — throws with a specific reason if this isn't actually the
      // bracket's current terminal match.
      await assertBracketMatchEditable(match);

      await undoMatchEffects(match);

      return await Match.findByIdAndUpdate(
        matchId,
        { winnerId: null, isForfeit: false, player1Score: 0, player2Score: 0, status: MatchStatus.PENDING },
        { new: true }
      );
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

    // Admin management gap for uncurated game entries (settled July 26,
    // 2026) — "Curate with corrected name". Unlike createGame (which just
    // accepts whatever string the admin types as the new Game's name), this
    // is specifically for turning an UNCURATED orphan entry (see the `games`
    // resolver) into a real curated Game, optionally under a CORRECTED name
    // — and, when the name actually changes, retroactively renaming
    // Tournament.game on every tournament that used the old/typo'd spelling
    // so they end up attached to the new curated Game instead of leaving a
    // second, still-broken orphan entry behind under the old spelling.
    //
    // find-or-create by newName rather than always creating: curating a
    // typo (oldName) into a spelling that's ALREADY a real curated Game
    // (e.g. fixing "Street Fight 6" -> "Street Fighter 6") should merge into
    // that existing Game, not fail with a duplicate-name error — that's
    // exactly the typo-duplicate cleanup this feature exists for.
    curateUncuratedGame: async (
      _: unknown,
      { oldName, newName, iconUrl }: { oldName: string; newName: string; iconUrl?: string },
      { role }: { role?: string }
    ) => {
      if (!isAdminOrAbove(role)) throw new Error("Not authorized");
      if (!newName.trim()) throw new Error("Game name is required.");
      const trimmedNewName = newName.trim();
      await connectToDatabase();

      let game = await Game.findOne({ name: trimmedNewName });
      if (!game) {
        try {
          game = await Game.create({ name: trimmedNewName, iconUrl });
        } catch (err: any) {
          if (err?.code === 11000) throw new Error("A game with that name already exists.");
          throw err;
        }
      } else if (iconUrl !== undefined && iconUrl !== game.iconUrl) {
        game = await Game.findByIdAndUpdate(game._id, { iconUrl }, { new: true });
      }

      // Retroactive fix — a no-op update when oldName === trimmedNewName
      // (curating an orphan under its own exact string, the old plain
      // "Curate" behavior), harmless either way.
      await Tournament.updateMany({ game: oldName }, { game: trimmedNewName });

      return game;
    },

    // Admin management gap for uncurated game entries (settled July 26,
    // 2026) — "Hide from list". Persists to the tiny HiddenGameName
    // collection (see models/HiddenGameName.ts) so the `games` resolver
    // skips this exact string going forward — deliberately does NOT touch
    // any Tournament.game value and does NOT create a real Game document
    // (for junk like a literal "n/a" that isn't a real game and doesn't
    // need "correcting", just needs to stop cluttering the list). Idempotent
    // — hiding an already-hidden name is a no-op success, not an error.
    hideUncuratedGame: async (_: unknown, { name }: { name: string }, { role }: { role?: string }) => {
      if (!isAdminOrAbove(role)) throw new Error("Not authorized");
      if (!name.trim()) throw new Error("Game name is required.");
      await connectToDatabase();
      await HiddenGameName.findOneAndUpdate({ name: name.trim() }, { name: name.trim() }, { upsert: true });
      return true;
    },

    // Reverses hideUncuratedGame — just deletes the HiddenGameName doc.
    // Idempotent (unhiding something not currently hidden is a no-op
    // success, not an error), same convention as hideUncuratedGame itself.
    // Whether the name actually reappears in the `games` list afterward
    // depends entirely on whether a real Tournament.game still matches it
    // (see the `games` resolver) — nothing here needs to check that itself.
    unhideUncuratedGame: async (_: unknown, { name }: { name: string }, { role }: { role?: string }) => {
      if (!isAdminOrAbove(role)) throw new Error("Not authorized");
      if (!name.trim()) throw new Error("Game name is required.");
      await connectToDatabase();
      await HiddenGameName.deleteOne({ name: name.trim() });
      return true;
    },

    // Events
    createEvent: async (
      _: unknown,
      {
        name,
        isOnlineOnly,
        address,
        logoUrl,
        twitchUrl,
        description,
        twitterUrl,
        instagramUrl,
        youtubeUrl,
        discordUrl,
        tiktokUrl,
        otherLinkUrl,
        otherLinkLabel,
      }: {
        name: string;
        isOnlineOnly?: boolean;
        address?: string;
        logoUrl?: string;
        twitchUrl?: string;
        description?: string;
        twitterUrl?: string;
        instagramUrl?: string;
        youtubeUrl?: string;
        discordUrl?: string;
        tiktokUrl?: string;
        otherLinkUrl?: string;
        otherLinkLabel?: string;
      },
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
        description,
        twitterUrl,
        instagramUrl,
        youtubeUrl,
        discordUrl,
        tiktokUrl,
        otherLinkUrl,
        otherLinkLabel,
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
        description,
        twitterUrl,
        instagramUrl,
        youtubeUrl,
        discordUrl,
        tiktokUrl,
        otherLinkUrl,
        otherLinkLabel,
      }: {
        id: string;
        name?: string;
        isOnlineOnly?: boolean;
        address?: string;
        logoUrl?: string;
        twitchUrl?: string;
        description?: string;
        twitterUrl?: string;
        instagramUrl?: string;
        youtubeUrl?: string;
        discordUrl?: string;
        tiktokUrl?: string;
        otherLinkUrl?: string;
        otherLinkLabel?: string;
      },
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
      if (description !== undefined) update.description = description;
      applySocialLinkFields(update, { twitterUrl, instagramUrl, youtubeUrl, discordUrl, tiktokUrl, otherLinkUrl, otherLinkLabel });

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
        description,
        twitterUrl,
        instagramUrl,
        youtubeUrl,
        discordUrl,
        tiktokUrl,
        otherLinkUrl,
        otherLinkLabel,
      }: {
        id: string;
        name?: string;
        isOnlineOnly?: boolean;
        address?: string;
        logoUrl?: string;
        twitchUrl?: string;
        description?: string;
        twitterUrl?: string;
        instagramUrl?: string;
        youtubeUrl?: string;
        discordUrl?: string;
        tiktokUrl?: string;
        otherLinkUrl?: string;
        otherLinkLabel?: string;
      },
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
      if (description !== undefined) update.description = description;
      applySocialLinkFields(update, { twitterUrl, instagramUrl, youtubeUrl, discordUrl, tiktokUrl, otherLinkUrl, otherLinkLabel });

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
    gameRankings: async (parent: { _id: string }) => await computeGameRankingsForPlayer(parent._id.toString()),
    tournaments: async (parent: { _id: string }) => await Entrant.find({ playerId: parent._id }),
    // Gated at the field level (not just hidden in the profile page's JSX)
    // since displayId is the real Player ID used for QR check-in — anyone
    // could otherwise read it straight off the public /api/graphql endpoint
    // regardless of what the page renders. Visible to the player themselves,
    // Admin/Super Admin, and any TO (site-wide, not scoped to tournaments
    // they organize — a deliberate exception confirmed July 27, 2026, not a
    // pattern to reuse elsewhere without checking back first).
    displayId: (
      parent: { _id: string; playerNumber?: number },
      _args: unknown,
      context: { playerId?: string; role?: string; isTO?: boolean }
    ) => {
      if (parent.playerNumber == null) return null;
      const isOwner = context.playerId === parent._id.toString();
      if (!isOwner && !isAdminOrAbove(context.role) && !context.isTO) return null;
      return formatPlayerNumber(parent.playerNumber);
    },
    isLiveOnTwitch: async (parent: { twitchUrl?: string }, _args: unknown, { loaders }: { loaders: Loaders }) => {
      const username = extractTwitchUsername(parent.twitchUrl)?.toLowerCase();
      if (!username) return false;
      return loaders.twitchLiveLoader.load(username);
    },
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
    bracket: async (parent: { _id: string }) => await Bracket.findOne({ tournamentId: parent._id, poolId: null }),
    // Pool play + top-cut bracket format fields — empty/false/the plain
    // count-based suggestion for every tournament that isn't using this
    // format (and before generatePools has run for one that is).
    pools: async (parent: { _id: string }) => await Pool.find({ tournamentId: parent._id }).sort({ poolNumber: 1 }),
    mainBracket: async (parent: { mainBracketId?: string }) =>
      parent.mainBracketId ? await Bracket.findById(parent.mainBracketId) : null,
    allPoolsComplete: async (parent: { _id: string }) => await arePoolsComplete(parent._id),
    modelBCurrentRoundComplete: async (parent: { _id: string; poolModel?: string; mainBracketId?: string }) => {
      if ((parent.poolModel ?? "C") !== "B") return false;
      if (parent.mainBracketId) return false; // Finals bracket already generated -- nothing left to advance
      const pools = await Pool.find({ tournamentId: parent._id });
      if (pools.length === 0) return false;
      const currentRound = Math.max(...pools.map((p: any) => p.roundNumber ?? 1));
      return await arePoolsComplete(parent._id, currentRound);
    },
    suggestedPoolCount: (parent: { entrantCount?: number }) => suggestPoolCount(parent.entrantCount ?? 0),
    // Same "schema default doesn't retroactively apply to old documents"
    // coalescing as isRestricted above.
    poolModel: (parent: { poolModel?: string }) => parent.poolModel ?? "C",
    // Same coalescing — every tournament created before the slideshow
    // feature existed has this genuinely absent (not []) in its stored
    // document, which the non-null [SponsorBannerSlide!]! schema field can't
    // return as-is.
    sponsorBannerUrls: (parent: { sponsorBannerUrls?: { url: string; linkUrl?: string }[] }) => parent.sponsorBannerUrls ?? [],
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

  Pool: {
    entrants: async (parent: { entrantIds?: string[] }) =>
      parent.entrantIds ? await Entrant.find({ _id: { $in: parent.entrantIds } }) : [],
    bracket: async (parent: { _id: string }) => await Bracket.findOne({ poolId: parent._id }),
    // Model A (round-robin) only — empty for a Model B/C pool (its matches
    // live under bracket.matches instead).
    matches: async (parent: { _id: string }) => await Match.find({ poolId: parent._id }).sort({ createdAt: 1 }),
    // Model A (round-robin) only — null for a Model B/C pool, which has no
    // round-robin matches to compute standings from.
    standings: async (parent: { _id: string; entrantIds?: string[] }) => {
      const hasRoundRobinMatches = await Match.exists({ poolId: parent._id });
      if (!hasRoundRobinMatches) return null;

      const entrants = await Entrant.find({ _id: { $in: parent.entrantIds ?? [] } });
      const entrantByPlayerId = new Map(entrants.map((e: any) => [e.playerId.toString(), e]));
      const rows = await computeRoundRobinStandings(
        parent._id,
        entrants.map((e: any) => e.playerId.toString())
      );
      return rows.map(row => ({ ...row, entrant: entrantByPlayerId.get(row.playerId) }));
    },
  },

  Event: {
    displayId: (parent: { eventNumber?: number }) =>
      parent.eventNumber != null ? formatEventNumber(parent.eventNumber) : null,
    isLiveOnTwitch: async (parent: { twitchUrl?: string }, _args: unknown, { loaders }: { loaders: Loaders }) => {
      const username = extractTwitchUsername(parent.twitchUrl)?.toLowerCase();
      if (!username) return false;
      return loaders.twitchLiveLoader.load(username);
    },
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
    // Batched via a per-request DataLoader — this field resolves once per
    // Entrant in a list (e.g. every entrant on a tournament page), so an
    // individual findById here is exactly the N+1 shape DataLoader exists
    // to collapse. See graphql/loaders.ts.
    player: async (parent: { playerId: string }, _args: unknown, { loaders }: { loaders: Loaders }) =>
      await loaders.playerLoader.load(parent.playerId.toString()),
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
    // player1/player2/winner/nextMatch/nextLoserMatch are each resolved once
    // PER MATCH -- a tournament page renders every match in every visible
    // bracket, so these are the exact N+1 fan-out DataLoader exists to
    // collapse into batched find({_id:{$in:[...]}}) calls. See
    // graphql/loaders.ts; measured impact in the Notion Phase 7 writeup.
    player1: async (parent: { player1Id?: string }, _args: unknown, { loaders }: { loaders: Loaders }) =>
      parent.player1Id ? await loaders.playerLoader.load(parent.player1Id.toString()) : null,
    player2: async (parent: { player2Id?: string }, _args: unknown, { loaders }: { loaders: Loaders }) =>
      parent.player2Id ? await loaders.playerLoader.load(parent.player2Id.toString()) : null,
    winner: async (parent: { winnerId?: string }, _args: unknown, { loaders }: { loaders: Loaders }) =>
      parent.winnerId ? await loaders.playerLoader.load(parent.winnerId.toString()) : null,
    tournament: async (parent: { tournamentId: string }) => await Tournament.findById(parent.tournamentId),
    bracket: async (parent: { bracketId?: string }) => (parent.bracketId ? await Bracket.findById(parent.bracketId) : null),
    nextMatch: async (parent: { nextMatchId?: string }, _args: unknown, { loaders }: { loaders: Loaders }) =>
      parent.nextMatchId ? await loaders.matchLoader.load(parent.nextMatchId.toString()) : null,
    nextLoserMatch: async (parent: { nextLoserMatchId?: string }, _args: unknown, { loaders }: { loaders: Loaders }) =>
      parent.nextLoserMatchId ? await loaders.matchLoader.load(parent.nextLoserMatchId.toString()) : null,
    // Gates the Undo button — true only for a bracket match that's COMPLETED
    // with nothing downstream played yet. Reuses assertBracketMatchEditable
    // (the exact same "nothing downstream played" gate editMatchResult
    // already enforces) rather than a second, possibly-drifting definition
    // of the same structural check.
    canUndo: async (parent: { bracketId?: string; status?: string }) => {
      if (!parent.bracketId) return false;
      if (parent.status !== MatchStatus.COMPLETED) return false;
      try {
        await assertBracketMatchEditable(parent);
        return true;
      } catch {
        return false;
      }
    },
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
