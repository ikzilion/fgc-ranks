// app/events/page.tsx
// Events browse page — venues/series that tournaments can link to.

import { CreateEventButton } from "@/components/CreateEventButton";
import { EventSearchFilter } from "@/components/EventSearchFilter";

export const dynamic = "force-dynamic";

const GET_EVENTS = `
  query GetEvents {
    events(limit: 100) {
      id
      displayId
      name
      logoUrl
      isOnlineOnly
      address
      twitchUrl
      tournamentCount
      gameCount
    }
  }
`;

async function getEvents() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  try {
    const res = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: GET_EVENTS }),
      cache: "no-store",
    });
    const json = await res.json();
    if (json.errors) {
      console.error("[events] GraphQL errors:", json.errors);
      return [];
    }
    return json.data?.events ?? [];
  } catch (err) {
    console.error("[events] Fetch error:", err);
    return [];
  }
}

export default async function EventsPage() {
  const events = await getEvents();

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-rajdhani text-2xl font-bold text-[var(--text-primary)]">Events</h1>
        <div className="flex items-center gap-4">
          <p className="text-[12px] text-[var(--text-secondary)]">{events.length} events</p>
          <CreateEventButton />
        </div>
      </div>

      <EventSearchFilter events={events} />
    </main>
  );
}
