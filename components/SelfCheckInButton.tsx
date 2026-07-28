// components/SelfCheckInButton.tsx
// Player-facing side of the check-in system — sits next to
// JoinTournamentButton in the tournament header for an entrant confirming
// their own attendance day-of, before bracket seeding. TO/admin check-in on
// someone else's behalf goes through CheckInToggleButton (entrant list) or
// Tablet/Phone Mode's QR-scan "Check in" mode instead — both call the same
// checkInEntrant mutation, just with a different playerId than the caller's
// own.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function SelfCheckInButton({
  tournamentId,
  playerId,
  checkedInAt,
  status,
}: {
  tournamentId: string;
  playerId: string;
  checkedInAt?: string | null;
  status: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  if (status === "ENDED" || status === "CANCELLED") return null;

  if (checkedInAt) {
    return (
      <span
        className="px-4 py-2 rounded font-rajdhani text-[13px] font-bold tracking-wide"
        style={{ background: "var(--green-dim)", color: "var(--green)", border: "1px solid rgba(34,197,94,0.2)" }}
      >
        ✓ Checked in
      </span>
    );
  }

  async function handleCheckIn() {
    setLoading(true);
    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `
            mutation CheckInEntrant($tournamentId: ID!, $playerId: ID!) {
              checkInEntrant(tournamentId: $tournamentId, playerId: $playerId) {
                alreadyCheckedIn
                entrant { id }
              }
            }
          `,
          variables: { tournamentId, playerId },
        }),
      });
      const json = await res.json();
      if (json.errors) {
        alert(json.errors[0]?.message ?? "Failed to check in");
      } else {
        router.refresh();
      }
    } catch {
      alert("Something went wrong. Try again.");
    }
    setLoading(false);
  }

  return (
    <button
      onClick={handleCheckIn}
      disabled={loading}
      className="px-4 py-2 rounded font-rajdhani text-[13px] font-bold tracking-wide transition-opacity"
      style={{
        background: "var(--gold)",
        color: "var(--navy)",
        border: "none",
        opacity: loading ? 0.6 : 1,
        cursor: loading ? "not-allowed" : "pointer",
      }}
    >
      {loading ? "Checking in..." : "Check in"}
    </button>
  );
}
