import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { connectToDatabase } from "@/lib/db";
import { User } from "@/models/User";
import { Player } from "@/models/Player";
import { Tournament } from "@/models/Tournament";
import { Entrant } from "@/models/Entrant";
import { Match, MatchStatus } from "@/models/Match";
import { Notification } from "@/models/Notification";

const JWT_SECRET = process.env.NEXTAUTH_SECRET || "dev-secret";

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
      { email, password, tag }: { email: string; password: string; tag: string }
    ) => {
      await connectToDatabase();
      const passwordHash = await bcrypt.hash(password, 10);
      const user = await User.create({ email, passwordHash });
      const player = await Player.create({ userId: user._id, tag });
      await User.findByIdAndUpdate(user._id, { playerId: player._id });
      const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: "7d" });
      return { token, user };
    },

    login: async (_: unknown, { email, password }: { email: string; password: string }) => {
      await connectToDatabase();
      const user = await User.findOne({ email });
      if (!user) throw new Error("Invalid email or password");
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) throw new Error("Invalid email or password");
      const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: "7d" });
      return { token, user };
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
      { role }: { role?: string }
    ) => {
      if (role !== "ADMIN") throw new Error("Not authorized");

      await connectToDatabase();
      return Tournament.create({ name, game, startDate });
    },

    updateTournamentStatus: async (
      _: unknown,
      { id, status }: { id: string; status: string },
      { role }: { role?: string }
    ) => {
      if (role !== "ADMIN") throw new Error("Not authorized");

      await connectToDatabase();
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

      const existingEntrant = await Entrant.findOne({ tournamentId, playerId });
      if (existingEntrant) {
        return existingEntrant;
      }
      const entrant = await Entrant.create({ tournamentId, playerId });
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
      { role }: { role?: string }
    ) => {
      if (role !== "ADMIN") throw new Error("Not authorized");

      await connectToDatabase();
      return Match.create({ tournamentId, player1Id, player2Id, round });
    },

    reportResult: async (
      _: unknown,
      { matchId, player1Score, player2Score }: { matchId: string; player1Score: number; player2Score: number },
      { role }: { role?: string }
    ) => {
      if (role !== "ADMIN") throw new Error("Not authorized");

      await connectToDatabase();
      const match = await Match.findById(matchId);
      if (!match) throw new Error("Match not found");

      const winnerId = player1Score > player2Score ? match.player1Id : match.player2Id;
      const loserId = player1Score > player2Score ? match.player2Id : match.player1Id;

      // Update match result
      const updated = await Match.findByIdAndUpdate(
        matchId,
        { player1Score, player2Score, winnerId, status: MatchStatus.COMPLETED },
        { new: true }
      );

      // Update win/loss records on both players
      await Player.findByIdAndUpdate(winnerId, { $inc: { wins: 1, points: 100 } });
      await Player.findByIdAndUpdate(loserId, { $inc: { losses: 1 } });

      // Notify both players their match result was reported
      await Notification.create([
        { playerId: winnerId, type: "MATCH_REPORTED", message: `You won your ${match.round} match!`, link: `/tournaments/${match.tournamentId}` },
        { playerId: loserId, type: "MATCH_REPORTED", message: `Your ${match.round} match result was reported.`, link: `/tournaments/${match.tournamentId}` },
      ]);

      return updated;
    },

    deleteMatch: async (_: unknown, { id }: { id: string }, { role }: { role?: string }) => {
      if (role !== "ADMIN") throw new Error("Not authorized");

      await connectToDatabase();
      const match = await Match.findById(id);
      if (!match) return false;

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

    deleteTournament: async (_: unknown, { id }: { id: string }, { role }: { role?: string }) => {
      if (role !== "ADMIN") throw new Error("Not authorized");

      await connectToDatabase();

      // Undo the win/loss/points effects reportResult applied for any
      // completed matches, so deleting the tournament doesn't leave stale stats.
      const completedMatches = await Match.find({ tournamentId: id, status: MatchStatus.COMPLETED, winnerId: { $ne: null } });
      for (const match of completedMatches) {
        const loserId = match.winnerId.toString() === match.player1Id.toString() ? match.player2Id : match.player1Id;
        await Player.findByIdAndUpdate(match.winnerId, { $inc: { wins: -1, points: -100 } });
        await Player.findByIdAndUpdate(loserId, { $inc: { losses: -1 } });
      }

      // Clean up related matches and entrants first
      await Match.deleteMany({ tournamentId: id });
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
      if (entrant.playerId.toString() !== playerId && role !== "ADMIN") throw new Error("Not authorized");

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
  },

  Entrant: {
    player: async (parent: { playerId: string }) => await Player.findById(parent.playerId),
    tournament: async (parent: { tournamentId: string }) => await Tournament.findById(parent.tournamentId),
  },

  Match: {
    player1: async (parent: { player1Id: string }) => await Player.findById(parent.player1Id),
    player2: async (parent: { player2Id: string }) => await Player.findById(parent.player2Id),
    winner: async (parent: { winnerId?: string }) =>
      parent.winnerId ? await Player.findById(parent.winnerId) : null,
    tournament: async (parent: { tournamentId: string }) => await Tournament.findById(parent.tournamentId),
  },
};
