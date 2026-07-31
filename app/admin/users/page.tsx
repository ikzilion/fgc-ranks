// app/admin/users/page.tsx
// Admin-role management — SUPER_ADMIN-only. Search players and grant/revoke
// ADMIN status. Same admin-gated SSR pattern as app/admin/events/page.tsx,
// INCLUDING the session-cookie forwarding: this page's own auth() check is
// just the notFound() gate (UX), while grantAdmin/revokeAdmin (the real
// enforcement) run as browser mutations from AdminUserManager.
//
// The cookie header below is NOT optional (corrected July 31, 2026). This
// page reads `user { role }` and `displayId`, both of which are now
// session-gated in the resolver — a plain server-side fetch() carries no
// cookies, so without it the GraphQL context sees an anonymous caller and
// every role/displayId here comes back null. (displayId was in fact already
// silently null on this page for exactly that reason, the same latent bug
// class hit twice before on the profile and tournament pages.)
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { isSuperAdmin } from "@/lib/roles";
import { AdminUserManager } from "@/components/AdminUserManager";

export const dynamic = "force-dynamic";

const GET_PLAYERS_FOR_ADMIN = `
  query GetPlayersForAdmin {
    players(limit: 200) {
      id
      tag
      displayId
      avatarUrl
      user {
        id
        role
      }
    }
  }
`;

async function getPlayers() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  try {
    const res = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: (await cookies()).toString() },
      body: JSON.stringify({ query: GET_PLAYERS_FOR_ADMIN }),
      cache: "no-store",
    });
    const json = await res.json();
    if (json.errors) {
      console.error("[admin/users] GraphQL errors:", json.errors);
      return [];
    }
    return json.data?.players ?? [];
  } catch (err) {
    console.error("[admin/users] Fetch error:", err);
    return [];
  }
}

export default async function AdminUsersPage() {
  const session = await auth();
  const role = (session?.user as any)?.role;
  if (!isSuperAdmin(role)) notFound();

  const players = await getPlayers();

  return (
    <main className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="font-rajdhani text-2xl font-bold text-[var(--text-primary)] mb-1">Admin roles</h1>
      <p className="text-[12px] text-[var(--text-secondary)] mb-6">
        Grant or revoke Admin status. Only the Super Admin account can do this.
      </p>

      <AdminUserManager players={players} />
    </main>
  );
}
