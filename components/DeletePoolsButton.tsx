// components/DeletePoolsButton.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DeletePoolsButton({ tournamentId, canManage }: { tournamentId: string; canManage: boolean }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  if (!canManage) return null;

  async function handleDelete() {
    if (!confirm("Delete all pools? Every pool's bracket and match progress will be lost — entrants stay joined, you can regenerate pools afterward.")) return;

    setLoading(true);
    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation DeletePools($tournamentId: ID!) { deletePools(tournamentId: $tournamentId) }`,
          variables: { tournamentId },
        }),
      });
      const json = await res.json();
      if (json.errors) {
        alert(json.errors[0]?.message ?? "Failed to delete pools");
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
      className="font-rajdhani text-[13px] font-bold tracking-wide px-3 py-1.5 rounded"
      style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.2)", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
    >
      Delete pools
    </button>
  );
}
