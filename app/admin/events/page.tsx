// app/admin/events/page.tsx
// Event review queue — ADMIN-only. New Events start PENDING (see
// models/Event.ts) and stay invisible to /events + eventByDisplayId until
// approved here.
//
// This is the first ADMIN-gated SSR read in the codebase. Every other page
// (e.g. events/[id]) only passes a playerId into GraphQL for display-only
// field resolvers like isOrganizer(playerId) — real enforcement lives in
// mutations, which run from the browser and so carry the session cookie
// automatically. A plain server-side fetch() here would NOT carry that
// cookie, so pendingEvents' role check would always see an unauthenticated
// context. We forward the cookie header explicitly so the resolver's
// ADMIN check is real, not just this page's own notFound() gate (per
// CLAUDE.md: gating belongs in both the client component and the resolver).
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { AdminEventReviewCard } from "@/components/AdminEventReviewCard";

export const dynamic = "force-dynamic";

const GET_PENDING_EVENTS = `
  query GetPendingEvents {
    pendingEvents {
      id
      displayId
      name
      isOnlineOnly
      address
      logoUrl
      twitchUrl
      createdAt
      creator {
        id
        tag
      }
    }
  }
`;

async function getPendingEvents() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  try {
    const res = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: (await cookies()).toString() },
      body: JSON.stringify({ query: GET_PENDING_EVENTS }),
      cache: "no-store",
    });
    const json = await res.json();
    if (json.errors) {
      console.error("[admin/events] GraphQL errors:", json.errors);
      return [];
    }
    return json.data?.pendingEvents ?? [];
  } catch (err) {
    console.error("[admin/events] Fetch error:", err);
    return [];
  }
}

export default async function AdminEventsPage() {
  const session = await auth();
  const role = (session?.user as any)?.role;
  if (role !== "ADMIN") notFound();

  const events = await getPendingEvents();

  return (
    <main className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="font-rajdhani text-2xl font-bold text-[var(--text-primary)] mb-1">Event review queue</h1>
      <p className="text-[12px] text-[var(--text-secondary)] mb-6">
        {events.length} pending event{events.length === 1 ? "" : "s"}
      </p>

      {events.length === 0 ? (
        <div className="fgc-card p-6">
          <p className="text-[var(--text-secondary)]">Nothing to review.</p>
        </div>
      ) : (
        events.map((event: any) => <AdminEventReviewCard key={event.id} event={event} />)
      )}
    </main>
  );
}
