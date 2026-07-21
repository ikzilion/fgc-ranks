// components/DeleteAccountButton.tsx
// Self-service "Delete my account" — visible only on your own profile.
// In-app confirm() is the FIRST safety checkpoint; the emailed confirmation
// link (app/delete-account/confirm) is the second, not a replacement for
// this one. Same soft-delete effect as the admin DeletePlayerButton, just
// reached via email confirmation instead of an immediate mutation.
"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";

export function DeleteAccountButton({ playerId }: { playerId: string }) {
  const { data: session } = useSession();
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const isOwnProfile = (session?.user as any)?.playerId === playerId;
  if (!isOwnProfile) return null;

  async function handleRequest() {
    if (
      !confirm(
        "Delete your account? We'll email you a confirmation link — clicking it disables your login and scrubs your personal info (email, avatar, region, team). Your match history and tournament results stay intact. This cannot be undone."
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
          query: `mutation RequestAccountDeletion { requestAccountDeletion }`,
        }),
      });
      const json = await res.json();
      if (json.errors) {
        alert(json.errors[0]?.message ?? "Failed to request account deletion");
      } else {
        setSent(true);
      }
    } catch {
      alert("Something went wrong. Try again.");
    }

    setLoading(false);
  }

  if (sent) {
    return (
      <p className="text-[11px] text-[var(--text-muted)]">
        Check your email to confirm deletion.
      </p>
    );
  }

  return (
    <button
      onClick={handleRequest}
      disabled={loading}
      className="text-[11px] font-semibold px-3 py-1.5 rounded"
      style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.2)", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
    >
      {loading ? "Sending..." : "Delete my account"}
    </button>
  );
}
