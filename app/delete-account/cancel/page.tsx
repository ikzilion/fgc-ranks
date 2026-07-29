// app/delete-account/cancel/page.tsx
// Handles the link from the "your account is scheduled for deletion" email
// (settled July 28, 2026, grace-period account deletion). Same
// Suspense-wrapped useSearchParams pattern as delete-account/confirm —
// token-only, no login required to use the link.
"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";

function DeleteAccountCancelInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token");

  const [status, setStatus] = useState<"pending" | "success" | "error">("pending");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setError("This cancellation link is missing its token.");
      return;
    }

    (async () => {
      try {
        const res = await fetch("/api/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `mutation CancelAccountDeletion($token: String!) { cancelAccountDeletion(token: $token) }`,
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
        setTimeout(() => router.push("/"), 4000);
      } catch {
        setStatus("error");
        setError("Something went wrong. Please try again.");
      }
    })();
  }, [token, router]);

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="font-rajdhani text-3xl font-bold text-[var(--text-primary)] mb-1">Cancel deletion</h1>

        <div className="fgc-card p-6 mt-8">
          {status === "pending" && (
            <p className="text-[13px] text-[var(--text-secondary)]">Cancelling...</p>
          )}

          {status === "success" && (
            <p className="text-[13px] text-[var(--text-secondary)]">
              Deletion cancelled — your account is safe and nothing was scrubbed. Redirecting you home...
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

export default function DeleteAccountCancelPage() {
  return (
    <Suspense fallback={null}>
      <DeleteAccountCancelInner />
    </Suspense>
  );
}
