// components/RequestTOButton.tsx
// TO permission overhaul — "Request TO status" control for a player's own
// profile. Renders one of four states: already-TO badge, pending-request
// badge, post-rejection cooldown message, or the actual request button +
// modal — all server-enforced too (requestTOStatus resolver re-checks
// every one of these), this is just the matching UI reflection.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
// Basic (not exhaustive) format check, mirrored server-side in the
// requestTOStatus resolver — the real enforcement, since this client-side
// check alone can be bypassed by a direct API call.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface MyTORequest {
  status: "PENDING" | "APPROVED" | "REJECTED";
  resolvedAt?: string | null;
}

export function RequestTOButton({ isTO, myRequest }: { isTO: boolean; myRequest: MyTORequest | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [contactEmail, setContactEmail] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (isTO) {
    // Granted-status UI (settled) — a green indicator once TO status is
    // granted (either path: request/approval or a direct admin grant),
    // replacing the now-irrelevant request button entirely rather than
    // just disabling it.
    return (
      <span
        className="text-[11px] font-bold uppercase px-2 py-1 rounded"
        style={{ background: "var(--green-dim)", color: "var(--green)", border: "1px solid rgba(58,199,120,0.2)" }}
      >
        ✓ TO
      </span>
    );
  }

  if (myRequest?.status === "PENDING") {
    return (
      <span
        className="text-[11px] font-semibold px-3 py-1.5 rounded"
        style={{ background: "var(--navy-4)", color: "var(--text-muted)", border: "1px solid var(--border-strong)" }}
      >
        Request pending
      </span>
    );
  }

  let cooldownUntil: Date | null = null;
  if (myRequest?.status === "REJECTED" && myRequest.resolvedAt) {
    const until = new Date(myRequest.resolvedAt).getTime() + COOLDOWN_MS;
    if (Date.now() < until) cooldownUntil = new Date(until);
  }

  if (cooldownUntil) {
    return (
      <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
        TO request rejected — you can request again on {cooldownUntil.toLocaleDateString()}.
      </span>
    );
  }

  const isEmailValid = EMAIL_REGEX.test(contactEmail.trim());

  async function handleSubmit() {
    if (!isEmailValid) {
      setError("Please enter a valid contact email.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation RequestTOStatus($contactEmail: String!, $reason: String) { requestTOStatus(contactEmail: $contactEmail, reason: $reason) { id status } }`,
          variables: { contactEmail: contactEmail.trim(), reason: reason.trim() || undefined },
        }),
      });
      const json = await res.json();
      if (json.errors) {
        setError(json.errors[0]?.message ?? "Failed to submit request");
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
        onClick={() => setOpen(true)}
        className="text-[11px] font-semibold px-3 py-1.5 rounded"
        style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)", cursor: "pointer" }}
      >
        Request TO status
      </button>

      {open && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 px-4"
          style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={() => setOpen(false)}
        >
          <div className="fgc-card p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h2 className="font-rajdhani text-xl font-bold text-[var(--text-primary)] mb-1">Request TO status</h2>
            <p className="text-[12px] text-[var(--text-secondary)] mb-4">
              Lets you create full tournaments — public visibility, stream background/sponsor banner, and ranked points. An admin will review your request.
            </p>

            <div className="mb-4">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Contact email (required)</label>
              <input
                type="email"
                value={contactEmail}
                onChange={e => setContactEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
              />
              <p className="text-[11px] text-[var(--text-muted)] mt-1">So the reviewing admin can reach you if needed.</p>
            </div>

            <div className="mb-4">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Reason (optional)</label>
              <textarea
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="Let the admin know why you're requesting TO status…"
                rows={3}
                className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
              />
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
                onClick={handleSubmit}
                disabled={loading || !isEmailValid}
                className="flex-1 py-2 rounded font-rajdhani text-[14px] font-bold"
                style={{ background: "var(--blue)", color: "white", border: "none", cursor: loading || !isEmailValid ? "not-allowed" : "pointer", opacity: loading || !isEmailValid ? 0.6 : 1 }}
              >
                {loading ? "Submitting..." : "Submit request"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
