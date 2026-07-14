// components/JoinTournamentButton.tsx
"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

interface Props {
  tournamentId: string;
  isEntered: boolean;
}

export function JoinTournamentButton({ tournamentId, isEntered }: Props) {
  const { data: session } = useSession();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!session) {
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
      <span
        className="px-4 py-2 rounded font-rajdhani text-[13px] font-bold tracking-wide"
        style={{ background: "var(--green-dim)", color: "var(--green)", border: "1px solid rgba(34,197,94,0.2)" }}
      >
        ✓ Entered
      </span>
    );
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
