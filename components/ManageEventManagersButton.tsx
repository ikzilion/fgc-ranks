// components/ManageEventManagersButton.tsx
// Add/remove co-managers on an Event — mirrors ManageOrganizersButton's
// pattern exactly, except the "who can be added" pool is every player
// (passed in as allPlayers) rather than a tournament's entrants, since an
// Event has no entrant concept.
"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";

interface Manager {
  id: string;
  tag: string;
}

interface PlayerOption {
  id: string;
  tag: string;
}

export function ManageEventManagersButton({
  eventId,
  managers,
  allPlayers,
  canManage,
}: {
  eventId: string;
  managers: Manager[];
  allPlayers: PlayerOption[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [addPlayerId, setAddPlayerId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!canManage) return null;

  const addableOptions = useMemo(() => {
    const managerIds = new Set(managers.map(m => m.id));
    const q = query.trim().toLowerCase();
    return allPlayers
      .filter(p => !managerIds.has(p.id))
      .filter(p => !q || p.tag.toLowerCase().includes(q))
      .slice(0, 20);
  }, [allPlayers, managers, query]);

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
        setQuery("");
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
        mutation AddEventManager($eventId: ID!, $playerId: ID!) {
          addEventManager(eventId: $eventId, playerId: $playerId) { id }
        }
      `,
      { eventId, playerId: addPlayerId }
    );
  }

  function handleRemove(playerId: string) {
    if (!confirm("Remove this manager? They'll lose management access to this event.")) return;
    runMutation(
      `
        mutation RemoveEventManager($eventId: ID!, $playerId: ID!) {
          removeEventManager(eventId: $eventId, playerId: $playerId) { id }
        }
      `,
      { eventId, playerId }
    );
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="font-rajdhani text-[13px] font-bold tracking-wide px-3 py-1.5 rounded"
        style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)", cursor: "pointer" }}
      >
        Manage co-managers
      </button>

      {open && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 px-4"
          style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={() => setOpen(false)}
        >
          <div className="fgc-card p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h2 className="font-rajdhani text-xl font-bold text-[var(--text-primary)] mb-4">Event managers</h2>

            <div className="mb-4">
              {managers.length === 0 ? (
                <p className="text-[13px] text-[var(--text-secondary)]">No managers.</p>
              ) : (
                managers.map(m => (
                  <div key={m.id} className="flex items-center justify-between py-2 border-b border-[var(--border)] last:border-0">
                    <span className="font-rajdhani text-[14px] font-semibold text-[var(--text-primary)]">{m.tag}</span>
                    <button
                      onClick={() => handleRemove(m.id)}
                      disabled={loading || managers.length <= 1}
                      className="text-[11px] font-semibold px-2 py-1 rounded"
                      style={{
                        background: "var(--coral-dim)",
                        color: "var(--coral)",
                        border: "1px solid rgba(255,77,77,0.2)",
                        cursor: loading || managers.length <= 1 ? "not-allowed" : "pointer",
                        opacity: managers.length <= 1 ? 0.5 : 1,
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="mb-4">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Add a manager</label>
              <input
                type="text"
                value={query}
                onChange={e => { setQuery(e.target.value); setAddPlayerId(""); }}
                placeholder="Search by tag…"
                className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)] mb-2"
                style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
              />
              <div className="flex gap-2">
                <select
                  value={addPlayerId}
                  onChange={e => setAddPlayerId(e.target.value)}
                  className="flex-1 px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--blue)]"
                  style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                >
                  <option value="">Select player…</option>
                  {addableOptions.map(p => (
                    <option key={p.id} value={p.id}>{p.tag}</option>
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
