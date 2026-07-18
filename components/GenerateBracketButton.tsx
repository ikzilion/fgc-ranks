// components/GenerateBracketButton.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface EntrantOption {
  id: string;
  player: { id: string; tag: string };
}

type SeedingMethod = "RANDOM" | "RANDOM_WITHIN_TIERS" | "MANUAL";

const SEEDING_LABELS: Record<SeedingMethod, string> = {
  RANDOM: "Fully random",
  RANDOM_WITHIN_TIERS: "Random within tiers (by points)",
  MANUAL: "Manual seeding",
};

export function GenerateBracketButton({
  tournamentId,
  entrants,
  canManage,
  hasBracket,
}: {
  tournamentId: string;
  entrants: EntrantOption[];
  canManage: boolean;
  hasBracket: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [seedingMethod, setSeedingMethod] = useState<SeedingMethod>("RANDOM");
  const [manualOrder, setManualOrder] = useState<EntrantOption[]>(entrants);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!canManage) return null;

  function openModal() {
    setManualOrder(entrants);
    setSeedingMethod("RANDOM");
    setError("");
    setOpen(true);
  }

  function moveSeed(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= manualOrder.length) return;
    const next = [...manualOrder];
    [next[index], next[target]] = [next[target], next[index]];
    setManualOrder(next);
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
            mutation GenerateBracket($tournamentId: ID!, $seedingMethod: SeedingMethod!, $manualSeedOrder: [ID!]) {
              generateBracket(tournamentId: $tournamentId, seedingMethod: $seedingMethod, manualSeedOrder: $manualSeedOrder) { id }
            }
          `,
          variables: {
            tournamentId,
            seedingMethod,
            manualSeedOrder: seedingMethod === "MANUAL" ? manualOrder.map(e => e.player.id) : null,
          },
        }),
      });

      const json = await res.json();
      if (json.errors) {
        setError(json.errors[0]?.message ?? "Failed to generate bracket");
      } else {
        setOpen(false);
        router.refresh();
      }
    } catch {
      setError("Something went wrong. Try again.");
    }

    setLoading(false);
  }

  async function handleDelete() {
    if (!confirm("Delete this bracket? All bracket matches and progress will be lost — you can regenerate afterward.")) return;

    setLoading(true);
    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation DeleteBracket($tournamentId: ID!) { deleteBracket(tournamentId: $tournamentId) }`,
          variables: { tournamentId },
        }),
      });
      const json = await res.json();
      if (json.errors) {
        alert(json.errors[0]?.message ?? "Failed to delete bracket");
      } else {
        router.refresh();
      }
    } catch {
      alert("Something went wrong. Try again.");
    }
    setLoading(false);
  }

  if (hasBracket) {
    return (
      <button
        onClick={handleDelete}
        disabled={loading}
        className="font-rajdhani text-[13px] font-bold tracking-wide px-3 py-1.5 rounded"
        style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.2)", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
      >
        Delete bracket
      </button>
    );
  }

  if (entrants.length < 2) return null;

  return (
    <>
      <button
        onClick={openModal}
        className="font-rajdhani text-[13px] font-bold tracking-wide px-3 py-1.5 rounded"
        style={{ background: "var(--blue)", color: "white", border: "none", cursor: "pointer" }}
      >
        Generate bracket
      </button>

      {open && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 px-4"
          style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={() => setOpen(false)}
        >
          <div className="fgc-card p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h2 className="font-rajdhani text-xl font-bold text-[var(--text-primary)] mb-1">Generate bracket</h2>
            <p className="text-[12px] text-[var(--text-secondary)] mb-4">Double elimination, {entrants.length} entrants.</p>

            <div className="mb-4">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Seeding method</label>
              <select
                value={seedingMethod}
                onChange={e => setSeedingMethod(e.target.value as SeedingMethod)}
                className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--blue)]"
                style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
              >
                {(Object.keys(SEEDING_LABELS) as SeedingMethod[]).map(method => (
                  <option key={method} value={method}>{SEEDING_LABELS[method]}</option>
                ))}
              </select>
            </div>

            {seedingMethod === "MANUAL" && (
              <div className="mb-4">
                <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Seed order (1 = top seed)</label>
                <div className="max-h-64 overflow-y-auto rounded-md" style={{ border: "1px solid var(--border-strong)" }}>
                  {manualOrder.map((e, i) => (
                    <div key={e.id} className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] last:border-0">
                      <span className="text-[11px] text-[var(--text-muted)] w-5 flex-shrink-0">{i + 1}</span>
                      <span className="flex-1 font-rajdhani text-[13px] font-semibold text-[var(--text-primary)] truncate">{e.player.tag}</span>
                      <button
                        onClick={() => moveSeed(i, -1)}
                        disabled={i === 0}
                        className="w-6 h-6 rounded text-[12px]"
                        style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border)", cursor: i === 0 ? "not-allowed" : "pointer", opacity: i === 0 ? 0.4 : 1 }}
                      >
                        ↑
                      </button>
                      <button
                        onClick={() => moveSeed(i, 1)}
                        disabled={i === manualOrder.length - 1}
                        className="w-6 h-6 rounded text-[12px]"
                        style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border)", cursor: i === manualOrder.length - 1 ? "not-allowed" : "pointer", opacity: i === manualOrder.length - 1 ? 0.4 : 1 }}
                      >
                        ↓
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

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
