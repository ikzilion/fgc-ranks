import type { NextAuthConfig } from "next-auth";

// Starter config — add real providers (Credentials, Discord, etc.) as the
// player/user login flow gets built out.
export const authConfig: NextAuthConfig = {
  providers: [],
  pages: {
    signIn: "/login",
  },
};
