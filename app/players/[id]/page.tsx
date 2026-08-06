// app/players/[id]/page.tsx
// Individual player profile — stats, characters, and tournament history.

import { notFound } from "next/navigation";
import Link from "next/link";
import { cookies } from "next/headers";
import { QRCodeSVG } from "qrcode.react";
import { auth } from "@/lib/auth";
import { isAdminOrAbove } from "@/lib/roles";
import { EditProfileButton } from "@/components/EditProfileButton";
import { ChangePasswordButton } from "@/components/ChangePasswordButton";
import { DeletePlayerButton } from "@/components/DeletePlayerButton";
import { DeleteAccountButton } from "@/components/DeleteAccountButton";
import { HeadToHeadSection } from "@/components/HeadToHeadSection";
import { ZoomableAvatar } from "@/components/ZoomableAvatar";
import { RequestTOButton } from "@/components/RequestTOButton";
import { SocialLinks } from "@/components/SocialLinks";
import { AdSlot } from "@/components/AdSlot";

export const dynamic = "force-dynamic";

const GET_PLAYER = `
  query GetPlayer($id: ID!) {
    player(id: $id) {
      id
      tag
      displayId
      region
      team
      avatarUrl
      twitchUrl
      twitterUrl
      instagramUrl
      youtubeUrl
      discordUrl
      tiktokUrl
      otherLinkUrl
      otherLinkLabel
      isLiveOnTwitch
      characters
      wins
      losses
      points
      gameRankings {
        game
        points
        rank
      }
      winRate
      isDeleted
      tournaments {
        id
        placement
        seed
        tournament {
          id
          name
          game
          status
          startDate
          entrantCount
        }
      }
    }
  }
`;

// Fetches the auto-shown "vs the logged-in viewer" head-to-head record.
// Kept as a separate query rather than a second aliased field on GET_PLAYER
// because opponentId: ID! is non-null — a homepage Phase 2 bug already
// proved that @include(if:) doesn't stop GraphQL's parse-time argument
// validation from rejecting a nullable-typed variable in that position, so
// this only ever gets called when viewerId is known to be a real id.
const GET_VIEWER_HEAD_TO_HEAD = `
  query GetViewerHeadToHead($id: ID!, $opponentId: ID!) {
    player(id: $id) {
      headToHead(opponentId: $opponentId) {
        wins
        losses
        opponent { id tag avatarUrl }
      }
    }
  }
`;

// Lightweight roster for the opponent picker — just enough to search/display
// by tag, not the full leaderboard shape PlayerSearchFilter needs.
const GET_PLAYERS_FOR_PICKER = `
  query GetPlayersForPicker {
    players(limit: 200) {
      id
      tag
      avatarUrl
    }
  }
`;

// TO permission overhaul — only ever needed/fetched when viewing your OWN
// profile (see getPlayerPageData); `myTORequest` resolves off the session's
// own playerId regardless of which profile `id` is being viewed, so there's
// no point fetching it for anyone else's page.
const GET_MY_TO_REQUEST = `
  query GetMyTORequest {
    myTORequest {
      status
      resolvedAt
    }
  }
`;

async function getPlayerPageData(id: string, viewerId?: string) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL;
  const isOwnProfile = viewerId === id;
  const [playerJson, viewerH2hJson, playersJson, myTORequestJson] = await Promise.all([
    // Cookie forwarding is load-bearing now, not just a nice-to-have: since
    // Player.displayId is gated server-side on the requesting viewer
    // (owner/Admin/TO — see that resolver), a plain fetch() without the
    // session cookie makes the GraphQL context see no session at all, so
    // the resolver treats EVERY caller as anonymous and always nulls
    // displayId out, regardless of who's actually logged in (this was the
    // f2eb432 regression — the JSX condition and the resolver gate were
    // both correct in isolation, but this fetch never carried the session
    // that either one needed). cache: "no-store" replaces the old
    // next:{revalidate:60} for the same reason GET_VIEWER_HEAD_TO_HEAD and
    // GET_MY_TO_REQUEST below already use no-store: the response is now
    // viewer-dependent, so caching it by URL+body alone would leak one
    // viewer's permission-gated result to a different viewer for up to 60s.
    fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: (await cookies()).toString() },
      body: JSON.stringify({ query: GET_PLAYER, variables: { id } }),
      cache: "no-store",
    }).then(r => r.json()),
    viewerId && viewerId !== id
      ? fetch(`${baseUrl}/api/graphql`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: GET_VIEWER_HEAD_TO_HEAD, variables: { id, opponentId: viewerId } }),
          cache: "no-store",
        }).then(r => r.json())
      : Promise.resolve(null),
    fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: GET_PLAYERS_FOR_PICKER }),
      next: { revalidate: 60 },
    }).then(r => r.json()),
    // A plain server-side fetch() doesn't carry the session cookie on its
    // own (same reason app/admin/events forwards it explicitly) — needed
    // here since myTORequest resolves off context.playerId from the
    // session, not an argument. Only fetched for your own profile at all.
    isOwnProfile
      ? fetch(`${baseUrl}/api/graphql`, {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie: (await cookies()).toString() },
          body: JSON.stringify({ query: GET_MY_TO_REQUEST }),
          cache: "no-store",
        }).then(r => r.json())
      : Promise.resolve(null),
  ]);

  return {
    player: playerJson.data?.player ?? null,
    viewerHeadToHead: viewerH2hJson?.data?.player?.headToHead ?? null,
    players: playersJson.data?.players ?? [],
    myTORequest: myTORequestJson?.data?.myTORequest ?? null,
  };
}

function placementStyle(placement: number) {
  if (placement === 1) return { background: "var(--gold-dim)", color: "var(--gold)", border: "1px solid rgba(240,180,41,0.2)" };
  if (placement === 2) return { background: "rgba(192,200,216,0.1)", color: "#C0C8D8", border: "1px solid rgba(192,200,216,0.2)" };
  if (placement === 3) return { background: "rgba(205,127,50,0.1)", color: "#CD7F32", border: "1px solid rgba(205,127,50,0.2)" };
  return { background: "var(--navy-4)", color: "var(--text-muted)", border: "1px solid var(--border)" };
}

export default async function PlayerProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  const viewerId = (session?.user as any)?.playerId ?? undefined;
  const viewerRole = (session?.user as any)?.role;
  const { player, viewerHeadToHead, players, myTORequest } = await getPlayerPageData(id, viewerId);
  if (!player) notFound();

  const totalGames = player.wins + player.losses;
  // Picker shouldn't offer comparing a player against themselves.
  const pickablePlayers = players.filter((p: any) => p.id !== player.id);

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="fgc-card p-6 mb-4 flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-5">
        <ZoomableAvatar avatarUrl={player.avatarUrl} tag={player.tag} sizeClassName="w-16 h-16" textClassName="text-2xl" />
        {/* min-w-0 + flex-wrap: same overflow:hidden-clipping risk as the
            tournament header (see the comment there) — this row can hold up
            to 5 action buttons next to a potentially-long tag, with no
            wrapping fallback otherwise. */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h1 className="font-rajdhani text-3xl font-bold text-[var(--text-primary)] leading-tight">{player.tag}</h1>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Deleted accounts can never log back in (their email is
                  scrubbed), so EditProfileButton's own isOwnProfile check
                  would already hide it here — this is an explicit,
                  belt-and-suspenders guard for "no editable fields". */}
              {!player.isDeleted && (
                <>
                  {viewerId === player.id && (
                    <RequestTOButton isTO={!!(session?.user as any)?.isTO} myRequest={myTORequest} />
                  )}
                  <EditProfileButton
                    playerId={player.id}
                    currentTag={player.tag}
                    currentRegion={player.region}
                    currentCharacters={player.characters}
                    currentAvatarUrl={player.avatarUrl}
                    currentTeam={player.team}
                    currentTwitchUrl={player.twitchUrl}
                    currentTwitterUrl={player.twitterUrl}
                    currentInstagramUrl={player.instagramUrl}
                    currentYoutubeUrl={player.youtubeUrl}
                    currentDiscordUrl={player.discordUrl}
                    currentTiktokUrl={player.tiktokUrl}
                    currentOtherLinkUrl={player.otherLinkUrl}
                    currentOtherLinkLabel={player.otherLinkLabel}
                  />
                  <ChangePasswordButton playerId={player.id} />
                  <DeleteAccountButton playerId={player.id} />
                </>
              )}
              <DeletePlayerButton
                playerId={player.id}
                playerTag={player.tag}
                isAdmin={isAdminOrAbove(viewerRole)}
                isDeleted={player.isDeleted}
                isSelf={viewerId === player.id}
              />
            </div>
          </div>
          {player.isDeleted && (
            <span
              className="text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded inline-block mt-2"
              style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.25)" }}
            >
              Deleted account
            </span>
          )}
          {player.team && (
            <p className="text-[13px] font-semibold mt-0.5" style={{ color: "var(--blue)" }}>{player.team}</p>
          )}
          {player.twitchUrl && (
            <p className="mt-1 flex items-center gap-2">
              <a
                href={player.twitchUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[13px] inline-block hover:underline"
                style={{ color: "var(--blue)" }}
              >
                📺 Watch on Twitch
              </a>
              {player.isLiveOnTwitch && (
                <span
                  className="text-[10px] font-bold uppercase px-2 py-0.5 rounded flex items-center gap-1"
                  style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.25)" }}
                >
                  <span className="live-dot" /> Live
                </span>
              )}
            </p>
          )}
          {/* Social links (settled July 28, 2026) — separate from the
              Twitch block above, which keeps its own dedicated spot + live
              badge. Renders nothing at all (not even a wrapping element)
              when nothing is set. */}
          <SocialLinks
            className="mt-2"
            twitterUrl={player.twitterUrl}
            instagramUrl={player.instagramUrl}
            youtubeUrl={player.youtubeUrl}
            discordUrl={player.discordUrl}
            tiktokUrl={player.tiktokUrl}
            otherLinkUrl={player.otherLinkUrl}
            otherLinkLabel={player.otherLinkLabel}
          />
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {player.characters.map((c: string) => (
              <span
                key={c}
                className="text-[12px] px-2.5 py-1 rounded"
                style={{ background: "var(--navy-4)", border: "1px solid var(--border-strong)", color: "var(--text-secondary)" }}
              >
                {c}
              </span>
            ))}
            {player.region && (
              <span className="text-[12px] text-[var(--text-secondary)]">· {player.region}</span>
            )}
            <span
              className="text-[11px] font-bold px-2 py-1 rounded font-rajdhani"
              style={{ background: "var(--gold-dim)", color: "var(--gold)", border: "1px solid rgba(240,180,41,0.25)" }}
            >
              {player.points.toLocaleString()} pts
            </span>
          </div>
        </div>
      </div>

      {/* Player ID + QR code — foundation for the separately-planned
          QR-based tournament check-in feature. Plain-text encoding of the
          formatted ID for now; check-in can decide later if it needs a
          richer payload. Visible to the profile owner, Admin/Super Admin,
          and any TO (site-wide — see the Player.displayId resolver comment
          for why TO's reach is broader here than its usual per-tournament
          scope). The real gate is server-side on Player.displayId itself —
          the resolver already returns null to everyone else, so this
          condition is redundant with that, not a substitute for it; kept
          in sync so the QR box doesn't render empty for viewers the
          resolver has already excluded. */}
      {player.displayId && (viewerId === player.id || isAdminOrAbove(viewerRole) || !!(session?.user as any)?.isTO) && (
        <div className="fgc-card p-4 mb-6 flex items-center gap-4">
          <div className="bg-white p-2 rounded flex-shrink-0">
            <QRCodeSVG value={player.displayId} size={72} />
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-1">Player ID</p>
            <p className="font-rajdhani text-xl font-bold text-[var(--text-primary)] tracking-wide">{player.displayId}</p>
          </div>
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {[
          { label: "Tournaments",   value: player.tournaments.length },
          { label: "Win rate",      value: player.winRate != null ? `${Math.round(player.winRate * 100)}%` : "—" },
          { label: "Wins",          value: player.wins },
          { label: "Losses",        value: player.losses },
        ].map(({ label, value }) => (
          <div key={label} className="fgc-card p-4">
            <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-1">{label}</p>
            <p className="font-rajdhani text-2xl font-bold text-[var(--text-primary)]">{value}</p>
          </div>
        ))}
      </div>

      {/* Rankings by game — additive alongside the combined points badge
          above, not replacing it. Simple list for this first pass (game
          name + points + rank); no minimum-tournament threshold, so a game
          with just 1 counted result still shows up. See
          lib/ranking.ts's computeGameRankingsForPlayer. */}
      {player.gameRankings.length > 0 && (
        <>
          <h2 className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">Rankings by game</h2>
          <div className="fgc-card mb-6">
            {[...player.gameRankings]
              .sort((a: any, b: any) => b.points - a.points)
              .map((gr: any) => (
                <div
                  key={gr.game}
                  className="flex items-center justify-between gap-4 px-5 py-3 border-b border-[var(--border)] last:border-0"
                >
                  <p className="font-rajdhani text-[15px] font-semibold text-[var(--text-primary)]">{gr.game}</p>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-[12px] text-[var(--text-secondary)]">#{gr.rank}</span>
                    <span
                      className="text-[11px] font-bold px-2 py-1 rounded font-rajdhani"
                      style={{ background: "var(--gold-dim)", color: "var(--gold)", border: "1px solid rgba(240,180,41,0.25)" }}
                    >
                      {gr.points.toLocaleString()} pts
                    </span>
                  </div>
                </div>
              ))}
          </div>
        </>
      )}

      {/* Tournament history */}
      <h2 className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">Tournament history</h2>
      <div className="fgc-card">
        {player.tournaments.length === 0 && (
          <p className="p-6 text-[var(--text-secondary)]">No tournaments entered yet.</p>
        )}
        {[...player.tournaments]
          .sort((a: any, b: any) => new Date(b.tournament.startDate).getTime() - new Date(a.tournament.startDate).getTime())
          .map((entry: any) => (
            <Link
              key={entry.id}
              href={`/tournaments/${entry.tournament.id}`}
              className="flex items-center gap-4 px-5 py-3 border-b border-[var(--border)] last:border-0 hover:bg-[var(--navy-3)] transition-colors"
            >
              {/* Placement badge — min-w-10 (not a fixed w-10) so it stays a
                  neat square for short ordinal labels ("1st") but can widen
                  for the longer "Ongoing" label without wrapping/clipping. */}
              <div
                className="min-w-10 h-10 px-1.5 rounded flex items-center justify-center font-rajdhani text-[13px] font-bold flex-shrink-0 whitespace-nowrap"
                style={placementStyle(entry.placement)}
              >
                {placementLabel(entry)}
              </div>

              {/* Tournament info */}
              <div className="flex-1 min-w-0">
                <p className="font-rajdhani text-[15px] font-semibold text-[var(--text-primary)] leading-tight">
                  {entry.tournament.name}
                </p>
                <p className="text-[12px] text-[var(--text-secondary)]">
                  {entry.tournament.game} · {new Date(entry.tournament.startDate).toLocaleDateString()}
                </p>
              </div>

              {/* Entrant count */}
              <p className="text-[12px] text-[var(--text-muted)] flex-shrink-0">
                {entry.tournament.entrantCount} entrants
              </p>
            </Link>
          ))}
      </div>

      {/* Head-to-head — auto-shown vs the logged-in viewer (if any, and not
          your own profile) plus a picker for anyone to compare the profile
          owner against any other player. */}
      <h2 className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3 mt-6">Head-to-head</h2>
      <HeadToHeadSection profilePlayerId={player.id} viewerHeadToHead={viewerHeadToHead} players={pickablePlayers} />

      <AdSlot className="mt-6" />
    </main>
  );
}

function ordinal(n: number) {
  if (n === 1) return "st";
  if (n === 2) return "nd";
  if (n === 3) return "rd";
  return "th";
}

// A tournament with no placement yet is either still in progress (LIVE/
// UPCOMING — no result to show, not a broken/missing value) or ended/
// cancelled without one ever being recorded (falls back to a plain dash,
// same as every other "no data" placeholder on this page).
function placementLabel(entry: { placement?: number | null; tournament: { status: string } }) {
  if (entry.placement) return `${entry.placement}${ordinal(entry.placement)}`;
  if (entry.tournament.status === "LIVE" || entry.tournament.status === "UPCOMING") return "Ongoing";
  return "—";
}
