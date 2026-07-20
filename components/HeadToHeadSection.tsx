// components/HeadToHeadSection.tsx
"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

interface PickablePlayer {
  id: string;
  tag: string;
  avatarUrl?: string | null;
}

interface HeadToHeadResult {
  wins: number;
  losses: number;
  opponent: { id: string; tag: string; avatarUrl?: string | null };
}

const GET_HEAD_TO_HEAD = `
  query GetHeadToHead($id: ID!, $opponentId: ID!) {
    player(id: $id) {
      headToHead(opponentId: $opponentId) {
        wins
        losses
        opponent { id tag avatarUrl }
      }
    }
  }
`;

// Compact avatar + record row, shared by both the auto-shown viewer
// comparison and the opponent-picker result — same shape either way.
function RecordRow({ result }: { result: HeadToHeadResult }) {
  const { wins, losses, opponent } = result;
  const noMatches = wins === 0 && losses === 0;

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] last:border-0">
      <Link href={`/players/${opponent.id}`} className="flex items-center gap-3 flex-1 min-w-0">
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 font-rajdhani text-[12px] font-bold overflow-hidden"
          style={{ background: "var(--blue-dim)", border: "1px solid rgba(79,142,247,0.3)", color: "var(--blue)" }}
        >
          {opponent.avatarUrl ? (
            <img src={opponent.avatarUrl} alt={opponent.tag} className="w-full h-full object-cover" />
          ) : (
            opponent.tag.slice(0, 2).toUpperCase()
          )}
        </div>
        <p className="font-rajdhani text-[15px] font-semibold text-[var(--text-primary)] truncate">vs {opponent.tag}</p>
      </Link>
      {noMatches ? (
        <p className="text-[12px] text-[var(--text-muted)] flex-shrink-0">No matches played yet</p>
      ) : (
        <p className="font-rajdhani text-xl font-bold flex-shrink-0" style={{ color: "var(--text-primary)" }}>
          <span style={{ color: "var(--green)" }}>{wins}</span>
          {"-"}
          <span style={{ color: "var(--coral)" }}>{losses}</span>
        </p>
      )}
    </div>
  );
}

export function HeadToHeadSection({
  profilePlayerId,
  viewerHeadToHead,
  players,
}: {
  profilePlayerId: string;
  viewerHeadToHead: HeadToHeadResult | null;
  players: PickablePlayer[];
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<HeadToHeadResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const matches = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return players.filter(p => p.tag.toLowerCase().includes(q)).slice(0, 8);
  }, [players, query]);

  async function pickOpponent(opponentId: string, opponentTag: string) {
    setOpen(false);
    setQuery(opponentTag);
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: GET_HEAD_TO_HEAD, variables: { id: profilePlayerId, opponentId } }),
      });
      const json = await res.json();
      if (json.errors) {
        setError(json.errors[0]?.message ?? "Failed to load head-to-head record");
      } else {
        setPicked(json.data?.player?.headToHead ?? null);
      }
    } catch {
      setError("Something went wrong. Try again.");
    }

    setLoading(false);
  }

  return (
    // overflow: visible override — .fgc-card's overflow:hidden (for
    // rounded-corner clipping elsewhere) otherwise clips the picker's
    // absolutely-positioned dropdown at the card's bottom edge instead of
    // letting it float over the page content below, same class of bug
    // BracketView's bracket card hit with its sticky scrollbar.
    <div className="fgc-card" style={{ overflow: "visible" }}>
      {viewerHeadToHead && <RecordRow result={viewerHeadToHead} />}

      <div className="p-4">
        <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">
          Compare against another player
        </label>
        <div className="relative">
          <input
            type="text"
            value={query}
            onChange={e => {
              setQuery(e.target.value);
              setOpen(true);
              setPicked(null);
              setError("");
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            placeholder="Search by tag…"
            className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
            style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
          />
          {open && matches.length > 0 && (
            <div
              className="absolute left-0 right-0 mt-1 rounded-md overflow-hidden z-10"
              style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
            >
              {matches.map(p => (
                <button
                  key={p.id}
                  type="button"
                  onMouseDown={() => pickOpponent(p.id, p.tag)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left text-[13px] text-[var(--text-primary)] hover:bg-[var(--navy-4)] transition-colors"
                  style={{ cursor: "pointer" }}
                >
                  {p.tag}
                </button>
              ))}
            </div>
          )}
        </div>

        {loading && <p className="text-[12px] text-[var(--text-secondary)] mt-3">Loading…</p>}
        {error && (
          <p className="text-[12px] mt-3 px-3 py-2 rounded" style={{ background: "var(--coral-dim)", color: "var(--coral)" }}>
            {error}
          </p>
        )}
      </div>

      {picked && (
        <div className="border-t border-[var(--border)]">
          <RecordRow result={picked} />
        </div>
      )}
    </div>
  );
}
