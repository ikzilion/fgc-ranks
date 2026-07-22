// components/GenerateMainBracketButton.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type MainSeedingMethod = "RANDOM" | "AVOID_SAME_POOL";

const SEEDING_LABELS: Record<MainSeedingMethod, string> = {
  RANDOM: "Fully random",
  AVOID_SAME_POOL: "Avoid same-pool matchups early",
};

export function GenerateMainBracketButton({
  tournamentId,
  allPoolsComplete,
  canManage,
}: {
  tournamentId: string;
  allPoolsComplete: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [seedingMethod, setSeedingMethod] = useState<MainSeedingMethod>("AVOID_SAME_POOL");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!canManage) return null;
  if (!allPoolsComplete) return null;

  async function handleGenerate() {
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `
            mutation GenerateMainBracket($tournamentId: ID!, $seedingMethod: SeedingMethod!) {
              generateMainBracket(tournamentId: $tournamentId, seedingMethod: $seedingMethod) { id }
            }
          `,
          variables: { tournamentId, seedingMethod },
        }),
      });

      const json = await res.json();
      if (json.errors) {
        setError(json.errors[0]?.message ?? "Failed to generate main bracket");
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
        onClick={() => { setError(""); setOpen(true); }}
        className="font-rajdhani text-[13px] font-bold tracking-wide px-3 py-1.5 rounded"
        style={{ background: "var(--blue)", color: "white", border: "none", cursor: "pointer" }}
      >
        Generate main bracket
      </button>

      {open && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 px-4"
          style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={() => setOpen(false)}
        >
          <div className="fgc-card p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h2 className="font-rajdhani text-xl font-bold text-[var(--text-primary)] mb-1">Generate main bracket</h2>
            <p className="text-[12px] text-[var(--text-secondary)] mb-4">
              Seeds a fresh double-elimination bracket from the top 2 finishers of every pool.
            </p>

            <div className="mb-4">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Seeding method</label>
              <select
                value={seedingMethod}
                onChange={e => setSeedingMethod(e.target.value as MainSeedingMethod)}
                className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--blue)]"
                style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
              >
                {(Object.keys(SEEDING_LABELS) as MainSeedingMethod[]).map(method => (
                  <option key={method} value={method}>{SEEDING_LABELS[method]}</option>
                ))}
              </select>
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
                disabled={loading}
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
