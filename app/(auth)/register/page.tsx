// app/(auth)/register/page.tsx
"use client";

import { useState } from "react";
import Link from "next/link";

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tag, setTag] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // Registration no longer auto-signs in — new accounts start unverified,
  // so signing in would just fail on the emailVerified check anyway. This
  // shows the "check your email" state instead, with a resend option.
  const [registered, setRegistered] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSubmitted, setResendSubmitted] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
      const res = await fetch(`${baseUrl}/api/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `
            mutation Register($email: String!, $password: String!, $tag: String!) {
              register(email: $email, password: $password, tag: $tag) {
                token
                user { id email }
              }
            }
          `,
          variables: { email, password, tag },
        }),
      });

      const json = await res.json();

      if (json.errors) {
        setError(json.errors[0]?.message ?? "Registration failed");
        setLoading(false);
        return;
      }

      setRegistered(true);
    } catch (err) {
      setError("Something went wrong. Please try again.");
    }

    setLoading(false);
  }

  async function handleResend() {
    setResendLoading(true);
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
    await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `mutation ResendVerificationEmail($email: String!) { resendVerificationEmail(email: $email) }`,
        variables: { email },
      }),
    });
    setResendLoading(false);
    setResendSubmitted(true);
  }

  if (registered) {
    return (
      <main className="min-h-screen flex items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <h1 className="font-rajdhani text-3xl font-bold text-[var(--text-primary)] mb-1">Check your email</h1>
          <p className="text-[13px] text-[var(--text-secondary)] mb-8">One more step before you can sign in</p>

          <div className="fgc-card p-6">
            <p className="text-[13px] text-[var(--text-secondary)] mb-4">
              We sent a verification link to <span className="text-[var(--text-primary)]">{email}</span>. Click it to
              activate your account, then sign in.
            </p>
            {resendSubmitted ? (
              <p className="text-[12px] text-[var(--text-muted)]">If needed, a new link has been sent.</p>
            ) : (
              <button
                onClick={handleResend}
                disabled={resendLoading}
                className="text-[12px] font-semibold px-3 py-2 rounded"
                style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)", cursor: resendLoading ? "not-allowed" : "pointer" }}
              >
                {resendLoading ? "Sending..." : "Resend verification email"}
              </button>
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

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="font-rajdhani text-3xl font-bold text-[var(--text-primary)] mb-1">Create account</h1>
        <p className="text-[13px] text-[var(--text-secondary)] mb-8">Join FGC Ranks and track your tournament history</p>

        <div className="fgc-card p-6">
          <form onSubmit={handleSubmit}>
            <div className="mb-4">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Player tag</label>
              <input
                type="text"
                value={tag}
                onChange={e => setTag(e.target.value)}
                required
                placeholder="MenaRD"
                className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
              />
            </div>

            <div className="mb-4">
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

            <div className="mb-6">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                placeholder="••••••••"
                minLength={8}
                className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
              />
            </div>

            {error && (
              <p className="text-[12px] mb-4 px-3 py-2 rounded" style={{ background: "var(--coral-dim)", color: "var(--coral)" }}>
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-md font-rajdhani text-[15px] font-bold tracking-wide transition-opacity"
              style={{ background: "var(--blue)", color: "white", opacity: loading ? 0.6 : 1 }}
            >
              {loading ? "Creating account..." : "Create account"}
            </button>
          </form>
        </div>

        <p className="text-center text-[12px] text-[var(--text-secondary)] mt-4">
          Already have an account?{" "}
          <Link href="/login" className="text-[var(--blue)] hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
