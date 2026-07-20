// components/DeleteEventButton.tsx
// Creator/manager-gated — explicitly allowed even with tournaments still
// linked (no block); linked tournaments just fall back to their own
// address/logo/Twitch fields via the Tournament field-resolver overrides.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DeleteEventButton({ eventId, canManage }: { eventId: string; canManage: boolean }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  if (!canManage) return null;

  async function handleDelete() {
    if (!confirm("Delete this event? Tournaments linked to it will keep running, but will no longer share its logo/location/Twitch link. This cannot be undone.")) {
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation DeleteEvent($id: ID!) { deleteEvent(id: $id) }`,
          variables: { id: eventId },
        }),
      });
      const json = await res.json();
      if (json.errors) {
        alert(json.errors[0]?.message ?? "Failed to delete event");
        setLoading(false);
      } else {
        router.push("/events");
      }
    } catch {
      alert("Something went wrong. Try again.");
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleDelete}
      disabled={loading}
      className="font-rajdhani text-[13px] font-bold tracking-wide px-3 py-1.5 rounded"
      style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.2)", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
    >
      {loading ? "Deleting..." : "Delete event"}
    </button>
  );
}
