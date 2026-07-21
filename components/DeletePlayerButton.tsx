// components/DeletePlayerButton.tsx
// ADMIN-only "Delete account" action on a player's profile page. Soft-delete
// (see deletePlayer resolver) — disables login and scrubs personal info, but
// keeps match/tournament history intact, so this is presented as
// irreversible-in-effect even though the Player document itself survives.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DeletePlayerButton({
  playerId,
  playerTag,
  isAdmin,
  isDeleted,
  isSelf,
}: {
  playerId: string;
  playerTag: string;
  isAdmin: boolean;
  isDeleted: boolean;
  isSelf: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  // Nothing to do once already deleted, and an admin can't delete their own
  // account here (avoids locking themselves out) — the resolver enforces
  // this too, this just keeps the button from ever offering it.
  if (!isAdmin || isDeleted || isSelf) return null;

  async function handleDelete() {
    if (
      !confirm(
        `Delete ${playerTag}'s account? This disables their login and scrubs personal info (email, avatar, region, team). Their match history and tournament results stay intact. This cannot be undone.`
      )
    ) {
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation DeletePlayer($id: ID!) { deletePlayer(id: $id) }`,
          variables: { id: playerId },
        }),
      });
      const json = await res.json();
      if (json.errors) {
        alert(json.errors[0]?.message ?? "Failed to delete account");
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
      onClick={handleDelete}
      disabled={loading}
      className="text-[11px] font-semibold px-3 py-1.5 rounded"
      style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.2)", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
    >
      {loading ? "Deleting..." : "Delete account"}
    </button>
  );
}
