// app/admin/page.tsx
// Consolidated Admin dashboard — ADMIN-gated, one page with a sub-tab for
// each admin tool (Review queue, Manage games, Manage TOs, and Admin roles
// for SUPER_ADMIN) instead of requiring separate navigation to each
// /admin/* route. Those individual routes still exist and still work
// (nothing here removes them — a bookmark/direct link keeps working), this
// is just the one-stop entry point the nav links to now.
//
// One combined GraphQL request covers every tab's data up front (same
// cookie-forwarding reasoning as the original app/admin/events/page.tsx —
// pendingEvents/pendingTORequests are ADMIN-only queries, and a plain
// server-side fetch() doesn't carry the session cookie on its own).
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { isAdminOrAbove, isSuperAdmin } from "@/lib/roles";
import { AdminDashboard } from "@/components/AdminDashboard";

export const dynamic = "force-dynamic";

const GET_ADMIN_DASHBOARD_DATA = `
  query GetAdminDashboardData {
    pendingEvents {
      id
      displayId
      name
      isOnlineOnly
      address
      logoUrl
      twitchUrl
      createdAt
      creator { id tag }
    }
    games {
      id
      name
      iconUrl
      tournamentCount
    }
    pendingTORequests {
      id
      contactEmail
      reason
      createdAt
      player {
        id
        tag
        displayId
        avatarUrl
        user { id createdAt }
        tournaments { id }
      }
    }
    players(limit: 200) {
      id
      tag
      displayId
      avatarUrl
      user { id role isTO createdAt }
    }
  }
`;

async function getAdminDashboardData() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  try {
    const res = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: (await cookies()).toString() },
      body: JSON.stringify({ query: GET_ADMIN_DASHBOARD_DATA }),
      cache: "no-store",
    });
    const json = await res.json();
    if (json.errors) {
      console.error("[admin] GraphQL errors:", json.errors);
      return { pendingEvents: [], games: [], pendingTORequests: [], players: [] };
    }
    return {
      pendingEvents: json.data?.pendingEvents ?? [],
      games: json.data?.games ?? [],
      pendingTORequests: json.data?.pendingTORequests ?? [],
      players: json.data?.players ?? [],
    };
  } catch (err) {
    console.error("[admin] Fetch error:", err);
    return { pendingEvents: [], games: [], pendingTORequests: [], players: [] };
  }
}

export default async function AdminPage() {
  const session = await auth();
  const role = (session?.user as any)?.role;
  if (!isAdminOrAbove(role)) notFound();

  const { pendingEvents, games, pendingTORequests, players } = await getAdminDashboardData();

  return (
    <main className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="font-rajdhani text-2xl font-bold text-[var(--text-primary)] mb-1">Admin</h1>
      <p className="text-[12px] text-[var(--text-secondary)] mb-6">All admin tools in one place.</p>

      <AdminDashboard
        pendingEvents={pendingEvents}
        games={games}
        pendingTORequests={pendingTORequests}
        players={players}
        showAdminRoles={isSuperAdmin(role)}
      />
    </main>
  );
}
