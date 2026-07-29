// components/CheckInToggleButton.tsx
// TO/admin manual check-in control in the entrant list — same convention as
// SetPlacementButton/RemoveEntrantButton next to it. Not a bidirectional
// toggle: checkInEntrant is one-way (see its resolver comment), so this just
// swaps from an actionable button to a static confirmed badge once
// checkedInAt is set, same pattern SetPlacementButton uses for "already has
// a placement". The QR-scan check-in mode in Tablet/Phone Mode is the other
// way to reach this same mutation — this component is the no-scanner-handy
// fallback.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function CheckInToggleButton({
  tournamentId,
  playerId,
  checkedInAt,
  canManage,
  status,
}: {
  tournamentId: string;
  playerId: string;
  checkedInAt?: string | null;
  canManage: boolean;
  status: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  if (!canManage || status === "ENDED" || status === "CANCELLED") return null;

  if (checkedInAt) {
    return (
      <span
        className="text-[11px] font-semibold px-2 py-1 rounded flex-shrink-0"
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
      className="text-[11px] font-semibold px-2 py-1 rounded flex-shrink-0"
      style={{
        background: "var(--navy-4)",
        color: "var(--text-secondary)",
        border: "1px solid var(--border)",
        cursor: loading ? "not-allowed" : "pointer",
        opacity: loading ? 0.6 : 1,
      }}
    >
      {loading ? "..." : "Check in"}
    </button>
  );
}
