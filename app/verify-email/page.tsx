// app/verify-email/page.tsx
// Handles the link from the registration verification email. Same
// Suspense-wrapped useSearchParams pattern as reset-password/page.tsx.
"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

function VerifyEmailInner() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [status, setStatus] = useState<"pending" | "success" | "error">("pending");
  const [error, setError] = useState("");
  const [resendEmail, setResendEmail] = useState("");
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSubmitted, setResendSubmitted] = useState(false);

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setError("This verification link is missing its token.");
      return;
    }

    (async () => {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
      try {
        const res = await fetch(`${baseUrl}/api/graphql`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `mutation VerifyEmail($token: String!) { verifyEmail(token: $token) }`,
            variables: { token },
          }),
        });
        const json = await res.json();
        if (json.errors) {
          setStatus("error");
          setError(json.errors[0]?.message ?? "Something went wrong. Please try again.");
        } else {
          setStatus("success");
        }
      } catch {
        setStatus("error");
        setError("Something went wrong. Please try again.");
      }
    })();
  }, [token]);

  async function handleResend(e: React.FormEvent) {
    e.preventDefault();
    setResendLoading(true);
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
    await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `mutation ResendVerificationEmail($email: String!) { resendVerificationEmail(email: $email) }`,
        variables: { email: resendEmail },
      }),
    });
    setResendLoading(false);
    setResendSubmitted(true);
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="font-rajdhani text-3xl font-bold text-[var(--text-primary)] mb-1">Verify your email</h1>

        <div className="fgc-card p-6 mt-8">
          {status === "pending" && (
            <p className="text-[13px] text-[var(--text-secondary)]">Verifying...</p>
          )}

          {status === "success" && (
            <>
              <p className="text-[13px] text-[var(--text-secondary)] mb-4">
                Your email is verified. You can now sign in.
              </p>
              <Link
                href="/login"
                className="block w-full text-center py-2.5 rounded-md font-rajdhani text-[15px] font-bold tracking-wide"
                style={{ background: "var(--blue)", color: "white" }}
              >
                Sign in
              </Link>
            </>
          )}

          {status === "error" && (
            <>
              <p className="text-[12px] mb-4 px-3 py-2 rounded" style={{ background: "var(--coral-dim)", color: "var(--coral)" }}>
                {error}
              </p>

              {resendSubmitted ? (
                <p className="text-[13px] text-[var(--text-secondary)]">
                  If that email needs verifying, a new link has been sent.
                </p>
              ) : (
                <form onSubmit={handleResend}>
                  <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">
                    Resend verification email
                  </label>
                  <input
                    type="email"
                    value={resendEmail}
                    onChange={e => setResendEmail(e.target.value)}
                    required
                    placeholder="you@example.com"
                    className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)] mb-3"
                    style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                  />
                  <button
                    type="submit"
                    disabled={resendLoading}
                    className="w-full py-2.5 rounded-md font-rajdhani text-[15px] font-bold tracking-wide transition-opacity"
                    style={{ background: "var(--blue)", color: "white", opacity: resendLoading ? 0.6 : 1 }}
                  >
                    {resendLoading ? "Sending..." : "Resend link"}
                  </button>
                </form>
              )}
            </>
          )}
        </div>

        <p className="text-center text-[12px] text-[var(--text-secondary)] mt-4">
          <Link href="/login" className="text-[var(--blue)] hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailInner />
    </Suspense>
  );
}
