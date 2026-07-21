// components/AdminUserManager.tsx
// SUPER_ADMIN-only player search + grant/revoke Admin status. Same
// client-side-filter pattern as PlayerSearchFilter — the full list is
// fetched once server-side, filtering happens locally as the admin types.
"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";

interface PlayerRow {
  id: string;
  tag: string;
  displayId?: string | null;
  avatarUrl?: string;
  user?: { id: string; role: string } | null;
}

function roleBadge(role?: string) {
  if (role === "SUPER_ADMIN")
    return <span className="text-[10px] font-bold uppercase px-2 py-1 rounded" style={{ background: "var(--gold-dim)", color: "var(--gold)", border: "1px solid rgba(240,180,41,0.25)" }}>Super Admin</span>;
  if (role === "ADMIN")
    return <span className="text-[10px] font-bold uppercase px-2 py-1 rounded" style={{ background: "var(--blue-dim)", color: "var(--blue)", border: "1px solid rgba(79,142,247,0.25)" }}>Admin</span>;
  return <span className="text-[10px] font-bold uppercase px-2 py-1 rounded" style={{ background: "var(--navy-4)", color: "var(--text-muted)", border: "1px solid var(--border)" }}>Player</span>;
}

export function AdminUserManager({ players }: { players: PlayerRow[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const filtered = useMemo(() => {
    if (!query.trim()) return players;
    const q = query.toLowerCase();
    return players.filter(p => p.tag.toLowerCase().includes(q) || p.displayId?.toLowerCase().includes(q));
  }, [players, query]);

  async function runMutation(playerId: string, query: string, confirmMessage: string) {
    if (!confirm(confirmMessage)) return;
    setLoadingId(playerId);
    setError("");
    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { playerId } }),
      });
      const json = await res.json();
      if (json.errors) {
        setError(json.errors[0]?.message ?? "Something went wrong");
      } else {
        router.refresh();
      }
    } catch {
      setError("Something went wrong. Try again.");
    }
    setLoadingId(null);
  }

  function handleGrant(playerId: string, tag: string) {
    runMutation(
      playerId,
      `mutation GrantAdmin($playerId: ID!) { grantAdmin(playerId: $playerId) }`,
      `Grant Admin status to ${tag}?`
    );
  }

  function handleRevoke(playerId: string, tag: string) {
    runMutation(
      playerId,
      `mutation RevokeAdmin($playerId: ID!) { revokeAdmin(playerId: $playerId) }`,
      `Revoke Admin status from ${tag}?`
    );
  }

  return (
    <>
      <div className="relative mb-4">
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search by tag or Player ID…"
          className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
          style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
        />
      </div>

      {error && (
        <p className="text-[12px] mb-4 px-3 py-2 rounded" style={{ background: "var(--coral-dim)", color: "var(--coral)" }}>
          {error}
        </p>
      )}

      <div className="fgc-card">
        {filtered.length === 0 && (
          <p className="p-6 text-[var(--text-secondary)]">No players match "{query}".</p>
        )}
        {filtered.map(player => {
          const role = player.user?.role;
          const loading = loadingId === player.id;
          return (
            <div
              key={player.id}
              className="flex items-center gap-3 px-4 sm:px-5 py-3 border-b border-[var(--border)] last:border-0"
            >
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 font-rajdhani text-[12px] font-bold overflow-hidden"
                style={{ background: "var(--blue-dim)", border: "1px solid rgba(79,142,247,0.3)", color: "var(--blue)" }}
              >
                {player.avatarUrl ? (
                  <img src={player.avatarUrl} alt={player.tag} className="w-full h-full object-cover" />
                ) : (
                  player.tag.slice(0, 2).toUpperCase()
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-rajdhani text-[15px] font-bold text-[var(--text-primary)] leading-tight">{player.tag}</p>
                {player.displayId && <p className="text-[11px] font-mono text-[var(--text-muted)]">{player.displayId}</p>}
              </div>
              {roleBadge(role)}
              {role === "SUPER_ADMIN" ? (
                <span className="text-[11px] text-[var(--text-muted)] w-[120px] text-right flex-shrink-0">Fixed account</span>
              ) : role === "ADMIN" ? (
                <button
                  onClick={() => handleRevoke(player.id, player.tag)}
                  disabled={loading}
                  className="text-[11px] font-semibold px-3 py-1.5 rounded flex-shrink-0"
                  style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.2)", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
                >
                  {loading ? "..." : "Revoke admin"}
                </button>
              ) : (
                <button
                  onClick={() => handleGrant(player.id, player.tag)}
                  disabled={loading}
                  className="text-[11px] font-semibold px-3 py-1.5 rounded flex-shrink-0"
                  style={{ background: "var(--green-dim)", color: "var(--green)", border: "1px solid rgba(58,199,120,0.2)", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
                >
                  {loading ? "..." : "Grant admin"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
