// lib/auth.ts
import NextAuth, { CredentialsSignin } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { connectToDatabase } from "@/lib/db";
import { User } from "@/models/User";
import { Player } from "@/models/Player";
import { loginRateLimit, getClientIp } from "@/lib/rateLimit";
import { softDeletePlayer } from "@/lib/accountDeletion";

class RateLimitedSignin extends CredentialsSignin {
  code = "rate_limited";
}

class EmailNotVerifiedSignin extends CredentialsSignin {
  code = "email_not_verified";
}

export const authConfig = {
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        if (!credentials?.email || !credentials?.password) return null;

        const ip = getClientIp(request);
        const { success } = await loginRateLimit.limit(ip);
        if (!success) throw new RateLimitedSignin();

        await connectToDatabase();
        const user = await User.findOne({ email: credentials.email });
        if (!user) return null;
        // Soft-deleted accounts are rejected outright, regardless of
        // whether the credential would otherwise be valid.
        if (user.isDeleted) return null;
        // Grace-period account deletion (settled July 28, 2026) — this app
        // has no cron/scheduled-job infrastructure, so an account whose
        // 7-day window has elapsed is scrubbed lazily on next contact
        // rather than by a background job. app/api/graphql/route.ts's
        // context factory covers this for site traffic in general
        // (lib/accountDeletion.ts's runAccountDeletionMaintenance), but a
        // direct login attempt never touches /api/graphql first — so this
        // is the redundant, narrower check specifically for "the account
        // owner comes back and tries to log in after their window already
        // passed but nothing has swept it yet."
        if (user.scheduledScrubAt && user.scheduledScrubAt <= new Date()) {
          const player = user.playerId ? await Player.findById(user.playerId) : null;
          if (player) await softDeletePlayer(player, { ip });
          return null; // now scrubbed — same rejection as an already-deleted account
        }
        const valid = await bcrypt.compare(credentials.password as string, user.passwordHash);
        if (!valid) return null;
        // `=== false` (not falsy) — a grandfathered legacy account with no
        // emailVerified field set (undefined) must NOT be blocked here.
        if (user.emailVerified === false) throw new EmailNotVerifiedSignin();
        // Look up the player tag linked to this user
        const player = await Player.findOne({ userId: user._id });
        return {
          id: user._id.toString(),
          email: user.email,
          role: user.role,
          isTO: user.isTO ?? false,
          tag: player?.tag ?? user.email.split("@")[0],
          playerId: player?._id.toString() ?? null,
          avatarUrl: player?.avatarUrl ?? null,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }: any) {
      if (user) {
        token.role = user.role;
        token.isTO = user.isTO;
        token.tag = user.tag;
        token.playerId = user.playerId;
        token.avatarUrl = user.avatarUrl;
      }
      return token;
    },
    async session({ session, token }: any) {
      if (session.user) {
        // token.sub is NextAuth's own standard claim for the authenticated
        // user's id (mirrors authorize()'s returned `id` automatically,
        // nothing sets it explicitly above) -- previously never copied onto
        // session.user here, which left app/api/graphql/route.ts's
        // `userId: session?.user?.id` context field permanently undefined.
        // Latent until now: Query.me is the only resolver that ever reads
        // it, and nothing called `me` until the account-deletion grace-
        // period feature's pending-deletion banner (settled July 28, 2026).
        session.user.id = token.sub;
        session.user.role = token.role;
        session.user.isTO = token.isTO;
        session.user.tag = token.tag;
        session.user.playerId = token.playerId;
        session.user.avatarUrl = token.avatarUrl;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
