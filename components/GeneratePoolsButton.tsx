// components/GeneratePoolsButton.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function GeneratePoolsButton({
  tournamentId,
  entrantCount,
  suggestedPoolCount,
  canManage,
}: {
  tournamentId: string;
  entrantCount: number;
  suggestedPoolCount: number;
  canManage: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [poolCount, setPoolCount] = useState(String(suggestedPoolCount));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!canManage) return null;
  if (entrantCount < 4) return null;

  function openModal() {
    setPoolCount(String(suggestedPoolCount));
    setError("");
    setOpen(true);
  }

  async function handleGenerate() {
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `
            mutation GeneratePools($tournamentId: ID!, $poolCount: Int) {
              generatePools(tournamentId: $tournamentId, poolCount: $poolCount) { id }
            }
          `,
          variables: { tournamentId, poolCount: Number(poolCount) },
        }),
      });

      const json = await res.json();
      if (json.errors) {
        setError(json.errors[0]?.message ?? "Failed to generate pools");
      } else {
        setOpen(false);
        router.refresh();
      }
    } catch {
      setError("Something went wrong. Try again.");
    }

    setLoading(false);
  }

  return (
    <>
      <button
        onClick={openModal}
        className="font-rajdhani text-[13px] font-bold tracking-wide px-3 py-1.5 rounded"
        style={{ background: "var(--blue)", color: "white", border: "none", cursor: "pointer" }}
      >
        Generate pools
      </button>

      {open && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 px-4"
          style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={() => setOpen(false)}
        >
          <div className="fgc-card p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h2 className="font-rajdhani text-xl font-bold text-[var(--text-primary)] mb-1">Generate pools</h2>
            <p className="text-[12px] text-[var(--text-secondary)] mb-4">
              {entrantCount} entrants will be split evenly across the pools below — each pool becomes its own double-elimination bracket.
            </p>

            <div className="mb-4">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Number of pools</label>
              <input
                type="number"
                min={1}
                max={Math.floor(entrantCount / 2)}
                value={poolCount}
                onChange={e => setPoolCount(e.target.value)}
                className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--blue)]"
                style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
              />
              <p className="text-[11px] text-[var(--text-muted)] mt-1.5">Suggested: {suggestedPoolCount} (targeting ~6-8 entrants per pool)</p>
            </div>

            {error && (
              <p className="text-[12px] mb-4 px-3 py-2 rounded" style={{ background: "var(--coral-dim)", color: "var(--coral)" }}>
                {error}
              </p>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => setOpen(false)}
                className="flex-1 py-2 rounded font-rajdhani text-[14px] font-bold"
                style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border)", cursor: "pointer" }}
              >
                Cancel
              </button>
              <button
                onClick={handleGenerate}
                disabled={loading || !poolCount || Number(poolCount) < 1}
                className="flex-1 py-2 rounded font-rajdhani text-[14px] font-bold"
                style={{ background: "var(--blue)", color: "white", border: "none", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
              >
                {loading ? "Generating..." : "Generate"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
