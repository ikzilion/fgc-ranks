// components/CreateMatchButton.tsx
"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

interface Entrant {
  id: string;
  player: { id: string; tag: string };
}

export function CreateMatchButton({ tournamentId, entrants }: { tournamentId: string; entrants: Entrant[] }) {
  const { data: session } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [player1Id, setPlayer1Id] = useState("");
  const [player2Id, setPlayer2Id] = useState("");
  const [round, setRound] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if ((session?.user as any)?.role !== "ADMIN") return null;
  if (entrants.length < 2) return null;

  async function handleSubmit() {
    if (!player1Id || !player2Id || !round.trim()) {
      setError("All fields are required.");
      return;
    }
    if (player1Id === player2Id) {
      setError("Players must be different.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `
            mutation CreateMatch($tournamentId: ID!, $player1Id: ID!, $player2Id: ID!, $round: String!) {
              createMatch(tournamentId: $tournamentId, player1Id: $player1Id, player2Id: $player2Id, round: $round) {
                id
              }
            }
          `,
          variables: { tournamentId, player1Id, player2Id, round },
        }),
      });

      const json = await res.json();

      if (json.errors) {
        setError(json.errors[0]?.message ?? "Failed to create match");
      } else {
        setOpen(false);
        setPlayer1Id("");
        setPlayer2Id("");
        setRound("");
        router.refresh();
      }
    } catch {
      setError("Something went wrong. Try again.");
    }

    setLoading(false);
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="font-rajdhani text-[13px] font-bold tracking-wide px-3 py-1.5 rounded"
        style={{ background: "var(--blue-dim)", color: "var(--blue)", border: "1px solid rgba(79,142,247,0.2)", cursor: "pointer" }}
      >
        + New match
      </button>

      {open && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 px-4"
          style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={() => setOpen(false)}
        >
          <div className="fgc-card p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h2 className="font-rajdhani text-xl font-bold text-[var(--text-primary)] mb-4">Create match</h2>

            <div className="mb-4">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Player 1</label>
              <select
                value={player1Id}
                onChange={e => setPlayer1Id(e.target.value)}
                className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--blue)]"
                style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
              >
                <option value="">Select player…</option>
                {entrants.map(e => (
                  <option key={e.player.id} value={e.player.id}>{e.player.tag}</option>
                ))}
              </select>
            </div>

            <div className="mb-4">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Player 2</label>
              <select
                value={player2Id}
                onChange={e => setPlayer2Id(e.target.value)}
                className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--blue)]"
                style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
              >
                <option value="">Select player…</option>
                {entrants.map(e => (
                  <option key={e.player.id} value={e.player.id}>{e.player.tag}</option>
                ))}
              </select>
            </div>

            <div className="mb-6">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Round</label>
              <input
                type="text"
                value={round}
                onChange={e => setRound(e.target.value)}
                placeholder="e.g. Winners Semis, Grand Finals"
                className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
              />
            </div>

            {error && (
              <p className="text-[12px] mb-4 px-3 py-2 rounded" style={{ background: "var(--coral-dim)", color: "var(--coral)" }}>
                {error}
              </p>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => setOpen(false)}
                className="flex-1 py-2 rounded font-rajdhani text-[14px] font-bold"
                style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border)", cursor: "pointer" }}
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={loading}
                className="flex-1 py-2 rounded font-rajdhani text-[14px] font-bold"
                style={{ background: "var(--blue)", color: "white", border: "none", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
              >
                {loading ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
