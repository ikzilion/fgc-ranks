// app/admin/to-status/page.tsx
// TO permission overhaul — ADMIN-only page combining both granting paths:
// the pending-request review queue (mirrors app/admin/events) and direct
// grant/revoke on any player (mirrors app/admin/users), in one place rather
// than splitting them across two nav links for what's really one workflow.
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { isAdminOrAbove } from "@/lib/roles";
import { AdminTOManager } from "@/components/AdminTOManager";

export const dynamic = "force-dynamic";

const GET_TO_ADMIN_DATA = `
  query GetTOAdminData {
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
      user { id isTO createdAt }
    }
  }
`;

async function getTOAdminData() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  try {
    const res = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: (await cookies()).toString() },
      body: JSON.stringify({ query: GET_TO_ADMIN_DATA }),
      cache: "no-store",
    });
    const json = await res.json();
    if (json.errors) {
      console.error("[admin/to-status] GraphQL errors:", json.errors);
      return { pendingRequests: [], players: [] };
    }
    return {
      pendingRequests: json.data?.pendingTORequests ?? [],
      players: json.data?.players ?? [],
    };
  } catch (err) {
    console.error("[admin/to-status] Fetch error:", err);
    return { pendingRequests: [], players: [] };
  }
}

export default async function AdminTOStatusPage() {
  const session = await auth();
  const role = (session?.user as any)?.role;
  if (!isAdminOrAbove(role)) notFound();

  const { pendingRequests, players } = await getTOAdminData();

  return (
    <main className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="font-rajdhani text-2xl font-bold text-[var(--text-primary)] mb-1">Manage TO status</h1>
      <p className="text-[12px] text-[var(--text-secondary)] mb-6">
        Review pending Tournament Organizer requests, or grant/revoke TO status directly on any player.
      </p>

      <AdminTOManager pendingRequests={pendingRequests} players={players} />
    </main>
  );
}
