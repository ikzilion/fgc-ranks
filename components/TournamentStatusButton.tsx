// components/TournamentStatusButton.tsx
"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

const STATUS_FLOW: Record<string, { next: string; label: string } | null> = {
  UPCOMING: { next: "LIVE", label: "Start tournament" },
  LIVE: { next: "ENDED", label: "End tournament" },
  ENDED: { next: "LIVE", label: "Reopen tournament" },
};

export function TournamentStatusButton({ tournamentId, status }: { tournamentId: string; status: string }) {
  const { data: session } = useSession();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  if ((session?.user as any)?.role !== "ADMIN") return null;

  const transition = STATUS_FLOW[status];
  if (!transition) return null;

  async function handleClick() {
    const isEnding = transition!.next === "ENDED";
    const isReopening = status === "ENDED" && transition!.next === "LIVE";

    const message = isEnding
      ? `End this tournament? This marks it as finished. Join/Leave stay locked for players; you can reopen it later if needed.`
      : isReopening
      ? `Reopen this tournament? This sets it back to LIVE so you can create or report additional matches. Join/Leave remain locked for players either way, since the tournament is underway.`
      : `${transition!.label}? This will change the status to ${transition!.next}.`;

    if (!confirm(message)) return;

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

  const isEndingButton = transition.next === "ENDED";
  const isReopenButton = status === "ENDED" && transition.next === "LIVE";

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className="font-rajdhani text-[13px] font-bold tracking-wide px-3 py-1.5 rounded"
      style={{
        background: isEndingButton ? "var(--navy-4)" : isReopenButton ? "var(--blue-dim)" : "var(--green-dim)",
        color: isEndingButton ? "var(--text-secondary)" : isReopenButton ? "var(--blue)" : "var(--green)",
        border: isEndingButton
          ? "1px solid var(--border-strong)"
          : isReopenButton
          ? "1px solid rgba(79,142,247,0.25)"
          : "1px solid rgba(34,197,94,0.25)",
        cursor: loading ? "not-allowed" : "pointer",
        opacity: loading ? 0.6 : 1,
      }}
    >
      {loading ? "..." : transition.label}
    </button>
  );
}
