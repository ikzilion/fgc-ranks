// components/TournamentStatusButton.tsx
"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

const STATUS_FLOW: Record<string, { next: string; label: string } | null> = {
  UPCOMING: { next: "LIVE", label: "Start tournament" },
  LIVE: { next: "ENDED", label: "End tournament" },
  ENDED: null,
};

export function TournamentStatusButton({ tournamentId, status }: { tournamentId: string; status: string }) {
  const { data: session } = useSession();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  if ((session?.user as any)?.role !== "ADMIN") return null;

  const transition = STATUS_FLOW[status];
  if (!transition) return null;

  async function handleClick() {
    if (!confirm(`${transition!.label}? This will change the status to ${transition!.next}.`)) return;

    setLoading(true);
    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `
            mutation UpdateStatus($id: ID!, $status: TournamentStatus!) {
              updateTournamentStatus(id: $id, status: $status) { id status }
            }
          `,
          variables: { id: tournamentId, status: transition!.next },
        }),
      });
      const json = await res.json();
      if (json.errors) {
        alert(json.errors[0]?.message ?? "Failed to update status");
      } else {
        router.refresh();
      }
    } catch {
      alert("Something went wrong. Try again.");
    }
    setLoading(false);
  }

  const isEnding = transition.next === "ENDED";

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className="font-rajdhani text-[13px] font-bold tracking-wide px-3 py-1.5 rounded"
      style={{
        background: isEnding ? "var(--navy-4)" : "var(--green-dim)",
        color: isEnding ? "var(--text-secondary)" : "var(--green)",
        border: isEnding ? "1px solid var(--border-strong)" : "1px solid rgba(34,197,94,0.25)",
        cursor: loading ? "not-allowed" : "pointer",
        opacity: loading ? 0.6 : 1,
      }}
    >
      {loading ? "..." : transition.label}
    </button>
  );
}
