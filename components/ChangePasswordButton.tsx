// components/ChangePasswordButton.tsx
// "Change Password" trigger for a logged-in player — reuses the existing
// forgot-password/reset-via-email flow (requestPasswordReset +
// /reset-password) entirely, unchanged. No new backend logic: this just
// calls that same mutation with the logged-in player's own session email
// instead of a typed-in one, then points them at the same reset-link flow
// locked-out users already use.
"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";

interface Props {
  playerId: string;
}

export function ChangePasswordButton({ playerId }: Props) {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  // Only show on your own profile
  const isOwnProfile = (session?.user as any)?.playerId === playerId;
  if (!isOwnProfile) return null;

  const email = (session?.user as any)?.email as string | undefined;

  async function handleClick() {
    setOpen(true);
    setError("");
    setSent(false);

    if (!email) {
      setError("Couldn't determine your account email. Try signing in again.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `
            mutation RequestPasswordReset($email: String!) {
              requestPasswordReset(email: $email)
            }
          `,
          variables: { email },
        }),
      });

      const json = await res.json();

      if (json.errors) {
        setError(json.errors[0]?.message ?? "Failed to send reset email");
      } else {
        setSent(true);
      }
    } catch {
      setError("Something went wrong. Try again.");
    }

    setLoading(false);
  }

  return (
    <>
      <button
        onClick={handleClick}
        className="text-[11px] font-semibold px-3 py-1.5 rounded"
        style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)", cursor: "pointer" }}
      >
        Change password
      </button>

      {open && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 px-4"
          style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={() => setOpen(false)}
        >
          <div className="fgc-card p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h2 className="font-rajdhani text-xl font-bold text-[var(--text-primary)] mb-4">Change password</h2>

            {loading && (
              <p className="text-[13px] text-[var(--text-secondary)] mb-6">Sending...</p>
            )}

            {!loading && sent && (
              <p className="text-[13px] text-[var(--text-secondary)] mb-6">
                Check your email ({email}) for a link to reset your password.
              </p>
            )}

            {!loading && error && (
              <p className="text-[12px] mb-6 px-3 py-2 rounded" style={{ background: "var(--coral-dim)", color: "var(--coral)" }}>
                {error}
              </p>
            )}

            <button
              onClick={() => setOpen(false)}
              className="w-full py-2 rounded font-rajdhani text-[14px] font-bold"
              style={{ background: "var(--blue)", color: "white", border: "none", cursor: "pointer" }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}
