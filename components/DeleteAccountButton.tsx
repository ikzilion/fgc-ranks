// components/DeleteAccountButton.tsx
// Self-service "Delete my account" — visible only on your own profile.
// In-app confirm() is the FIRST safety checkpoint; the emailed confirmation
// link (app/delete-account/confirm) is the second, not a replacement for
// this one. Same soft-delete effect as the admin DeletePlayerButton, just
// reached via email confirmation instead of an immediate mutation.
//
// Grace-period account deletion (settled July 28, 2026): confirming no
// longer scrubs immediately — it schedules the scrub 7 days out. This
// component also fetches its own pending-deletion status (via `me`, not the
// session/JWT, which doesn't refresh mid-session — see CLAUDE.md) so the
// "scheduled for deletion, cancel here" state shows up even if deletion was
// confirmed via the email link in another tab/device while this page was
// already open.
"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

export function DeleteAccountButton({ playerId }: { playerId: string }) {
  const { data: session } = useSession();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [scheduledScrubAt, setScheduledScrubAt] = useState<string | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [error, setError] = useState("");

  const isOwnProfile = (session?.user as any)?.playerId === playerId;

  useEffect(() => {
    if (!isOwnProfile) return;
    (async () => {
      try {
        const res = await fetch("/api/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: `query MyDeletionStatus { me { scheduledScrubAt } }` }),
        });
        const json = await res.json();
        setScheduledScrubAt(json.data?.me?.scheduledScrubAt ?? null);
      } catch {
        // Fails open to "not pending" — worst case the banner just doesn't
        // show up until a refresh, not a blocking error for the whole page.
      }
      setStatusLoaded(true);
    })();
  }, [isOwnProfile]);

  if (!isOwnProfile) return null;

  async function handleRequest() {
    if (
      !confirm(
        "Delete your account? We'll email you a confirmation link — clicking it schedules your account for deletion in 7 days (not immediately). You can cancel any time in that window, either from a link in the follow-up email or by signing back in here. Once the 7 days pass, your login is disabled and your personal info (email, avatar, region, team) is scrubbed. Your match history and tournament results stay intact either way."
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
        // deleteAccountRequestRateLimit (lib/rateLimit.ts) rejections get the
        // same friendly, distinct wording used elsewhere in the app instead
        // of the raw resolver text -- any other error still surfaces its
        // real specific message.
        alert(
          json.errors[0]?.extensions?.code === "RATE_LIMITED"
            ? "Too many attempts — please wait a few minutes and try again."
            : json.errors[0]?.message ?? "Failed to request account deletion"
        );
      } else {
        setSent(true);
      }
    } catch {
      alert("Something went wrong. Try again.");
    }

    setLoading(false);
  }

  async function handleCancel() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: `mutation CancelMyPendingDeletion { cancelMyPendingDeletion }` }),
      });
      const json = await res.json();
      if (json.errors) {
        setError(json.errors[0]?.message ?? "Something went wrong. Try again.");
      } else {
        setScheduledScrubAt(null);
        router.refresh();
      }
    } catch {
      setError("Something went wrong. Try again.");
    }
    setLoading(false);
  }

  // Pending-deletion state (from a real confirmed request, possibly from a
  // different tab/device) takes over this whole widget — the plain "Delete
  // my account" button doesn't make sense to show alongside it.
  if (statusLoaded && scheduledScrubAt) {
    return (
      <div className="text-[11px] px-3 py-2 rounded max-w-xs" style={{ background: "var(--coral-dim)", color: "var(--coral)", border: "1px solid rgba(255,77,77,0.2)" }}>
        <p className="mb-2">
          Your account is scheduled for deletion on <strong>{new Date(scheduledScrubAt).toLocaleDateString()}</strong>.
        </p>
        <button
          onClick={handleCancel}
          disabled={loading}
          className="font-semibold px-3 py-1.5 rounded"
          style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)", cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
        >
          {loading ? "Cancelling..." : "Cancel deletion"}
        </button>
        {error && <p className="mt-2">{error}</p>}
      </div>
    );
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
