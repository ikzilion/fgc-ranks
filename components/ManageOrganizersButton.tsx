// components/ManageOrganizersButton.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Organizer {
  id: string;
  tag: string;
}

export function ManageOrganizersButton({
  tournamentId,
  organizers,
  canManage,
}: {
  tournamentId: string;
  organizers: Organizer[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Add-by-Player-ID — same type/look-up/confirm shape as CreateTournamentButton's
  // Event ID linking, works for any real player regardless of whether
  // they've entered this tournament as an entrant (the old picker was
  // limited to entrants only; addTournamentOrganizer itself never was).
  const [playerIdInput, setPlayerIdInput] = useState("");
  const [foundPlayer, setFoundPlayer] = useState<{ id: string; tag: string; displayId?: string | null } | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!canManage) return null;

  const alreadyOrganizer = !!foundPlayer && organizers.some(o => o.id === foundPlayer.id);

  async function handleLookup() {
    if (!playerIdInput.trim()) return;
    setLookupLoading(true);
    setLookupError("");
    setFoundPlayer(null);

    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `
            query LookupPlayer($displayId: String!) {
              playerByDisplayId(displayId: $displayId) { id tag displayId }
            }
          `,
          variables: { displayId: playerIdInput.trim() },
        }),
      });
      const json = await res.json();
      if (json.errors || !json.data?.playerByDisplayId) {
        setLookupError("No player found with that ID.");
      } else {
        setFoundPlayer(json.data.playerByDisplayId);
      }
    } catch {
      setLookupError("Something went wrong. Try again.");
    }

    setLookupLoading(false);
  }

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
        setPlayerIdInput("");
        setFoundPlayer(null);
        router.refresh();
      }
    } catch {
      setError("Something went wrong. Try again.");
    }
    setLoading(false);
  }

  function handleAdd() {
    if (!foundPlayer) return;
    runMutation(
      `
        mutation AddOrganizer($tournamentId: ID!, $playerId: ID!) {
          addTournamentOrganizer(tournamentId: $tournamentId, playerId: $playerId) { id }
        }
      `,
      { tournamentId, playerId: foundPlayer.id }
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

            <div className="mb-4">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Add organizer by Player ID</label>
              {foundPlayer ? (
                <div className="flex items-center gap-3 px-3 py-2.5 rounded-md" style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-semibold text-[var(--text-primary)] truncate">{foundPlayer.tag}</p>
                    <p className="text-[10px] font-mono text-[var(--text-muted)]">{foundPlayer.displayId}</p>
                  </div>
                  {alreadyOrganizer ? (
                    <span className="text-[11px] text-[var(--text-muted)] flex-shrink-0">Already an organizer</span>
                  ) : (
                    <button
                      onClick={handleAdd}
                      disabled={loading}
                      className="text-[11px] font-semibold px-3 py-1.5 rounded flex-shrink-0"
                      style={{ background: "var(--blue)", color: "white", border: "none", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
                    >
                      {loading ? "Adding..." : "Add"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => { setFoundPlayer(null); setPlayerIdInput(""); }}
                    className="text-[11px] font-semibold px-2 py-1 rounded flex-shrink-0"
                    style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)", cursor: "pointer" }}
                  >
                    Clear
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={playerIdInput}
                      onChange={e => { setPlayerIdInput(e.target.value); setLookupError(""); }}
                      placeholder="e.g. FGC-000001"
                      className="flex-1 px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                      style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                    />
                    <button
                      onClick={handleLookup}
                      disabled={lookupLoading || !playerIdInput.trim()}
                      className="text-[12px] font-semibold px-3 py-2 rounded"
                      style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)", cursor: lookupLoading ? "not-allowed" : "pointer" }}
                    >
                      {lookupLoading ? "Looking up..." : "Look up"}
                    </button>
                  </div>
                  {lookupError && <p className="text-[12px] mt-1" style={{ color: "var(--coral)" }}>{lookupError}</p>}
                </>
              )}
            </div>

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
