// components/CancelTournamentButton.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function CancelTournamentButton({ tournamentId, canManage }: { tournamentId: string; canManage: boolean }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  // Organizers of this tournament (or global admins) can cancel it
  if (!canManage) return null;

  async function handleCancel(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();

    const reason = prompt("Why is this tournament being cancelled? This will be shown to entrants and on the tournament list.");
    if (reason === null) return; // user hit Cancel on the prompt itself
    if (!reason.trim()) {
      alert("A cancellation reason is required.");
      return;
    }

    if (!confirm(`Cancel this tournament? Entrants will be notified with the reason: "${reason.trim()}"`)) {
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation CancelTournament($id: ID!, $reason: String!) { cancelTournament(id: $id, reason: $reason) { id status } }`,
          variables: { id: tournamentId, reason: reason.trim() },
        }),
      });
      const json = await res.json();
      if (json.errors) {
        alert(json.errors[0]?.message ?? "Failed to cancel tournament");
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
      onClick={handleCancel}
      disabled={loading}
      className="text-[11px] font-semibold px-2 py-1 rounded flex-shrink-0"
      style={{
        background: "var(--navy-4)",
        color: "var(--text-secondary)",
        border: "1px solid var(--border-strong)",
        cursor: loading ? "not-allowed" : "pointer",
        opacity: loading ? 0.6 : 1,
      }}
    >
      {loading ? "..." : "Cancel"}
    </button>
  );
}
