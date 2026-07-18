// components/DeleteTournamentButton.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DeleteTournamentButton({ tournamentId, canManage }: { tournamentId: string; canManage: boolean }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  // Organizers of this tournament (or global admins) can delete it
  if (!canManage) return null;

  async function handleDelete(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();

    if (!confirm("Delete this tournament? This will also delete all its matches and entrants. This cannot be undone.")) {
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation DeleteTournament($id: ID!) { deleteTournament(id: $id) }`,
          variables: { id: tournamentId },
        }),
      });
      const json = await res.json();
      if (json.errors) {
        alert(json.errors[0]?.message ?? "Failed to delete tournament");
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
      onClick={handleDelete}
      disabled={loading}
      className="text-[11px] font-semibold px-2 py-1 rounded flex-shrink-0"
      style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.2)", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
    >
      {loading ? "..." : "Delete"}
    </button>
  );
}
