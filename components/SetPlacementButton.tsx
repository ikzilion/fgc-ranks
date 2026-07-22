// components/SetPlacementButton.tsx
// Lets a tournament organizer/admin record an entrant's final placement
// (1 = champion, 2 = runner-up, etc.) — feeds the ranking points system
// (see lib/ranking.ts), which reads Entrant.placement directly.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function SetPlacementButton({
  entrantId,
  placement,
  canManage,
}: {
  entrantId: string;
  placement?: number | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(placement ? String(placement) : "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!canManage) return null;

  async function handleSave() {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      setError("Enter a whole number, 1 or higher.");
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
            mutation SetPlacement($entrantId: ID!, $placement: Int!) {
              setPlacement(entrantId: $entrantId, placement: $placement) {
                id
              }
            }
          `,
          variables: { entrantId, placement: parsed },
        }),
      });

      const json = await res.json();
      if (json.errors) {
        setError(json.errors[0]?.message ?? "Failed to save placement");
      } else {
        setEditing(false);
        router.refresh();
      }
    } catch {
      setError("Something went wrong. Try again.");
    }

    setLoading(false);
  }

  if (!editing) {
    return (
      <button
        onClick={() => {
          setValue(placement ? String(placement) : "");
          setError("");
          setEditing(true);
        }}
        className="text-[11px] font-semibold px-2 py-1 rounded flex-shrink-0"
        style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border)", cursor: "pointer" }}
      >
        {placement ? "Edit placement" : "Set placement"}
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1 flex-shrink-0">
      <div className="flex items-center gap-1">
        <input
          type="number"
          min={1}
          value={value}
          onChange={e => setValue(e.target.value)}
          className="w-14 text-[12px] px-2 py-1 rounded"
          style={{ background: "var(--navy-4)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
          autoFocus
        />
        <button
          onClick={handleSave}
          disabled={loading}
          className="text-[11px] font-semibold px-2 py-1 rounded"
          style={{ background: "var(--blue)", color: "white", border: "none", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
        >
          {loading ? "..." : "Save"}
        </button>
        <button
          onClick={() => setEditing(false)}
          className="text-[11px] font-semibold px-2 py-1 rounded"
          style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border)", cursor: "pointer" }}
        >
          Cancel
        </button>
      </div>
      {error && (
        <p className="text-[11px] px-2 py-1 rounded" style={{ background: "var(--coral-dim)", color: "var(--coral)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
