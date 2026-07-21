// app/events/[id]/page.tsx
// Event detail page — info header, manage area (creator/managers only),
// own news section, "Coming soon" photo gallery placeholder, and every
// Tournament linked to this Event grouped by game.

import { notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { EditEventDetailsButton } from "@/components/EditEventDetailsButton";
import { ManageEventManagersButton } from "@/components/ManageEventManagersButton";
import { DeleteEventButton } from "@/components/DeleteEventButton";
import { NewsPostForm } from "@/components/NewsPostForm";
import { DeleteNewsPostButton } from "@/components/DeleteNewsPostButton";

export const dynamic = "force-dynamic";

const GET_EVENT = `
  query GetEvent($id: ID!) {
    event(id: $id) {
      id
      displayId
      name
      logoUrl
      isOnlineOnly
      address
      twitchUrl
      status
      rejectionReason
      createdAt
      creator {
        id
        tag
      }
      managers {
        id
        tag
      }
      tournaments {
        id
        name
        game
        status
        entrantCount
        startDate
      }
      newsPosts {
        id
        title
        content
        createdAt
        updatedAt
        author {
          id
          tag
        }
      }
    }
    players(limit: 200) {
      id
      tag
    }
  }
`;

async function getEvent(id: string) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  try {
    const res = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: GET_EVENT, variables: { id } }),
      cache: "no-store",
    });
    const json = await res.json();
    if (json.errors) {
      console.error("[event/id] GraphQL errors:", json.errors);
      return { event: null, players: [] };
    }
    return { event: json.data?.event ?? null, players: json.data?.players ?? [] };
  } catch (err) {
    console.error("[event/id] Fetch error:", err);
    return { event: null, players: [] };
  }
}

// PENDING/REJECTED only surface here (this is the "view your own Event"
// path — the public browse list/eventByDisplayId lookup already hide
// anything that isn't APPROVED, so a random visitor only ever sees this for
// an Event whose raw id they were directly given).
function eventStatusBadge(status: string, rejectionReason?: string | null) {
  if (status === "PENDING")
    return (
      <span
        className="text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded inline-block"
        style={{ background: "var(--gold-dim)", color: "var(--gold)", border: "1px solid rgba(240,180,41,0.25)" }}
      >
        ⏳ Pending review
      </span>
    );
  if (status === "REJECTED")
    return (
      <span
        className="text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded inline-block"
        style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.25)" }}
      >
        Rejected: {rejectionReason || "No reason given"}
      </span>
    );
  return null;
}

function statusBadge(status: string) {
  if (status === "LIVE")
    return (
      <span className="badge-live text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded flex items-center gap-1 flex-shrink-0">
        <span className="live-dot" /> Live
      </span>
    );
  if (status === "UPCOMING")
    return <span className="badge-upcoming text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded flex-shrink-0">Upcoming</span>;
  if (status === "CANCELLED")
    return (
      <span
        className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded flex-shrink-0"
        style={{ background: "var(--coral-dim)", color: "var(--coral)" }}
      >
        Cancelled
      </span>
    );
  return <span className="badge-ended text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded flex-shrink-0">Ended</span>;
}

export default async function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  const playerId = (session?.user as any)?.playerId ?? undefined;
  const role = (session?.user as any)?.role;
  const { event, players } = await getEvent(id);
  if (!event) notFound();

  const canManage = role === "ADMIN" || event.managers.some((m: any) => m.id === playerId);

  // Group linked tournaments by game so different-game series sharing this
  // Event (e.g. a multi-game venue) are browsable rather than one flat list.
  const tournamentsByGame: Record<string, any[]> = {};
  for (const t of event.tournaments) {
    if (!tournamentsByGame[t.game]) tournamentsByGame[t.game] = [];
    tournamentsByGame[t.game].push(t);
  }

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <div className="fgc-card p-6 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div className="flex items-start gap-4">
            {event.logoUrl && (
              <img
                src={event.logoUrl}
                alt={`${event.name} logo`}
                className="w-14 h-14 rounded-lg object-cover flex-shrink-0"
                style={{ border: "1px solid var(--border-strong)" }}
              />
            )}
            <div>
              <h1 className="font-rajdhani text-3xl font-bold text-[var(--text-primary)] leading-tight">{event.name}</h1>
              <p className="text-[11px] font-mono text-[var(--text-muted)] mt-1">{event.displayId}</p>
              {eventStatusBadge(event.status, event.rejectionReason) && (
                <div className="mt-2">{eventStatusBadge(event.status, event.rejectionReason)}</div>
              )}
              <p className="text-[13px] text-[var(--text-secondary)] mt-1">
                {event.isOnlineOnly ? "🌐 Online only" : event.address || "Location not set"}
              </p>
              {event.twitchUrl && (
                <a
                  href={event.twitchUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[13px] mt-1 inline-block hover:underline"
                  style={{ color: "var(--blue)" }}
                >
                  📺 Watch on Twitch
                </a>
              )}
            </div>
          </div>
        </div>

        {canManage && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <EditEventDetailsButton
              eventId={event.id}
              name={event.name}
              logoUrl={event.logoUrl}
              isOnlineOnly={event.isOnlineOnly}
              address={event.address}
              twitchUrl={event.twitchUrl}
              canManage={canManage}
            />
            <ManageEventManagersButton
              eventId={event.id}
              managers={event.managers}
              allPlayers={players}
              canManage={canManage}
            />
            <DeleteEventButton eventId={event.id} canManage={canManage} />
          </div>
        )}
      </div>

      {/* News */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">News</p>
          <NewsPostForm eventId={event.id} canManage={canManage} />
        </div>
        {event.newsPosts.length === 0 ? (
          <div className="fgc-card p-6">
            <p className="text-[var(--text-secondary)]">No news yet.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {event.newsPosts.map((post: any) => (
              <article key={post.id} className="fgc-card p-5">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <h2 className="font-rajdhani text-lg font-bold text-[var(--text-primary)] leading-tight">{post.title}</h2>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <NewsPostForm post={post} eventId={event.id} canManage={canManage} />
                    <DeleteNewsPostButton postId={post.id} canManage={canManage} />
                  </div>
                </div>
                <p className="text-[13px] text-[var(--text-secondary)] whitespace-pre-wrap mb-3">{post.content}</p>
                <p className="text-[11px] text-[var(--text-muted)]">
                  {post.author?.tag ?? "Unknown"} · {new Date(post.createdAt).toLocaleDateString()}
                  {post.updatedAt !== post.createdAt && " (edited)"}
                </p>
              </article>
            ))}
          </div>
        )}
      </div>

      {/* Photo gallery — placeholder only, per settled design */}
      <div className="mb-6">
        <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">Photo gallery</p>
        <div className="fgc-card p-6 text-center">
          <p className="text-[var(--text-secondary)]">📷 Coming soon</p>
        </div>
      </div>

      {/* Linked tournaments, grouped by game */}
      <div className="mb-6">
        <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">Tournaments</p>
        {event.tournaments.length === 0 ? (
          <div className="fgc-card p-6">
            <p className="text-[var(--text-secondary)]">No tournaments linked to this event yet.</p>
          </div>
        ) : (
          Object.entries(tournamentsByGame).map(([game, tournaments]) => (
            <div key={game} className="mb-4">
              <p className="text-[11px] uppercase tracking-wider text-[var(--text-muted)] mb-2 px-1">{game}</p>
              <div className="fgc-card">
                {tournaments.map((t: any) => (
                  <Link
                    key={t.id}
                    href={`/tournaments/${t.id}`}
                    className="flex items-center justify-between gap-2 px-4 py-3 border-b border-[var(--border)] last:border-0 hover:bg-[var(--navy-3)] transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="font-rajdhani text-[15px] font-bold text-[var(--text-primary)] truncate leading-tight">{t.name}</p>
                      <p className="text-[12px] text-[var(--text-secondary)] truncate">
                        {t.entrantCount} entrants · {new Date(t.startDate).toLocaleDateString()}
                      </p>
                    </div>
                    {statusBadge(t.status)}
                  </Link>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <Link href="/events" className="text-[13px] text-[var(--text-secondary)] hover:text-[var(--blue)]">
        ← Back to events
      </Link>
    </main>
  );
}
