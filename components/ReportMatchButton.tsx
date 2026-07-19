// components/ReportMatchButton.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Match {
  id: string;
  round: string;
  status: string;
  player1: { id: string; tag: string };
  player2: { id: string; tag: string };
  player1Score: number;
  player2Score: number;
  isForfeit?: boolean;
  winner?: { id: string; tag: string };
}

export function ReportMatchButton({ match, canManage }: { match: Match; canManage: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isForfeitMode, setIsForfeitMode] = useState(false);
  const [p1Score, setP1Score] = useState(0);
  const [p2Score, setP2Score] = useState(0);
  const [forfeitingPlayerId, setForfeitingPlayerId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const isEditing = match.status === "COMPLETED";

  // Only tournament organizers (or admins) can see these controls at all
  if (!canManage) return null;

  function openModal() {
    // Pre-fill with the existing result when editing an already-reported match
    setP1Score(isEditing ? match.player1Score : 0);
    setP2Score(isEditing ? match.player2Score : 0);
    setIsForfeitMode(isEditing ? !!match.isForfeit : false);
    setForfeitingPlayerId(isEditing && match.isForfeit && match.winner ? (match.winner.id === match.player1.id ? match.player2.id : match.player1.id) : "");
    setError("");
    setOpen(true);
  }

  async function handleSubmit() {
    if (isForfeitMode) {
      if (!forfeitingPlayerId) {
        setError("Select which player forfeited.");
        return;
      }
    } else if (p1Score === p2Score) {
      setError("Scores cannot be tied.");
      return;
    }
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: isEditing
            ? `
              mutation EditMatchResult($matchId: ID!, $player1Score: Int, $player2Score: Int, $isForfeit: Boolean, $forfeitingPlayerId: ID) {
                editMatchResult(matchId: $matchId, player1Score: $player1Score, player2Score: $player2Score, isForfeit: $isForfeit, forfeitingPlayerId: $forfeitingPlayerId) {
                  id
                  status
                  winner { tag }
                }
              }
            `
            : `
              mutation ReportResult($matchId: ID!, $player1Score: Int, $player2Score: Int, $isForfeit: Boolean, $forfeitingPlayerId: ID) {
                reportResult(matchId: $matchId, player1Score: $player1Score, player2Score: $player2Score, isForfeit: $isForfeit, forfeitingPlayerId: $forfeitingPlayerId) {
                  id
                  status
                  winner { tag }
                }
              }
            `,
          variables: isForfeitMode
            ? { matchId: match.id, player1Score: null, player2Score: null, isForfeit: true, forfeitingPlayerId }
            : { matchId: match.id, player1Score: p1Score, player2Score: p2Score, isForfeit: false, forfeitingPlayerId: null },
        }),
      });

      const json = await res.json();
      if (json.errors) {
        setError(json.errors[0]?.message ?? `Failed to ${isEditing ? "update" : "report"} result`);
      } else {
        setOpen(false);
        router.refresh();
      }
    } catch {
      setError("Something went wrong. Try again.");
    }

    setLoading(false);
  }

  async function handleDelete() {
    if (!confirm("Delete this match? This cannot be undone.")) return;

    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation DeleteMatch($id: ID!) { deleteMatch(id: $id) }`,
          variables: { id: match.id },
        }),
      });
      const json = await res.json();
      if (json.errors) {
        alert(json.errors[0]?.message ?? "Failed to delete match");
      } else {
        router.refresh();
      }
    } catch {
      alert("Something went wrong. Try again.");
    }
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <button
          onClick={openModal}
          className="text-[11px] font-semibold px-2 py-1 rounded"
          style={{ background: "var(--blue-dim)", color: "var(--blue)", border: "1px solid rgba(79,142,247,0.2)", cursor: "pointer" }}
        >
          {isEditing ? "Edit result" : "Report result"}
        </button>
        <button
          onClick={handleDelete}
          className="text-[11px] font-semibold px-2 py-1 rounded"
          style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.2)", cursor: "pointer" }}
        >
          Delete
        </button>
      </div>

      {open && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50"
          style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={() => setOpen(false)}
        >
          <div
            className="fgc-card p-6 w-full max-w-sm"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="font-rajdhani text-xl font-bold text-[var(--text-primary)] mb-1">{isEditing ? "Edit result" : "Report result"}</h2>
            <p className="text-[12px] text-[var(--text-secondary)] mb-4">{match.round}</p>

            {/* Score vs Forfeit toggle */}
            <div className="flex gap-2 mb-4">
              <button
                onClick={() => setIsForfeitMode(false)}
                className="flex-1 py-1.5 rounded text-[12px] font-bold"
                style={
                  isForfeitMode
                    ? { background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border)", cursor: "pointer" }
                    : { background: "var(--blue-dim)", color: "var(--blue)", border: "1px solid rgba(79,142,247,0.3)", cursor: "pointer" }
                }
              >
                Score
              </button>
              <button
                onClick={() => setIsForfeitMode(true)}
                className="flex-1 py-1.5 rounded text-[12px] font-bold"
                style={
                  isForfeitMode
                    ? { background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.3)", cursor: "pointer" }
                    : { background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border)", cursor: "pointer" }
                }
              >
                Forfeit
              </button>
            </div>

            {isForfeitMode ? (
              <div className="mb-6">
                <p className="text-[12px] text-[var(--text-secondary)] mb-3">Which player forfeits?</p>
                <div className="flex flex-col gap-2">
                  {[match.player1, match.player2].map(p => (
                    <button
                      key={p.id}
                      onClick={() => setForfeitingPlayerId(p.id)}
                      className="text-left px-3 py-2 rounded text-[13px] font-semibold"
                      style={
                        forfeitingPlayerId === p.id
                          ? { background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.4)", cursor: "pointer" }
                          : { background: "var(--navy-4)", color: "var(--text-primary)", border: "1px solid var(--border)", cursor: "pointer" }
                      }
                    >
                      {p.tag} forfeits
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {/* Player 1 */}
                <div className="flex items-center justify-between mb-4">
                  <span className="font-rajdhani text-[15px] font-semibold text-[var(--text-primary)]">{match.player1.tag}</span>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setP1Score(Math.max(0, p1Score - 1))} style={{ width: 28, height: 28, borderRadius: 6, background: "var(--navy-4)", color: "var(--text-primary)", border: "1px solid var(--border)", cursor: "pointer", fontSize: 16 }}>−</button>
                    <span className="font-rajdhani text-xl font-bold text-[var(--text-primary)] w-6 text-center">{p1Score}</span>
                    <button onClick={() => setP1Score(p1Score + 1)} style={{ width: 28, height: 28, borderRadius: 6, background: "var(--navy-4)", color: "var(--text-primary)", border: "1px solid var(--border)", cursor: "pointer", fontSize: 16 }}>+</button>
                  </div>
                </div>

                {/* Player 2 */}
                <div className="flex items-center justify-between mb-6">
                  <span className="font-rajdhani text-[15px] font-semibold text-[var(--text-primary)]">{match.player2.tag}</span>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setP2Score(Math.max(0, p2Score - 1))} style={{ width: 28, height: 28, borderRadius: 6, background: "var(--navy-4)", color: "var(--text-primary)", border: "1px solid var(--border)", cursor: "pointer", fontSize: 16 }}>−</button>
                    <span className="font-rajdhani text-xl font-bold text-[var(--text-primary)] w-6 text-center">{p2Score}</span>
                    <button onClick={() => setP2Score(p2Score + 1)} style={{ width: 28, height: 28, borderRadius: 6, background: "var(--navy-4)", color: "var(--text-primary)", border: "1px solid var(--border)", cursor: "pointer", fontSize: 16 }}>+</button>
                  </div>
                </div>
              </>
            )}

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
                {loading ? "Saving..." : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
