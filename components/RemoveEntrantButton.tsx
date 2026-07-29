// components/RemoveEntrantButton.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function RemoveEntrantButton({
  entrantId,
  playerTag,
  canManage,
  status,
}: {
  entrantId: string;
  playerTag: string;
  canManage: boolean;
  status: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  // Organizers/admins can remove an entrant while UPCOMING or LIVE (e.g. a
  // no-show), but not once the tournament has ENDED — mirrors the server-side guard.
  if (!canManage || status === "ENDED") return null;

  async function handleRemove() {
    if (!confirm(`Remove ${playerTag} from this tournament?`)) return;

    setLoading(true);

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
        alert(json.errors[0]?.message ?? "Failed to remove entrant");
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
      onClick={handleRemove}
      disabled={loading}
      className="text-[11px] font-semibold px-2 py-1 rounded flex-shrink-0"
      style={{
        background: "var(--coral-dim)",
        color: "var(--coral)",
        border: "1px solid rgba(255,77,77,0.2)",
        cursor: loading ? "not-allowed" : "pointer",
        opacity: loading ? 0.6 : 1,
      }}
    >
      {loading ? "..." : "Remove"}
    </button>
  );
}
