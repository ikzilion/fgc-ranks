import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomBytes, createHash } from "crypto";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db";
import { User } from "@/models/User";
import { Player } from "@/models/Player";
import { Tournament } from "@/models/Tournament";
import { Entrant } from "@/models/Entrant";
import { Match, MatchStatus } from "@/models/Match";
import { Bracket } from "@/models/Bracket";
import { Notification } from "@/models/Notification";
import { loginRateLimit, registerRateLimit, passwordResetRateLimit, getClientIp } from "@/lib/rateLimit";
import { sendPasswordResetEmail } from "@/lib/email";
import { buildDoubleEliminationBracket, resolveSeedOrder, advanceBracketMatch, nextPowerOfTwo, SeedingMethod } from "@/lib/bracket";
import { NextRequest } from "next/server";

const JWT_SECRET = process.env.NEXTAUTH_SECRET || "dev-secret";

// A player can manage a tournament if they're a global ADMIN, or if their
// playerId is in that specific tournament's organizers list (Tournament
// Organizer / TO access — scoped per-tournament, not a global role).
function isOrganizer(tournament: any, playerId?: string, role?: string): boolean {
  if (role === "ADMIN") return true;
  if (!playerId || !tournament?.organizers) return false;
  return tournament.organizers.some((orgId: any) => orgId.toString() === playerId);
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
    players: async (_: unknown, { limit = 20, offset = 0 }: { limit?: number; offset?: number }) => {
      await connectToDatabase();
      return await Player.find().sort({ points: -1 }).skip(offset).limit(limit);
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
    tournaments: async (
      _: unknown,
      { status, limit = 20, offset = 0 }: { status?: string; limit?: number; offset?: number }
    ) => {
      await connectToDatabase();
      const filter = status ? { status } : {};
      return await Tournament.find(filter).sort({ startDate: -1 }).skip(offset).limit(limit);
    },

    tournament: async (_: unknown, { id }: { id: string }) => {
      await connectToDatabase();
      return await Tournament.findById(id);
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
      { email, password, tag }: { email: string; password: string; tag: string },
      { req }: { req: NextRequest }
    ) => {
      const ip = getClientIp(req);
      const { success } = await registerRateLimit.limit(ip);
      if (!success) throw new Error("Too many accounts created from this IP. Please try again later.");

      await connectToDatabase();
      const passwordHash = await bcrypt.hash(password, 10);
      const user = await User.create({ email, passwordHash });
      const player = await Player.create({ userId: user._id, tag });
      await User.findByIdAndUpdate(user._id, { playerId: player._id });
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
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) throw new Error("Invalid email or password");
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

    // Players
    updatePlayer: async (
      _: unknown,
      { id, tag, region, avatarUrl, characters }: { id: string; tag?: string; region?: string; avatarUrl?: string; characters?: string[] },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      if (playerId !== id && role !== "ADMIN") throw new Error("Not authorized");

      await connectToDatabase();
      const update: any = { tag, region, characters };
      if (avatarUrl !== undefined) update.avatarUrl = avatarUrl;
      return Player.findByIdAndUpdate(id, update, { new: true });
    },

    // Tournaments
    createTournament: async (
      _: unknown,
      { name, game, startDate }: { name: string; game: string; startDate: Date },
      { playerId }: { playerId?: string }
    ) => {
      if (!playerId) throw new Error("Not authorized");

      await connectToDatabase();
      // The creator automatically becomes the tournament's first organizer.
      return Tournament.create({ name, game, startDate, organizers: [playerId] });
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
      if (callerPlayerId !== inviteeId && role !== "ADMIN") throw new Error("Not authorized");

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

      const update: any = {};
      if (streamBackgroundUrl !== undefined) update.streamBackgroundUrl = streamBackgroundUrl;
      if (sponsorBannerUrl !== undefined) update.sponsorBannerUrl = sponsorBannerUrl;

      return Tournament.findByIdAndUpdate(id, update, { new: true });
    },

    updateTournamentBracketLineColor: async (
      _: unknown,
      { id, bracketLineColor }: { id: string; bracketLineColor: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const tournament = await Tournament.findById(id);
      if (!tournament) throw new Error("Tournament not found");
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");

      return Tournament.findByIdAndUpdate(id, { bracketLineColor }, { new: true });
    },

    // Entrants
    joinTournament: async (
      _: unknown,
      { tournamentId, playerId }: { tournamentId: string; playerId: string },
      { playerId: callerPlayerId, role }: { playerId?: string; role?: string }
    ) => {
      if (callerPlayerId !== playerId && role !== "ADMIN") throw new Error("Not authorized");

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

    setPlacement: async (_: unknown, { entrantId, placement }: { entrantId: string; placement: number }) => {
      await connectToDatabase();
      return Entrant.findByIdAndUpdate(entrantId, { placement }, { new: true });
    },

    // Matches
    createMatch: async (
      _: unknown,
      { tournamentId, player1Id, player2Id, round }: { tournamentId: string; player1Id: string; player2Id: string; round: string },
      { playerId, role }: { playerId?: string; role?: string }
    ) => {
      await connectToDatabase();
      const tournament = await Tournament.findById(tournamentId);
      if (!tournament) throw new Error("Tournament not found");
      if (!isOrganizer(tournament, playerId, role)) throw new Error("Not authorized");

      // Both players must actually be entrants of this tournament — the UI only
      // offers entrants as options, but a raw GraphQL call could bypass that.
      const [entrant1, entrant2] = await Promise.all([
        Entrant.findOne({ tournamentId, playerId: player1Id }),
        Entrant.findOne({ tournamentId, playerId: player2Id }),
      ]);
      if (!entrant1 || !entrant2) throw new Error("Both players must be entrants of this tournament");

      return Match.create({ tournamentId, player1Id, player2Id, round });
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
      await Player.findByIdAndUpdate(winnerId, { $inc: { wins: 1, points: 100 } });
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
        throw new Error("Editing bracket match results isn't supported yet — bracket progression would need to be reversed and replayed.");
      }

      if (match.status !== MatchStatus.COMPLETED) {
        throw new Error("This match hasn't been reported yet — use reportResult instead");
      }

      // Reverse the previously-applied win/loss/points effects before applying
      // the corrected result, so stats don't get double-counted (same pattern
      // deleteMatch uses).
      if (match.winnerId) {
        const previousLoserId =
          match.winnerId.toString() === match.player1Id.toString() ? match.player2Id : match.player1Id;
        await Player.findByIdAndUpdate(match.winnerId, { $inc: { wins: -1, points: -100 } });
        await Player.findByIdAndUpdate(previousLoserId, { $inc: { losses: -1 } });
      }

      const { winnerId, loserId, updateFields } = resolveMatchOutcome(match, { player1Score, player2Score, isForfeit, forfeitingPlayerId });

      const updated = await Match.findByIdAndUpdate(matchId, updateFields, { new: true });

      await Player.findByIdAndUpdate(winnerId, { $inc: { wins: 1, points: 100 } });
      await Player.findByIdAndUpdate(loserId, { $inc: { losses: 1 } });

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

      // Undo the win/loss/points effects reportResult applied, so deleting a
      // completed match doesn't leave stale stats behind.
      if (match.status === MatchStatus.COMPLETED && match.winnerId) {
        const loserId = match.winnerId.toString() === match.player1Id.toString() ? match.player2Id : match.player1Id;
        await Player.findByIdAndUpdate(match.winnerId, { $inc: { wins: -1, points: -100 } });
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

      // Undo the win/loss/points effects reportResult applied for any
      // completed matches, so deleting the tournament doesn't leave stale stats.
      const completedMatches = await Match.find({ tournamentId: id, status: MatchStatus.COMPLETED, winnerId: { $ne: null } });
      for (const match of completedMatches) {
        const loserId = match.winnerId.toString() === match.player1Id.toString() ? match.player2Id : match.player1Id;
        await Player.findByIdAndUpdate(match.winnerId, { $inc: { wins: -1, points: -100 } });
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
  },

  // ─── Field resolvers (populate references) ─────────────────────────────────

  User: {
    player: async (parent: { playerId: string }) => await Player.findById(parent.playerId),
  },

  Player: {
    user: async (parent: { userId: string }) => await User.findById(parent.userId),
    tournaments: async (parent: { _id: string }) => await Entrant.find({ playerId: parent._id }),
    winRate: (parent: { wins: number; losses: number }) => {
      const total = parent.wins + parent.losses;
      return total === 0 ? 0 : Math.round((parent.wins / total) * 100) / 100;
    },
  },

  Tournament: {
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
  },

  Entrant: {
    player: async (parent: { playerId: string }) => await Player.findById(parent.playerId),
    tournament: async (parent: { tournamentId: string }) => await Tournament.findById(parent.tournamentId),
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
