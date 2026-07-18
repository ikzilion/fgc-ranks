// components/JoinTournamentButton.tsx
"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

interface Props {
  tournamentId: string;
  isEntered: boolean;
  entrantId?: string;
  status: string;
  visibility: string;
  isInvited: boolean;
}

export function JoinTournamentButton({ tournamentId, isEntered, entrantId, status, visibility, isInvited }: Props) {
  const { data: session } = useSession();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const isLocked = status === "LIVE" || status === "ENDED";
  const isPrivate = visibility === "PRIVATE";

  if (!session) {
    if (isLocked) return null; // don't show "sign in to join" for locked tournaments either
    return (
      <a
        href="/login"
        className="px-4 py-2 rounded font-rajdhani text-[13px] font-bold tracking-wide"
        style={{ background: "var(--blue-dim)", color: "var(--blue)", border: "1px solid rgba(79,142,247,0.2)" }}
      >
        Sign in to join
      </a>
    );
  }

  if (isEntered) {
    return (
      <div className="flex items-center gap-2">
        <span
          className="px-4 py-2 rounded font-rajdhani text-[13px] font-bold tracking-wide"
          style={{ background: "var(--green-dim)", color: "var(--green)", border: "1px solid rgba(34,197,94,0.2)" }}
        >
          ✓ Entered
        </span>
        {!isLocked && (
          <button
            onClick={handleLeave}
            disabled={loading}
            className="text-[11px] font-semibold px-2 py-1.5 rounded"
            style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.2)", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
          >
            {loading ? "..." : "Leave"}
          </button>
        )}
      </div>
    );
  }

  async function handleLeave() {
    if (!entrantId) return;
    if (!confirm("Leave this tournament?")) return;

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `
            mutation LeaveTournament($entrantId: ID!) {
              leaveTournament(entrantId: $entrantId)
            }
          `,
          variables: { entrantId },
        }),
      });

      const json = await res.json();

      if (json.errors) {
        setError(json.errors[0]?.message ?? "Failed to leave");
      } else {
        router.refresh();
      }
    } catch {
      setError("Something went wrong. Try again.");
    }

    setLoading(false);
  }

  async function handleJoin() {
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `
            mutation JoinTournament($tournamentId: ID!, $playerId: ID!) {
              joinTournament(tournamentId: $tournamentId, playerId: $playerId) {
                id
              }
            }
          `,
          variables: {
            tournamentId,
            playerId: (session!.user as any).playerId,
          },
        }),
      });

      const json = await res.json();

      if (json.errors) {
        setError(json.errors[0]?.message ?? "Failed to join");
      } else {
        router.refresh();
      }
    } catch (err) {
      setError("Something went wrong. Try again.");
    }

    setLoading(false);
  }

  async function handleDecline() {
    if (!confirm("Decline this invite?")) return;
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `
            mutation DeclineInvite($tournamentId: ID!, $playerId: ID!) {
              declineTournamentInvite(tournamentId: $tournamentId, playerId: $playerId) { id }
            }
          `,
          variables: { tournamentId, playerId: (session!.user as any).playerId },
        }),
      });
      const json = await res.json();
      if (json.errors) {
        setError(json.errors[0]?.message ?? "Failed to decline invite");
      } else {
        router.refresh();
      }
    } catch {
      setError("Something went wrong. Try again.");
    }

    setLoading(false);
  }

  if (isLocked) return null; // tournament already live or ended — no join button shown

  // Private tournament, not invited, nothing to do here
  if (isPrivate && !isInvited) {
    return (
      <span
        className="px-4 py-2 rounded font-rajdhani text-[13px] font-bold tracking-wide"
        style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)" }}
      >
        🔒 Private — invite only
      </span>
    );
  }

  // Private tournament, invited but hasn't responded yet — Accept / Decline
  if (isPrivate && isInvited) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <button
            onClick={handleJoin}
            disabled={loading}
            className="px-4 py-2 rounded font-rajdhani text-[13px] font-bold tracking-wide transition-opacity"
            style={{ background: "var(--green)", color: "white", opacity: loading ? 0.6 : 1, border: "none", cursor: loading ? "not-allowed" : "pointer" }}
          >
            {loading ? "..." : "Accept invite"}
          </button>
          <button
            onClick={handleDecline}
            disabled={loading}
            className="text-[11px] font-semibold px-2 py-1.5 rounded"
            style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.2)", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
          >
            Decline
          </button>
        </div>
        {error && <p className="text-[11px]" style={{ color: "var(--coral)" }}>{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleJoin}
        disabled={loading}
        className="px-4 py-2 rounded font-rajdhani text-[13px] font-bold tracking-wide transition-opacity"
        style={{ background: "var(--blue)", color: "white", opacity: loading ? 0.6 : 1, border: "none", cursor: loading ? "not-allowed" : "pointer" }}
      >
        {loading ? "Joining..." : "Join tournament"}
      </button>
      {error && <p className="text-[11px]" style={{ color: "var(--coral)" }}>{error}</p>}
    </div>
  );
}
