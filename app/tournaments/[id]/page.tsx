// app/tournaments/[id]/page.tsx
// Tournament detail page — shows bracket matches and entrant list.

import { Suspense } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import nextDynamic from "next/dynamic";
import { auth } from "@/lib/auth";
import { isAdminOrAbove } from "@/lib/roles";
import { JoinTournamentButton } from "@/components/JoinTournamentButton";
import { TournamentStatusButton } from "@/components/TournamentStatusButton";
import { RemoveEntrantButton } from "@/components/RemoveEntrantButton";
import { SetPlacementButton } from "@/components/SetPlacementButton";
import { CheckInToggleButton } from "@/components/CheckInToggleButton";
import { SelfCheckInButton } from "@/components/SelfCheckInButton";
import { TournamentManageTabs } from "@/components/TournamentManageTabs";
import { TournamentBracketSection } from "@/components/TournamentBracketSection";
import { TournamentCsvExport } from "@/components/TournamentCsvExport";
import { TournamentLoadingState } from "@/components/TournamentLoadingState";

// Code-split from the main page bundle (next/dynamic, aliased since this
// file already has its own `export const dynamic` route-segment config
// below) -- TabletModeButton pulls in html5-qrcode (lib/useQrScanner.ts)
// for its camera scanner, which every visitor to this page was downloading
// before this change even though Tablet/Phone Mode is canManage-gated
// (TOs/admins only) and most visitors are public/regular-player viewers
// who will never open it (performance audit, July 29, 2026).
const TabletModeButton = nextDynamic(() => import("@/components/TabletModeButton").then(m => m.TabletModeButton));

export const dynamic = "force-dynamic";

// Shared Match field selection — reused for the standard bracket, every
// pool's own bracket, and the pool-format main bracket, since BracketView
// needs the exact same shape in all three cases. This codebase doesn't use
// GraphQL fragments (no Apollo Client), so it's just a repeated string.
const MATCH_FIELDS = `
  id
  round
  status
  bracketSide
  bracketRound
  bracketPosition
  player1Score
  player2Score
  isForfeit
  player1 { id tag }
  player2 { id tag }
  winner { id tag }
  nextMatch { id }
  nextLoserMatch { id }
  canUndo
`;

// Fast/lightweight query for everything the page HEADER needs (name,
// status, join/manage buttons, Streamer/Tablet Mode entry points) plus
// pools { id } for the loading-state pool count -- deliberately excludes
// entrants (full list + player), bracket/pools' own matches, and mainBracket,
// which is what made the full query slow on a large Pools + Bracket
// tournament even after the N+1 fixes (see the Aug 1, 2026 perf-fix
// entries). The header renders immediately from this; the slow/full query
// below runs behind a Suspense boundary so the rest of the page can stream
// in once it resolves, with real numbers in the fallback instead of a
// generic spinner (loading-state work, Aug 1, 2026).
const GET_TOURNAMENT_SUMMARY = `
  query GetTournamentSummary($id: ID!, $playerId: ID) {
    tournament(id: $id) {
      id
      name
      game
      status
      cancellationReason
      visibility
      entrantCount
      startDate
      isEntered(playerId: $playerId)
      isOrganizer(playerId: $playerId)
      isInvited(playerId: $playerId)
      myEntrant(playerId: $playerId) {
        id
        checkedInAt
      }
      logoUrl
      isOnlineOnly
      address
      twitchUrl
      format
      capacity
      entryFee
      prizePot
      event {
        id
        name
      }
      pools {
        id
      }
    }
  }
`;

const GET_TOURNAMENT = `
  query GetTournament($id: ID!, $playerId: ID) {
    tournament(id: $id) {
      id
      name
      game
      status
      cancellationReason
      visibility
      isRestricted
      entrantCount
      startDate
      endDate
      isEntered(playerId: $playerId)
      isOrganizer(playerId: $playerId)
      isInvited(playerId: $playerId)
      streamBackgroundUrl
      sponsorBannerUrl
      sponsorBannerUrls { url linkUrl }
      sponsorBannerIntervalSeconds
      bracketLineColor
      bracketBoxColor
      bracketFontColor
      logoUrl
      isOnlineOnly
      address
      twitchUrl
      format
      capacity
      entryFee
      prizePot
      event {
        id
        displayId
        name
        logoUrl
      }
      organizers {
        id
        tag
      }
      invitedPlayers {
        id
        tag
      }
      entrants {
        id
        seed
        placement
        checkedInAt
        pointsEarned
        player {
          id
          tag
          avatarUrl
          characters
        }
      }
      bracket {
        id
        seedingMethod
        size
        matches { ${MATCH_FIELDS} }
      }
      allPoolsComplete
      suggestedPoolCount
      poolModel
      modelBCurrentRoundComplete
      pools {
        id
        poolNumber
        roundNumber
        isFinalsCutoff
        entrants {
          id
          player { id tag avatarUrl }
        }
        bracket {
          id
          seedingMethod
          size
          matches { ${MATCH_FIELDS} }
        }
        matches { ${MATCH_FIELDS} }
        standings {
          rank
          matchWins
          matchLosses
          gamesWon
          gamesLost
          entrant {
            id
            player { id tag avatarUrl }
          }
        }
      }
      mainBracket {
        id
        seedingMethod
        size
        seedOrder { id }
        matches { ${MATCH_FIELDS} }
      }
    }
    players(limit: 200) {
      id
      tag
    }
  }
`;

async function graphqlFetch(query: string, variables: Record<string, unknown>) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const res = await fetch(`${baseUrl}/api/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });
  return res.json();
}

async function getTournamentSummary(id: string, playerId?: string) {
  try {
    const json = await graphqlFetch(GET_TOURNAMENT_SUMMARY, { id, playerId });
    if (json.errors) {
      console.error("[tournament/id] Summary GraphQL errors:", json.errors);
      return null;
    }
    return json.data?.tournament ?? null;
  } catch (err) {
    console.error("[tournament/id] Summary fetch error:", err);
    return null;
  }
}

async function getTournament(id: string, playerId?: string) {
  try {
    const json = await graphqlFetch(GET_TOURNAMENT, { id, playerId });
    if (json.errors) {
      console.error("[tournament/id] GraphQL errors:", json.errors);
      return { tournament: null, players: [] };
    }
    return { tournament: json.data?.tournament ?? null, players: json.data?.players ?? [] };
  } catch (err) {
    console.error("[tournament/id] Fetch error:", err);
    return { tournament: null, players: [] };
  }
}

function statusBadge(status: string) {
  if (status === "LIVE")
    return (
      <span className="badge-live text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded flex items-center gap-1">
        <span className="live-dot" /> Live
      </span>
    );
  if (status === "UPCOMING")
    return <span className="badge-upcoming text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded">Upcoming</span>;
  if (status === "CANCELLED")
    return (
      <span
        className="text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded"
        style={{ background: "var(--coral-dim)", color: "var(--coral)" }}
      >
        Cancelled
      </span>
    );
  return <span className="badge-ended text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded">Ended</span>;
}

// The slow part -- runs the full detail query (pools, bracket, mainBracket,
// entrants+player) and renders everything below the header. Wrapped in a
// <Suspense> boundary by the page component below, so Next.js can stream
// the header (already sent to the browser) and swap this in once it
// resolves, instead of blocking the whole page on it (loading-state work,
// Aug 1, 2026).
async function TournamentBody({
  tournamentId,
  playerId,
  canManage,
}: {
  tournamentId: string;
  playerId?: string;
  canManage: boolean;
}) {
  const { tournament, players } = await getTournament(tournamentId, playerId);
  if (!tournament) {
    return (
      <div className="max-w-5xl mx-auto mb-6">
        <p className="text-[13px] text-[var(--text-secondary)]">This tournament is no longer available.</p>
      </div>
    );
  }

  // Pool play + top-cut bracket format — the standard-format branch below is
  // completely untouched; this only adds a second, separate rendering path.
  const isPoolsFormat = tournament.format === "Pools + Bracket";
  const hasPoolsOrMainBracket = tournament.pools.length > 0 || !!tournament.mainBracket;
  const showBracketSection = isPoolsFormat ? hasPoolsOrMainBracket || canManage : tournament.bracket || canManage;

  // CSV export (ENDED tournaments only, see TournamentCsvExport) -- grouped
  // by bracket so pool-stage matches (real historical data, included
  // deliberately) can be told apart from the main/standard bracket despite
  // sharing the same generic round-label convention ("Winners Round 1",
  // etc. -- see lib/bracket.ts, which has no pool-aware naming). label: ""
  // for the one main/standard bracket a tournament ever has; "Pool N" for
  // each pool, covering both pool sub-formats (Model A round-robin matches
  // live on pool.matches, Model B/C double-elim ones on pool.bracket.matches).
  const csvMatchGroups = isPoolsFormat
    ? [
        ...tournament.pools.map((p: any) => ({
          label: `Pool ${p.poolNumber}`,
          matches: [...p.matches, ...(p.bracket?.matches ?? [])],
        })),
        ...(tournament.mainBracket ? [{ label: "", matches: tournament.mainBracket.matches }] : []),
      ]
    : [{ label: "", matches: tournament.bracket?.matches ?? [] }];

  // Defined once, used in two spots below: as the left sidebar next to the
  // Bracket section when one is shown, or standalone (full width, not a
  // cramped sidebar with nothing beside it) when it isn't.
  const entrantsSidebar = (
    <>
      <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">Entrants</p>
      <div className="fgc-card">
        {tournament.entrants.length === 0 ? (
          <p className="p-4 text-[var(--text-secondary)] text-[13px]">No entrants yet.</p>
        ) : (
          [...tournament.entrants]
            .sort((a: any, b: any) => (a.seed ?? 999) - (b.seed ?? 999))
            .map((entrant: any) => (
              // Two-line layout when canManage — photo+name alone on one
              // line (full width to breathe, same as the public/non-managing
              // row below) with the action buttons (Set placement, Remove)
              // on their own row underneath, instead of squeezing all of it
              // onto one line where a long player tag got cut off. A public/
              // non-managing viewer never sees the action row at all, so
              // their row stays exactly the single-line layout it always was.
              <div
                key={entrant.id}
                className="flex flex-col gap-2 px-4 py-2.5 border-b border-[var(--border)] last:border-0 hover:bg-[var(--navy-3)] transition-colors"
              >
                <Link href={`/players/${entrant.player.id}`} className="flex items-center gap-3 min-w-0">
                  <span className="text-[11px] text-[var(--text-muted)] w-5 flex-shrink-0">{entrant.seed ?? "—"}</span>
                  <div
                    className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 font-rajdhani text-[10px] font-bold overflow-hidden"
                    style={{ background: "var(--blue-dim)", color: "var(--blue)", border: "1px solid rgba(79,142,247,0.3)" }}
                  >
                    {entrant.player.avatarUrl ? (
                      <img src={entrant.player.avatarUrl} alt={entrant.player.tag} className="w-full h-full object-cover" />
                    ) : (
                      entrant.player.tag.slice(0, 2).toUpperCase()
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-rajdhani text-[13px] font-semibold text-[var(--text-primary)] truncate">{entrant.player.tag}</p>
                    {entrant.placement && (
                      <p className="text-[11px]" style={{ color: entrant.placement === 1 ? "var(--gold)" : "var(--text-muted)" }}>
                        {entrant.placement === 1 ? "🏆 Champion" : `${entrant.placement}th place`}
                      </p>
                    )}
                    {/* Visible to everyone, not just canManage — a spectator
                        or the entrant themselves benefits from seeing this
                        too, not only the TO. The actionable toggle below
                        (canManage-only) is separate from this passive
                        status line. */}
                    {entrant.checkedInAt && (
                      <p className="text-[11px]" style={{ color: "var(--green)" }}>✓ Checked in</p>
                    )}
                  </div>
                </Link>
                {canManage && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <CheckInToggleButton
                      tournamentId={tournament.id}
                      playerId={entrant.player.id}
                      checkedInAt={entrant.checkedInAt}
                      canManage={canManage}
                      status={tournament.status}
                    />
                    <SetPlacementButton entrantId={entrant.id} placement={entrant.placement} canManage={canManage} />
                    <RemoveEntrantButton entrantId={entrant.id} playerTag={entrant.player.tag} canManage={canManage} status={tournament.status} />
                  </div>
                )}
              </div>
            ))
        )}
      </div>
    </>
  );

  // Tabbed reorganization (settled July 28, 2026, see
  // components/TournamentManageTabs.tsx) — this is exactly what rendered in
  // this position on the page before that feature existed, now extracted so
  // it can be passed through as the "Overview" tab's content for a
  // canManage viewer, or rendered directly (unwrapped, unchanged) for
  // everyone else.
  const overviewContent = showBracketSection ? (
    // Player-search state (query + highlightedPlayerIds) is lifted into this
    // client component since TournamentBody itself is an async Server
    // Component and can't hold useState -- see TournamentBracketSection.tsx.
    <TournamentBracketSection tournament={tournament} canManage={canManage} isPoolsFormat={isPoolsFormat} />
  ) : (
    // No bracket section to sit beside (spectator view, bracket not
    // generated yet) — Entrants renders on its own at the standard
    // content width instead of being a lone sidebar with nothing next to it.
    <div className="max-w-5xl mx-auto mb-6">{entrantsSidebar}</div>
  );

  return (
    <>
      {/* CSV export -- moved here (from the header) since it needs the full
          match/entrant data this slow query fetches; only relevant once
          ENDED anyway, so appearing a moment after the rest of this section
          streams in isn't a real loss (loading-state work, Aug 1, 2026). */}
      {tournament.status === "ENDED" && (
        <div className="max-w-5xl mx-auto mb-4 flex justify-end">
          <TournamentCsvExport
            tournamentName={tournament.name}
            entrants={tournament.entrants}
            matchGroups={csvMatchGroups}
          />
        </div>
      )}

      {/* Tabbed reorganization (settled July 28, 2026) — TournamentManageTabs
          only ever renders for canManage; everyone else gets overviewContent
          directly, unwrapped, so a public/non-managing viewer's rendered
          page is completely unchanged (same DOM, same position, same
          max-w-[1800px]-or-max-w-5xl container overviewContent already
          brings with it — see where it's built above). */}
      {canManage ? (
        <TournamentManageTabs
          tournamentId={tournament.id}
          status={tournament.status}
          logoUrl={tournament.logoUrl}
          isOnlineOnly={tournament.isOnlineOnly}
          address={tournament.address}
          twitchUrl={tournament.twitchUrl}
          format={tournament.format}
          capacity={tournament.capacity}
          entryFee={tournament.entryFee}
          prizePot={tournament.prizePot}
          event={tournament.event}
          organizers={tournament.organizers}
          visibility={tournament.visibility}
          invitedPlayers={tournament.invitedPlayers}
          entrants={tournament.entrants}
          allPlayers={players}
          isRestricted={tournament.isRestricted}
          streamBackgroundUrl={tournament.streamBackgroundUrl}
          sponsorBannerUrl={tournament.sponsorBannerUrl}
          sponsorBannerUrls={tournament.sponsorBannerUrls}
          sponsorBannerIntervalSeconds={tournament.sponsorBannerIntervalSeconds}
          bracketLineColor={tournament.bracketLineColor}
          bracketBoxColor={tournament.bracketBoxColor}
          bracketFontColor={tournament.bracketFontColor}
        >
          {overviewContent}
        </TournamentManageTabs>
      ) : (
        overviewContent
      )}
    </>
  );
}

export default async function TournamentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  const playerId = (session?.user as any)?.playerId ?? undefined;
  const role = (session?.user as any)?.role;
  const tournament = await getTournamentSummary(id, playerId);
  if (!tournament) notFound();

  const canManage = tournament.isOrganizer || isAdminOrAbove(role);
  const isPoolsFormat = tournament.format === "Pools + Bracket";
  const poolCount = tournament.pools.length;

  return (
    <main className="mx-auto px-4 py-8">
      {/* Header — kept at the site's standard content width. Only the
          bracket section below gets a wider wrapper, since it's the one
          part of this page with inherently wide, horizontally-scrollable
          content (see the bracket wrapper comment further down). */}
      <div className="max-w-5xl mx-auto">
        <div className="flex flex-col sm:flex-row gap-4 mb-6 items-stretch">
          <div className="fgc-card p-6 flex-1">
            {/* flex-wrap is load-bearing here (not just sm:flex-row): once
                canManage adds a third fixed-width card (Tablet/Phone Mode)
                next to this one in the row above, this card's own width can
                shrink well below what the name block + action buttons need
                side by side at viewports roughly 640-880px wide (small
                tablets, phones in landscape -- exactly this feature's
                target devices). Without wrap, the action buttons don't
                overflow the PAGE (so it's easy to miss in a quick check) --
                they get silently clipped by .fgc-card's overflow:hidden
                instead, since that's a nearer ancestor. flex-wrap lets the
                button row drop below the name block instead of being cut
                off. Confirmed via headless DOM measurement across
                375-1024px, not just visually. */}
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 flex-wrap">
              <div className="flex items-start gap-4">
                {tournament.logoUrl && (
                  <img
                    src={tournament.logoUrl}
                    alt={`${tournament.name} logo`}
                    className="w-14 h-14 rounded-lg object-cover flex-shrink-0"
                    style={{ border: "1px solid var(--border-strong)" }}
                  />
                )}
                <div>
                  <h1 className="font-rajdhani text-3xl font-bold text-[var(--text-primary)] leading-tight">
                    {tournament.name}
                    {tournament.visibility === "PRIVATE" && (
                      <span className="ml-2 text-[13px] align-middle" style={{ color: "var(--text-muted)" }}>🔒 Private</span>
                    )}
                  </h1>
                  <p className="text-[13px] text-[var(--text-secondary)] mt-1">
                    {tournament.game} · {tournament.entrantCount}{tournament.capacity ? `/${tournament.capacity}` : ""} entrants · {new Date(tournament.startDate).toLocaleDateString()}
                  </p>
                  {/* Format/location — display-only, only rendered when at
                      least one is actually set, so existing tournaments with
                      none of this filled in show nothing extra here. */}
                  {(tournament.format || tournament.isOnlineOnly || tournament.address) && (
                    <p className="text-[13px] text-[var(--text-secondary)] mt-1">
                      {tournament.format}
                      {tournament.format && (tournament.isOnlineOnly || tournament.address) && " · "}
                      {tournament.isOnlineOnly ? "🌐 Online Only" : tournament.address}
                    </p>
                  )}
                  {(tournament.entryFee || tournament.prizePot) && (
                    <p className="text-[13px] mt-1" style={{ color: "var(--gold)" }}>
                      {tournament.entryFee && `${tournament.entryFee} entry`}
                      {tournament.entryFee && tournament.prizePot && " · "}
                      {tournament.prizePot && `${tournament.prizePot} prize pot`}
                    </p>
                  )}
                  {tournament.twitchUrl && (
                    <a
                      href={tournament.twitchUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[13px] mt-1 inline-block hover:underline"
                      style={{ color: "var(--blue)" }}
                    >
                      📺 Watch on Twitch
                    </a>
                  )}
                  {tournament.event && (
                    <Link
                      href={`/events/${tournament.event.id}`}
                      className="text-[13px] mt-1 block hover:underline"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      Part of {tournament.event.name}
                    </Link>
                  )}
                  {tournament.status === "CANCELLED" && tournament.cancellationReason && (
                    <p className="text-[13px] mt-1" style={{ color: "var(--coral)" }}>
                      Cancelled: {tournament.cancellationReason}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                {statusBadge(tournament.status)}
                <TournamentStatusButton tournamentId={tournament.id} status={tournament.status} canManage={canManage} />
                {/* Post-tournament results screen — distinct from the
                    in-progress Top 24/Top 8 filtered bracket-view tabs
                    (those apply DURING a Model A/C main bracket while it's
                    still narrowing). Only shown once the tournament has
                    actually ended, since that's when real final placements
                    exist to show. */}
                {tournament.status === "ENDED" && (
                  <Link
                    href={`/tournaments/${tournament.id}/results`}
                    className="text-[11px] font-semibold px-3 py-1.5 rounded"
                    style={{ background: "var(--gold-dim)", color: "var(--gold)", border: "1px solid rgba(240,180,41,0.25)" }}
                  >
                    🏆 Top 8 Results
                  </Link>
                )}
                <JoinTournamentButton
                  tournamentId={tournament.id}
                  isEntered={tournament.isEntered}
                  entrantId={tournament.myEntrant?.id}
                  status={tournament.status}
                  visibility={tournament.visibility}
                  isInvited={tournament.isInvited}
                />
                {/* Self check-in — only once actually entered (myEntrant
                    exists); TO/admin check-in on someone else's behalf is a
                    separate control down in the entrant list
                    (CheckInToggleButton) and Tablet/Phone Mode's QR-scan
                    "Check in" mode, both reusing the same mutation. */}
                {tournament.isEntered && tournament.myEntrant && (
                  <SelfCheckInButton
                    tournamentId={tournament.id}
                    playerId={playerId!}
                    checkedInAt={tournament.myEntrant.checkedInAt}
                    status={tournament.status}
                  />
                )}
              </div>
            </div>
          </div>

          {/* Streamer Mode — pulled out of the header button row into its own
              bigger, standalone box (user request, July 19, 2026) instead of
              blending in with the smaller Manage/Join/Status buttons. Still
              deliberately NOT gated behind canManage — it's just navigation
              to an already-public page, not a management action, so anyone
              (including signed-out visitors) should be able to jump to it. */}
          <Link
            href={`/tournaments/${tournament.id}/stream`}
            target="_blank"
            rel="noopener noreferrer"
            className="fgc-card p-6 sm:w-56 flex-shrink-0 flex flex-col items-center justify-center gap-2 text-center hover:bg-[var(--navy-3)] transition-colors"
          >
            <span className="text-4xl">📺</span>
            <span className="font-rajdhani text-lg font-bold text-[var(--text-primary)]">Streamer Mode</span>
            <span className="text-[11px] text-[var(--text-secondary)]">Open the OBS broadcast view</span>
          </Link>

          {/* Tablet/Phone Mode — same big-card treatment as Streamer Mode
              right above, for matching visual prominence. Organizer/admin
              only (unlike Streamer Mode's public broadcast view, this is a
              real management surface — match reporting + adding entrants). */}
          {canManage && (
            <TabletModeButton tournamentId={tournament.id} canManage={canManage} />
          )}
        </div>
      </div>

      {/* Bracket/pools/entrants section -- runs the slow full query behind
          this Suspense boundary, so the header above (already rendered from
          the fast summary query) can stream to the browser immediately
          instead of waiting on it. Fallback shows real pool/entrant counts
          from the summary data, not a generic spinner (loading-state work,
          Aug 1, 2026). */}
      <Suspense
        fallback={
          <TournamentLoadingState
            entrantCount={tournament.entrantCount}
            poolCount={poolCount}
            isPoolsFormat={isPoolsFormat}
          />
        }
      >
        <TournamentBody tournamentId={id} playerId={playerId} canManage={canManage} />
      </Suspense>

      <div className="max-w-5xl mx-auto">
        {/* Back link */}
        <div className="mt-6">
          <Link href="/tournaments" className="text-[13px] text-[var(--text-secondary)] hover:text-[var(--blue)]">
            ← Back to tournaments
          </Link>
        </div>
      </div>
    </main>
  );
}
