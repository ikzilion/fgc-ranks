// components/AdminAccountRestoreManager.tsx
// SUPER_ADMIN-only account restore tool (settled July 28, 2026, see the
// Notion "Account deletion is currently unrecoverable" writeup) — lists
// every scrubbed player still within its restore window (Player.scrubBackupTag
// non-null; see restorableDeletedPlayers/lib/accountDeletion.ts) with a
// Restore button. Same runMutation/confirm()/router.refresh() pattern as
// AdminUserManager's grant/revoke actions.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface RestorablePlayer {
  id: string;
  scrubBackupTag?: string | null;
  deletedAt?: string | null;
  user?: { id: string; scrubBackupEmail?: string | null; scrubBackupExpiresAt?: string | null } | null;
}

export function AdminAccountRestoreManager({ players }: { players: RestorablePlayer[] }) {
  const router = useRouter();
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [restoredId, setRestoredId] = useState<string | null>(null);

  async function handleRestore(player: RestorablePlayer) {
    if (
      !confirm(
        `Restore ${player.scrubBackupTag ?? "this player"} (${player.user?.scrubBackupEmail ?? "unknown email"})? ` +
          `This recovers their original tag and email. Their password was randomized at deletion time and can't be recovered — ` +
          `they'll need to use "Forgot password" to sign back in.`
      )
    ) {
      return;
    }

    setLoadingId(player.id);
    setError("");
    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation RestoreDeletedPlayer($playerId: ID!) { restoreDeletedPlayer(playerId: $playerId) { id tag } }`,
          variables: { playerId: player.id },
        }),
      });
      const json = await res.json();
      if (json.errors) {
        setError(json.errors[0]?.message ?? "Something went wrong");
      } else {
        setRestoredId(player.id);
        router.refresh();
      }
    } catch {
      setError("Something went wrong. Try again.");
    }
    setLoadingId(null);
  }

  return (
    <>
      <p className="text-[12px] text-[var(--text-secondary)] mb-4">
        Scrubbed accounts still within their restore window. Their password isn&apos;t recoverable — a restored player needs to reset it.
      </p>

      {error && (
        <p className="text-[12px] mb-4 px-3 py-2 rounded" style={{ background: "var(--coral-dim)", color: "var(--coral)" }}>
          {error}
        </p>
      )}

      <div className="fgc-card">
        {players.length === 0 && (
          <p className="p-6 text-[var(--text-secondary)]">Nothing to restore right now.</p>
        )}
        {players.map(player => {
          const loading = loadingId === player.id;
          const restored = restoredId === player.id;
          return (
            <div
              key={player.id}
              className="flex items-center gap-3 px-4 sm:px-5 py-3 border-b border-[var(--border)] last:border-0"
            >
              <div className="flex-1 min-w-0">
                <p className="font-rajdhani text-[15px] font-bold text-[var(--text-primary)] leading-tight">
                  {player.scrubBackupTag ?? "(unknown)"}
                </p>
                <p className="text-[11px] text-[var(--text-muted)]">{player.user?.scrubBackupEmail ?? "unknown email"}</p>
                {player.deletedAt && (
                  <p className="text-[11px] text-[var(--text-muted)]">Scrubbed {new Date(player.deletedAt).toLocaleDateString()}</p>
                )}
              </div>
              {restored ? (
                <span className="text-[11px] font-semibold px-3 py-1.5 rounded flex-shrink-0" style={{ background: "var(--green-dim)", color: "var(--green)" }}>
                  Restored
                </span>
              ) : (
                <button
                  onClick={() => handleRestore(player)}
                  disabled={loading}
                  className="text-[11px] font-semibold px-3 py-1.5 rounded flex-shrink-0"
                  style={{ background: "var(--green-dim)", color: "var(--green)", border: "1px solid rgba(58,199,120,0.2)", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
                >
                  {loading ? "..." : "Restore"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
