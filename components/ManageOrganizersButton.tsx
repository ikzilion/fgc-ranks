// components/ManageOrganizersButton.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Organizer {
  id: string;
  tag: string;
}

interface EntrantOption {
  id: string;
  player: { id: string; tag: string };
}

export function ManageOrganizersButton({
  tournamentId,
  organizers,
  entrants,
  canManage,
}: {
  tournamentId: string;
  organizers: Organizer[];
  entrants: EntrantOption[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [addPlayerId, setAddPlayerId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!canManage) return null;

  // Only entrants who aren't already organizers can be added
  const addableEntrants = entrants.filter(
    e => !organizers.some(o => o.id === e.player.id)
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
        setAddPlayerId("");
        router.refresh();
      }
    } catch {
      setError("Something went wrong. Try again.");
    }
    setLoading(false);
  }

  function handleAdd() {
    if (!addPlayerId) return;
    runMutation(
      `
        mutation AddOrganizer($tournamentId: ID!, $playerId: ID!) {
          addTournamentOrganizer(tournamentId: $tournamentId, playerId: $playerId) { id }
        }
      `,
      { tournamentId, playerId: addPlayerId }
    );
  }

  function handleRemove(playerId: string) {
    if (!confirm("Remove this Tournament Organizer? They'll lose management access to this tournament.")) return;
    runMutation(
      `
        mutation RemoveOrganizer($tournamentId: ID!, $playerId: ID!) {
          removeTournamentOrganizer(tournamentId: $tournamentId, playerId: $playerId) { id }
        }
      `,
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
        Manage Organizers
      </button>

      {open && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 px-4"
          style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={() => setOpen(false)}
        >
          <div className="fgc-card p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h2 className="font-rajdhani text-xl font-bold text-[var(--text-primary)] mb-4">Tournament Organizers</h2>

            <div className="mb-4">
              {organizers.length === 0 ? (
                <p className="text-[13px] text-[var(--text-secondary)]">No organizers.</p>
              ) : (
                organizers.map(o => (
                  <div key={o.id} className="flex items-center justify-between py-2 border-b border-[var(--border)] last:border-0">
                    <span className="font-rajdhani text-[14px] font-semibold text-[var(--text-primary)]">{o.tag}</span>
                    <button
                      onClick={() => handleRemove(o.id)}
                      disabled={loading || organizers.length <= 1}
                      className="text-[11px] font-semibold px-2 py-1 rounded"
                      style={{
                        background: "var(--coral-dim)",
                        color: "var(--coral)",
                        border: "1px solid rgba(255,77,77,0.2)",
                        cursor: loading || organizers.length <= 1 ? "not-allowed" : "pointer",
                        opacity: organizers.length <= 1 ? 0.5 : 1,
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))
              )}
            </div>

            {addableEntrants.length > 0 && (
              <div className="mb-4">
                <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Add organizer</label>
                <div className="flex gap-2">
                  <select
                    value={addPlayerId}
                    onChange={e => setAddPlayerId(e.target.value)}
                    className="flex-1 px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--blue)]"
                    style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                  >
                    <option value="">Select entrant…</option>
                    {addableEntrants.map(e => (
                      <option key={e.player.id} value={e.player.id}>{e.player.tag}</option>
                    ))}
                  </select>
                  <button
                    onClick={handleAdd}
                    disabled={loading || !addPlayerId}
                    className="px-4 py-2 rounded font-rajdhani text-[13px] font-bold"
                    style={{ background: "var(--blue)", color: "white", border: "none", cursor: loading || !addPlayerId ? "not-allowed" : "pointer", opacity: loading || !addPlayerId ? 0.6 : 1 }}
                  >
                    Add
                  </button>
                </div>
              </div>
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
