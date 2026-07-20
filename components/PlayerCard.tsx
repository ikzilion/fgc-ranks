// components/PlayerCard.tsx
// Shared left-column "your player card" widget — originally built for the
// homepage (Phase 2 of the homepage redesign), extracted here so it can be
// reused unchanged (avatar, tag, team, region, points/wins/losses tiles,
// link to full profile) anywhere else that wants the same treatment, e.g.
// the Players list page. Logged-out visitors get the same sign-in/register
// prompt in both places.
import Link from "next/link";
import { ZoomableAvatar } from "@/components/ZoomableAvatar";

interface PlayerCardData {
  id: string;
  tag: string;
  region?: string | null;
  team?: string | null;
  avatarUrl?: string | null;
  wins: number;
  losses: number;
  points: number;
}

export function PlayerCard({ player }: { player: PlayerCardData | null }) {
  if (!player) {
    return (
      <div className="fgc-card p-6 text-center">
        <p className="text-[13px] text-[var(--text-secondary)] mb-4">Sign in to see your player card and stats.</p>
        <div className="flex flex-col gap-2">
          <Link
            href="/login"
            className="py-2 rounded font-rajdhani text-[14px] font-bold"
            style={{ background: "var(--blue)", color: "white" }}
          >
            Sign in
          </Link>
          <Link
            href="/register"
            className="py-2 rounded font-rajdhani text-[14px] font-bold"
            style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)" }}
          >
            Create account
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="fgc-card p-5">
      <div className="flex items-center gap-3 mb-4">
        <ZoomableAvatar avatarUrl={player.avatarUrl} tag={player.tag} sizeClassName="w-12 h-12" textClassName="text-base" />
        <div className="min-w-0">
          <p className="font-rajdhani text-lg font-bold text-[var(--text-primary)] leading-tight truncate">{player.tag}</p>
          {player.team && <p className="text-[11px] font-semibold truncate" style={{ color: "var(--blue)" }}>{player.team}</p>}
          {player.region && <p className="text-[11px] text-[var(--text-secondary)] truncate">{player.region}</p>}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-4">
        {[
          { label: "Points", value: player.points },
          { label: "Wins", value: player.wins },
          { label: "Losses", value: player.losses },
        ].map(({ label, value }) => (
          <div key={label} className="text-center px-1 py-2 rounded" style={{ background: "var(--navy-3)" }}>
            <p className="font-rajdhani text-base font-bold text-[var(--text-primary)] leading-tight">{value}</p>
            <p className="text-[9px] uppercase tracking-widest text-[var(--text-muted)]">{label}</p>
          </div>
        ))}
      </div>

      <Link
        href={`/players/${player.id}`}
        className="block text-center text-[12px] font-semibold py-2 rounded"
        style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)" }}
      >
        View profile
      </Link>
    </div>
  );
}
