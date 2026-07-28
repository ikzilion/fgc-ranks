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
import { BLOB_STORAGE_LIMIT_BYTES } from "@/lib/blobStorage";
import { AdminDashboard } from "@/components/AdminDashboard";

export const dynamic = "force-dynamic";

// restorableDeletedPlayers is SUPER_ADMIN-only in the resolver (stricter
// than this page's own ADMIN-or-above gate) and declared non-null
// ([Player!]!) in the schema -- if a plain ADMIN's request included it,
// the resolver's "Not authorized" throw would null-bubble the ENTIRE
// response (GraphQL non-null propagation), wiping out every other tab's
// data too. Built conditionally below so a plain ADMIN's query never
// references that field at all.
function buildAdminDashboardQuery(includeSuperAdminFields: boolean) {
  return `
    query GetAdminDashboardData {
      blobStorageUsageBytes
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
      hiddenGameNames
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
      ${
        includeSuperAdminFields
          ? `restorableDeletedPlayers {
        id
        scrubBackupTag
        deletedAt
        user { id scrubBackupEmail scrubBackupExpiresAt }
      }`
          : ""
      }
    }
  `;
}

const EMPTY_DASHBOARD_DATA = {
  blobStorageUsageBytes: 0,
  pendingEvents: [] as any[],
  games: [] as any[],
  hiddenGameNames: [] as string[],
  pendingTORequests: [] as any[],
  players: [] as any[],
  restorableDeletedPlayers: [] as any[],
};

async function getAdminDashboardData(includeSuperAdminFields: boolean) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  try {
    const res = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: (await cookies()).toString() },
      body: JSON.stringify({ query: buildAdminDashboardQuery(includeSuperAdminFields) }),
      cache: "no-store",
    });
    const json = await res.json();
    if (json.errors) {
      console.error("[admin] GraphQL errors:", json.errors);
      return EMPTY_DASHBOARD_DATA;
    }
    return {
      blobStorageUsageBytes: json.data?.blobStorageUsageBytes ?? 0,
      pendingEvents: json.data?.pendingEvents ?? [],
      games: json.data?.games ?? [],
      hiddenGameNames: json.data?.hiddenGameNames ?? [],
      pendingTORequests: json.data?.pendingTORequests ?? [],
      players: json.data?.players ?? [],
      restorableDeletedPlayers: json.data?.restorableDeletedPlayers ?? [],
    };
  } catch (err) {
    console.error("[admin] Fetch error:", err);
    return EMPTY_DASHBOARD_DATA;
  }
}

export default async function AdminPage() {
  const session = await auth();
  const role = (session?.user as any)?.role;
  if (!isAdminOrAbove(role)) notFound();

  const { blobStorageUsageBytes, pendingEvents, games, hiddenGameNames, pendingTORequests, players, restorableDeletedPlayers } =
    await getAdminDashboardData(isSuperAdmin(role));
  const usageMB = (blobStorageUsageBytes / (1024 * 1024)).toFixed(1);
  const limitMB = Math.round(BLOB_STORAGE_LIMIT_BYTES / (1024 * 1024));

  return (
    <main className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="font-rajdhani text-2xl font-bold text-[var(--text-primary)] mb-1">Admin</h1>
      <p className="text-[12px] text-[var(--text-secondary)] mb-4">All admin tools in one place.</p>

      {/* Display-only, site-wide storage usage — not a tab of its own since
          it's a single stat, not a manager tool; sits above the tabs so
          it's visible regardless of which tab is active. See
          lib/blobStorage.ts for how this total is tracked/updated. */}
      <div className="fgc-card p-4 mb-6 flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-widest text-[var(--text-muted)]">Blob storage used</p>
        <p className="font-rajdhani text-[15px] font-bold text-[var(--text-primary)]">
          {usageMB} MB <span className="text-[var(--text-muted)] font-normal">/ {limitMB} MB</span>
        </p>
      </div>

      <AdminDashboard
        pendingEvents={pendingEvents}
        games={games}
        hiddenGameNames={hiddenGameNames}
        pendingTORequests={pendingTORequests}
        players={players}
        restorableDeletedPlayers={restorableDeletedPlayers}
        showAdminRoles={isSuperAdmin(role)}
      />
    </main>
  );
}
