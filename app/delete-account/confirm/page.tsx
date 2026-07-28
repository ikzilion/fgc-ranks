// app/delete-account/confirm/page.tsx
// Handles the link from the account-deletion confirmation email. Same
// Suspense-wrapped useSearchParams pattern as verify-email/reset-password —
// token-only, no login required to use the link (same precedent as
// reset-password). Grace-period account deletion (settled July 28, 2026):
// confirming here no longer deletes the account immediately, it just starts
// the 7-day pending-deletion window (a follow-up email has the exact date +
// a cancel link).
//
// Fix (July 28, 2026, follow-up to commit 0237b3d): this page used to
// auto-redirect home a few seconds after confirming and left the current
// session signed in (reasoning at the time: the account isn't actually
// deleted yet, so why sign out). Corrected -- a player shouldn't stay in an
// active signed-in session on an account that's mid-deletion, so this signs
// the current session out right after confirming; sign-in itself is still
// allowed generally (see lib/auth.ts's authorize()), so signing back in
// later to check status or cancel from within the app still works exactly
// as designed -- this only ends THIS tab's session, not the account's
// ability to log in during the window. The confirmation state now just
// stays displayed instead of navigating away on its own.
"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { signOut } from "next-auth/react";
import Link from "next/link";

function DeleteAccountConfirmInner() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [status, setStatus] = useState<"pending" | "success" | "error">("pending");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setError("This confirmation link is missing its token.");
      return;
    }

    (async () => {
      try {
        const res = await fetch("/api/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `mutation ConfirmAccountDeletion($token: String!) { confirmAccountDeletion(token: $token) }`,
            variables: { token },
          }),
        });
        const json = await res.json();
        if (json.errors) {
          setStatus("error");
          setError(json.errors[0]?.message ?? "Something went wrong. Please try again.");
          return;
        }

        setStatus("success");
        // The account is now mid-deletion (pending window) -- end this
        // session rather than leaving the player signed in. redirect:
        // false since this page already shows the confirmation state and
        // should stay put, not navigate away.
        await signOut({ redirect: false });
      } catch {
        setStatus("error");
        setError("Something went wrong. Please try again.");
      }
    })();
  }, [token]);

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="font-rajdhani text-3xl font-bold text-[var(--text-primary)] mb-1">Delete account</h1>

        <div className="fgc-card p-6 mt-8">
          {status === "pending" && (
            <p className="text-[13px] text-[var(--text-secondary)]">Confirming...</p>
          )}

          {status === "success" && (
            <p className="text-[13px] text-[var(--text-secondary)]">
              Deletion confirmed. Your account is now scheduled for deletion in 7 days — check your email for the exact date and a link to
              cancel. You&apos;ve been signed out; you can sign back in any time before then to cancel.
            </p>
          )}

          {status === "error" && (
            <p className="text-[12px] px-3 py-2 rounded" style={{ background: "var(--coral-dim)", color: "var(--coral)" }}>
              {error}
            </p>
          )}
        </div>

        <p className="text-center text-[12px] text-[var(--text-secondary)] mt-4">
          <Link href="/" className="text-[var(--blue)] hover:underline">
            Back to homepage
          </Link>
        </p>
      </div>
    </main>
  );
}

export default function DeleteAccountConfirmPage() {
  return (
    <Suspense fallback={null}>
      <DeleteAccountConfirmInner />
    </Suspense>
  );
}
