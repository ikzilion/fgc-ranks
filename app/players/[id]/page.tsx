// app/players/[id]/page.tsx
// Individual player profile — stats, characters, and tournament history.

import { notFound } from "next/navigation";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { auth } from "@/lib/auth";
import { EditProfileButton } from "@/components/EditProfileButton";
import { HeadToHeadSection } from "@/components/HeadToHeadSection";
import { ZoomableAvatar } from "@/components/ZoomableAvatar";

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
      characters
      wins
      losses
      points
      winRate
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

async function getPlayerPageData(id: string, viewerId?: string) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL;
  const [playerJson, viewerH2hJson, playersJson] = await Promise.all([
    fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: GET_PLAYER, variables: { id } }),
      next: { revalidate: 60 },
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
  ]);

  return {
    player: playerJson.data?.player ?? null,
    viewerHeadToHead: viewerH2hJson?.data?.player?.headToHead ?? null,
    players: playersJson.data?.players ?? [],
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
  const { player, viewerHeadToHead, players } = await getPlayerPageData(id, viewerId);
  if (!player) notFound();

  const totalGames = player.wins + player.losses;
  // Picker shouldn't offer comparing a player against themselves.
  const pickablePlayers = players.filter((p: any) => p.id !== player.id);

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="fgc-card p-6 mb-4 flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-5">
        <ZoomableAvatar avatarUrl={player.avatarUrl} tag={player.tag} sizeClassName="w-16 h-16" textClassName="text-2xl" />
        <div className="flex-1">
          <div className="flex items-center justify-between">
            <h1 className="font-rajdhani text-3xl font-bold text-[var(--text-primary)] leading-tight">{player.tag}</h1>
            <EditProfileButton
              playerId={player.id}
              currentTag={player.tag}
              currentRegion={player.region}
              currentCharacters={player.characters}
              currentAvatarUrl={player.avatarUrl}
              currentTeam={player.team}
            />
          </div>
          {player.team && (
            <p className="text-[13px] font-semibold mt-0.5" style={{ color: "var(--blue)" }}>{player.team}</p>
          )}
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
          richer payload. */}
      {player.displayId && (
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
