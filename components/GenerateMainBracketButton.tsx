// components/GenerateMainBracketButton.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ManualBracketSlotSeeder } from "@/components/ManualBracketSlotSeeder";

// MANUAL_BRACKET is intentionally distinct from generateBracket's MANUAL —
// see lib/bracket.ts's SeedingMethod comment. There's no ranked-list MANUAL
// option here at all (this button never had one), just the new drag-into-
// bracket-slots method alongside the 2 existing pairing-based methods.
type MainSeedingMethod = "RANDOM" | "AVOID_SAME_POOL" | "MANUAL_BRACKET";

const SEEDING_LABELS: Record<MainSeedingMethod, string> = {
  RANDOM: "Fully random",
  AVOID_SAME_POOL: "Avoid same-pool matchups early",
  MANUAL_BRACKET: "Manual (drag into bracket)",
};

// Smallest power of two >= n — mirrors lib/bracket.ts's nextPowerOfTwo, but
// duplicated here rather than imported since that module pulls in
// server-only Mongoose models and shouldn't end up in a client bundle.
function nextPowerOfTwo(n: number): number {
  let size = 1;
  while (size < n) size *= 2;
  return size;
}

export function GenerateMainBracketButton({
  tournamentId,
  allPoolsComplete,
  canManage,
  poolAdvancerParticipants,
}: {
  tournamentId: string;
  allPoolsComplete: boolean;
  canManage: boolean;
  // The real 2 advancers/pool (winners-finalist + losers-finalist), computed
  // client-side from data already on the page (PoolsSection.tsx's
  // allPoolAdvancerParticipants) — only needed to render the MANUAL_BRACKET
  // seeder's sidebar with real tags; every other seeding method ignores it.
  poolAdvancerParticipants: { playerId: string; tag: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [seedingMethod, setSeedingMethod] = useState<MainSeedingMethod>("AVOID_SAME_POOL");
  const [manualSlots, setManualSlots] = useState<(string | null)[]>(() =>
    Array(nextPowerOfTwo(poolAdvancerParticipants.length)).fill(null)
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!canManage) return null;
  if (!allPoolsComplete) return null;

  const unplacedCount = poolAdvancerParticipants.length - manualSlots.filter(Boolean).length;

  function openModal() {
    setManualSlots(Array(nextPowerOfTwo(poolAdvancerParticipants.length)).fill(null));
    setError("");
    setOpen(true);
  }

  async function handleGenerate() {
    if (seedingMethod === "MANUAL_BRACKET" && unplacedCount > 0) {
      setError(`${unplacedCount} ${unplacedCount === 1 ? "advancer is" : "advancers are"} still unplaced — drag every advancer into a slot (empty slots left over become byes).`);
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
            mutation GenerateMainBracket($tournamentId: ID!, $seedingMethod: SeedingMethod!, $manualSlotAssignment: [ID]) {
              generateMainBracket(tournamentId: $tournamentId, seedingMethod: $seedingMethod, manualSlotAssignment: $manualSlotAssignment) { id }
            }
          `,
          variables: {
            tournamentId,
            seedingMethod,
            manualSlotAssignment: seedingMethod === "MANUAL_BRACKET" ? manualSlots : null,
          },
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
        onClick={openModal}
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
          <div
            className={`fgc-card p-6 w-full flex flex-col ${seedingMethod === "MANUAL_BRACKET" ? "max-w-3xl" : "max-w-sm"}`}
            style={seedingMethod === "MANUAL_BRACKET" ? { maxHeight: "90vh" } : undefined}
            onClick={e => e.stopPropagation()}
          >
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

            {seedingMethod === "MANUAL_BRACKET" && (
              <div className="mb-4 overflow-y-auto flex-1 min-h-0">
                <p className="text-[11px] text-[var(--text-secondary)] mb-3">
                  Drag each pool advancer into a Round 1 slot. Slots left empty become real byes — drag a placed advancer back onto the sidebar (or use ×) to unplace them.
                </p>
                <ManualBracketSlotSeeder
                  participants={poolAdvancerParticipants}
                  slots={manualSlots}
                  onSlotsChange={setManualSlots}
                />
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
                disabled={loading || (seedingMethod === "MANUAL_BRACKET" && unplacedCount > 0)}
                className="flex-1 py-2 rounded font-rajdhani text-[14px] font-bold"
                style={{
                  background: "var(--blue)",
                  color: "white",
                  border: "none",
                  cursor: loading || (seedingMethod === "MANUAL_BRACKET" && unplacedCount > 0) ? "not-allowed" : "pointer",
                  opacity: loading || (seedingMethod === "MANUAL_BRACKET" && unplacedCount > 0) ? 0.6 : 1,
                }}
              >
                {loading ? "Generating..." : seedingMethod === "MANUAL_BRACKET" && unplacedCount > 0 ? `${unplacedCount} unplaced` : "Generate"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
