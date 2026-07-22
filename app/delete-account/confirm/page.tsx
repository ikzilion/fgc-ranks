// app/delete-account/confirm/page.tsx
// Handles the link from the account-deletion confirmation email. Same
// Suspense-wrapped useSearchParams pattern as verify-email/reset-password —
// token-only, no login required to use the link (same precedent as
// reset-password). On success, signs the caller out (their session now
// belongs to a deleted account) and redirects home.
"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import Link from "next/link";

function DeleteAccountConfirmInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
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
        // The session, if any, now belongs to a deleted account — sign out
        // client-side (no redirect of its own) then send them home.
        await signOut({ redirect: false });
        setTimeout(() => router.push("/"), 2500);
      } catch {
        setStatus("error");
        setError("Something went wrong. Please try again.");
      }
    })();
  }, [token, router]);

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
              Your account has been deleted. Redirecting you home...
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
