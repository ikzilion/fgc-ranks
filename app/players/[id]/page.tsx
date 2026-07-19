// app/players/[id]/page.tsx
// Individual player profile — stats, characters, and tournament history.

import { notFound } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { EditProfileButton } from "@/components/EditProfileButton";

const GET_PLAYER = `
  query GetPlayer($id: ID!) {
    player(id: $id) {
      id
      tag
      displayId
      region
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
          startDate
          entrantCount
        }
      }
    }
  }
`;

async function getPlayer(id: string) {
  const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: GET_PLAYER, variables: { id } }),
    next: { revalidate: 60 },
  });
  const { data } = await res.json();
  return data?.player ?? null;
}

function placementStyle(placement: number) {
  if (placement === 1) return { background: "var(--gold-dim)", color: "var(--gold)", border: "1px solid rgba(240,180,41,0.2)" };
  if (placement === 2) return { background: "rgba(192,200,216,0.1)", color: "#C0C8D8", border: "1px solid rgba(192,200,216,0.2)" };
  if (placement === 3) return { background: "rgba(205,127,50,0.1)", color: "#CD7F32", border: "1px solid rgba(205,127,50,0.2)" };
  return { background: "var(--navy-4)", color: "var(--text-muted)", border: "1px solid var(--border)" };
}

export default async function PlayerProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const player = await getPlayer(id);
  if (!player) notFound();

  const totalGames = player.wins + player.losses;

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="fgc-card p-6 mb-4 flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-5">
        <div
          className="w-16 h-16 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden font-rajdhani text-2xl font-bold"
          style={{ background: "var(--blue-dim)", border: "2px solid rgba(79,142,247,0.4)", color: "var(--blue)" }}
        >
          {player.avatarUrl ? (
            <img src={player.avatarUrl} alt={player.tag} className="w-full h-full object-cover" />
          ) : (
            player.tag.slice(0, 2).toUpperCase()
          )}
        </div>
        <div className="flex-1">
          <div className="flex items-center justify-between">
            <h1 className="font-rajdhani text-3xl font-bold text-[var(--text-primary)] leading-tight">{player.tag}</h1>
            <EditProfileButton
              playerId={player.id}
              currentTag={player.tag}
              currentRegion={player.region}
              currentCharacters={player.characters}
              currentAvatarUrl={player.avatarUrl}
            />
          </div>
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
            <div
              key={entry.id}
              className="flex items-center gap-4 px-5 py-3 border-b border-[var(--border)] last:border-0"
            >
              {/* Placement badge */}
              <div
                className="w-10 h-10 rounded flex items-center justify-center font-rajdhani text-[13px] font-bold flex-shrink-0"
                style={placementStyle(entry.placement)}
              >
                {entry.placement ? `${entry.placement}${ordinal(entry.placement)}` : "—"}
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
            </div>
          ))}
      </div>
    </main>
  );
}

function ordinal(n: number) {
  if (n === 1) return "st";
  if (n === 2) return "nd";
  if (n === 3) return "rd";
  return "th";
}
