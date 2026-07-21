// lib/auth.ts
import NextAuth, { CredentialsSignin } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { connectToDatabase } from "@/lib/db";
import { User } from "@/models/User";
import { Player } from "@/models/Player";
import { loginRateLimit, getClientIp } from "@/lib/rateLimit";

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
        token.tag = user.tag;
        token.playerId = user.playerId;
        token.avatarUrl = user.avatarUrl;
      }
      return token;
    },
    async session({ session, token }: any) {
      if (session.user) {
        session.user.role = token.role;
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
