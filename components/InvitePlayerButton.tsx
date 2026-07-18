// components/InvitePlayerButton.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface PlayerOption {
  id: string;
  tag: string;
}

export function InvitePlayerButton({
  tournamentId,
  visibility,
  invitedPlayers,
  entrants,
  allPlayers,
  canManage,
}: {
  tournamentId: string;
  visibility: string;
  invitedPlayers: PlayerOption[];
  entrants: { player: PlayerOption }[];
  allPlayers: PlayerOption[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [invitePlayerId, setInvitePlayerId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!canManage) return null;

  const isPrivate = visibility === "PRIVATE";

  // Can't invite someone who's already an entrant or already invited
  const invitablePlayers = allPlayers.filter(
    p =>
      !entrants.some(e => e.player.id === p.id) &&
      !invitedPlayers.some(i => i.id === p.id)
  );

  async function runMutation(query: string, variables: Record<string, unknown>) {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      const json = await res.json();
      if (json.errors) {
        setError(json.errors[0]?.message ?? "Something went wrong");
      } else {
        setInvitePlayerId("");
        router.refresh();
      }
    } catch {
      setError("Something went wrong. Try again.");
    }
    setLoading(false);
  }

  function handleToggleVisibility() {
    const next = isPrivate ? "PUBLIC" : "PRIVATE";
    const msg = isPrivate
      ? "Make this tournament public? Anyone will be able to join without an invite."
      : "Make this tournament private? Only invited players will be able to join. It will still be visible (locked) to everyone else.";
    if (!confirm(msg)) return;
    runMutation(
      `mutation UpdateVisibility($id: ID!, $visibility: TournamentVisibility!) {
        updateTournamentVisibility(id: $id, visibility: $visibility) { id }
      }`,
      { id: tournamentId, visibility: next }
    );
  }

  function handleInvite() {
    if (!invitePlayerId) return;
    runMutation(
      `mutation Invite($tournamentId: ID!, $playerId: ID!) {
        inviteToTournament(tournamentId: $tournamentId, playerId: $playerId) { id }
      }`,
      { tournamentId, playerId: invitePlayerId }
    );
  }

  function handleCancelInvite(playerId: string) {
    runMutation(
      `mutation CancelInvite($tournamentId: ID!, $playerId: ID!) {
        cancelTournamentInvite(tournamentId: $tournamentId, playerId: $playerId) { id }
      }`,
      { tournamentId, playerId }
    );
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="font-rajdhani text-[13px] font-bold tracking-wide px-3 py-1.5 rounded"
        style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)", cursor: "pointer" }}
      >
        {isPrivate ? "🔒 Private / Invites" : "Visibility / Invites"}
      </button>

      {open && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 px-4"
          style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={() => setOpen(false)}
        >
          <div className="fgc-card p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h2 className="font-rajdhani text-xl font-bold text-[var(--text-primary)] mb-1">Visibility &amp; Invites</h2>
            <p className="text-[12px] text-[var(--text-secondary)] mb-4">
              {isPrivate
                ? "Private — only invited players can join. Still visible (locked) to everyone else."
                : "Public — anyone can join without an invite."}
            </p>

            <button
              onClick={handleToggleVisibility}
              disabled={loading}
              className="w-full py-2 rounded font-rajdhani text-[13px] font-bold mb-5"
              style={{
                background: isPrivate ? "var(--green-dim)" : "var(--navy-4)",
                color: isPrivate ? "var(--green)" : "var(--text-secondary)",
                border: "1px solid var(--border-strong)",
                cursor: loading ? "not-allowed" : "pointer",
                opacity: loading ? 0.6 : 1,
              }}
            >
              {isPrivate ? "Make public" : "Make private"}
            </button>

            {isPrivate && (
              <>
                <div className="mb-4">
                  <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Pending invites</label>
                  {invitedPlayers.length === 0 ? (
                    <p className="text-[13px] text-[var(--text-secondary)]">No pending invites.</p>
                  ) : (
                    invitedPlayers.map(p => (
                      <div key={p.id} className="flex items-center justify-between py-2 border-b border-[var(--border)] last:border-0">
                        <span className="font-rajdhani text-[14px] font-semibold text-[var(--text-primary)]">{p.tag}</span>
                        <button
                          onClick={() => handleCancelInvite(p.id)}
                          disabled={loading}
                          className="text-[11px] font-semibold px-2 py-1 rounded"
                          style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.2)", cursor: loading ? "not-allowed" : "pointer" }}
                        >
                          Cancel invite
                        </button>
                      </div>
                    ))
                  )}
                </div>

                {invitablePlayers.length > 0 && (
                  <div className="mb-4">
                    <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Invite a player</label>
                    <div className="flex gap-2">
                      <select
                        value={invitePlayerId}
                        onChange={e => setInvitePlayerId(e.target.value)}
                        className="flex-1 px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--blue)]"
                        style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                      >
                        <option value="">Select player…</option>
                        {invitablePlayers.map(p => (
                          <option key={p.id} value={p.id}>{p.tag}</option>
                        ))}
                      </select>
                      <button
                        onClick={handleInvite}
                        disabled={loading || !invitePlayerId}
                        className="px-4 py-2 rounded font-rajdhani text-[13px] font-bold"
                        style={{ background: "var(--blue)", color: "white", border: "none", cursor: loading || !invitePlayerId ? "not-allowed" : "pointer", opacity: loading || !invitePlayerId ? 0.6 : 1 }}
                      >
                        Invite
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}

            {error && (
              <p className="text-[12px] mb-4 px-3 py-2 rounded" style={{ background: "var(--coral-dim)", color: "var(--coral)" }}>
                {error}
              </p>
            )}

            <button
              onClick={() => setOpen(false)}
              className="w-full py-2 rounded font-rajdhani text-[14px] font-bold"
              style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border)", cursor: "pointer" }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}
