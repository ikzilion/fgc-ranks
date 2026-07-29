// components/AdvanceModelBRoundButton.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Pool format Model B only — the manual, TO-triggered advancement action
// (same precedent as GenerateMainBracketButton: manual, not auto-generated
// the moment the last pool finishes). A single confirm() + fetch, no modal —
// unlike Generate main bracket there's no seeding-method choice to make
// here, so a lighter-weight confirmation is enough.
export function AdvanceModelBRoundButton({
  tournamentId,
  modelBCurrentRoundComplete,
  canManage,
}: {
  tournamentId: string;
  modelBCurrentRoundComplete: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!canManage) return null;
  if (!modelBCurrentRoundComplete) return null;

  async function handleAdvance() {
    if (
      !confirm(
        "Advance this tournament to its next round? Every completed pool's real advancers will be regrouped into fresh pools — or, once the field has narrowed enough, the real Finals bracket."
      )
    ) {
      return;
    }

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `
            mutation AdvanceModelBRound($tournamentId: ID!) {
              advanceModelBRound(tournamentId: $tournamentId) { id }
            }
          `,
          variables: { tournamentId },
        }),
      });

      const json = await res.json();
      if (json.errors) {
        setError(json.errors[0]?.message ?? "Failed to advance round");
      } else {
        router.refresh();
      }
    } catch {
      setError("Something went wrong. Try again.");
    }

    setLoading(false);
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleAdvance}
        disabled={loading}
        className="font-rajdhani text-[13px] font-bold tracking-wide px-3 py-1.5 rounded"
        style={{ background: "var(--blue)", color: "white", border: "none", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
      >
        {loading ? "Advancing..." : "Advance to next round"}
      </button>
      {error && (
        <p className="text-[11px] px-2 py-1 rounded" style={{ background: "var(--coral-dim)", color: "var(--coral)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
