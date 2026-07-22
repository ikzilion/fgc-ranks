// app/(auth)/forgot-password/page.tsx
"use client";

import { useState } from "react";
import Link from "next/link";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    await fetch("/api/graphql", {
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

    // Always show the same success state regardless of whether the email
    // exists — the resolver returns true either way, so this can't be used
    // to enumerate registered accounts.
    setLoading(false);
    setSubmitted(true);
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="font-rajdhani text-3xl font-bold text-[var(--text-primary)] mb-1">Reset password</h1>
        <p className="text-[13px] text-[var(--text-secondary)] mb-8">
          Enter your email and we&apos;ll send you a reset link
        </p>

        <div className="fgc-card p-6">
          {submitted ? (
            <p className="text-[13px] text-[var(--text-secondary)]">
              If an account exists for <span className="text-[var(--text-primary)]">{email}</span>, a password reset
              link has been sent. Check your inbox.
            </p>
          ) : (
            <form onSubmit={handleSubmit}>
              <div className="mb-6">
                <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  placeholder="you@example.com"
                  className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                  style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 rounded-md font-rajdhani text-[15px] font-bold tracking-wide transition-opacity"
                style={{ background: "var(--blue)", color: "white", opacity: loading ? 0.6 : 1 }}
              >
                {loading ? "Sending..." : "Send reset link"}
              </button>
            </form>
          )}
        </div>

        <p className="text-center text-[12px] text-[var(--text-secondary)] mt-4">
          Remembered your password?{" "}
          <Link href="/login" className="text-[var(--blue)] hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
