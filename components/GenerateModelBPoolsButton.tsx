// components/GenerateModelBPoolsButton.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Pool format Model B only — the manual, TO-triggered Round 1 generation
// action (generateModelBPools). Same lighter-weight confirm()+fetch
// treatment as AdvanceModelBRoundButton (no modal, no pool-count choice to
// make — Model B always computes its own initial pool count) rather than
// GeneratePoolsButton's modal, which exists specifically to let a Model A/C
// TO pick an arbitrary pool count.
export function GenerateModelBPoolsButton({
  tournamentId,
  entrantCount,
  canManage,
}: {
  tournamentId: string;
  entrantCount: number;
  canManage: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!canManage) return null;
  // Mirrors the server's own MODEL_B_MIN_ENTRANTS guard (lib/bracket.ts) —
  // hides the button below that floor instead of letting a TO hit the
  // GraphQL error.
  if (entrantCount < 128) return null;

  async function handleGenerate() {
    if (
      !confirm(
        `Generate Round 1 pools for this Model B tournament? ${entrantCount} entrants will be split evenly across power-of-two-sized pools.`
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
            mutation GenerateModelBPools($tournamentId: ID!) {
              generateModelBPools(tournamentId: $tournamentId) { id }
            }
          `,
          variables: { tournamentId },
        }),
      });

      const json = await res.json();
      if (json.errors) {
        setError(json.errors[0]?.message ?? "Failed to generate pools");
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
        onClick={handleGenerate}
        disabled={loading}
        className="font-rajdhani text-[13px] font-bold tracking-wide px-3 py-1.5 rounded"
        style={{ background: "var(--blue)", color: "white", border: "none", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
      >
        {loading ? "Generating..." : "Generate Round 1 pools"}
      </button>
      {error && (
        <p className="text-[11px] px-2 py-1 rounded" style={{ background: "var(--coral-dim)", color: "var(--coral)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
