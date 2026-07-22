// app/(auth)/login/page.tsx
"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSubmitted, setResendSubmitted] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setNeedsVerification(false);
    setResendSubmitted(false);

    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    setLoading(false);

    if (result?.error) {
      if (result.code === "email_not_verified") {
        setError("Please verify your email before signing in.");
        setNeedsVerification(true);
      } else {
        setError(
          result.code === "rate_limited"
            ? "Too many attempts. Please try again in 15 minutes."
            : "Invalid email or password"
        );
      }
    } else {
      router.push("/tournaments");
      router.refresh();
    }
  }

  async function handleResend() {
    setResendLoading(true);
    await fetch("/api/graphql", {
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

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="font-rajdhani text-3xl font-bold text-[var(--text-primary)] mb-1">Welcome back</h1>
        <p className="text-[13px] text-[var(--text-secondary)] mb-8">Sign in to your FGC Ranks account</p>

        <div className="fgc-card p-6">
          <form onSubmit={handleSubmit}>
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

            <div className="mb-2">
              <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                placeholder="••••••••"
                className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
              />
            </div>

            <div className="mb-6 text-right">
              <Link href="/forgot-password" className="text-[12px] text-[var(--blue)] hover:underline">
                Forgot password?
              </Link>
            </div>

            {error && (
              <p className="text-[12px] mb-4 px-3 py-2 rounded" style={{ background: "var(--coral-dim)", color: "var(--coral)" }}>
                {error}
              </p>
            )}

            {needsVerification && (
              resendSubmitted ? (
                <p className="text-[12px] text-[var(--text-muted)] mb-4">If needed, a new link has been sent.</p>
              ) : (
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={resendLoading}
                  className="text-[12px] font-semibold mb-4"
                  style={{ color: "var(--blue)", background: "none", border: "none", cursor: resendLoading ? "not-allowed" : "pointer", padding: 0 }}
                >
                  {resendLoading ? "Sending..." : "Resend verification email"}
                </button>
              )
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-md font-rajdhani text-[15px] font-bold tracking-wide transition-opacity"
              style={{ background: "var(--blue)", color: "white", opacity: loading ? 0.6 : 1 }}
            >
              {loading ? "Signing in..." : "Sign in"}
            </button>
          </form>
        </div>

        <p className="text-center text-[12px] text-[var(--text-secondary)] mt-4">
          No account?{" "}
          <Link href="/register" className="text-[var(--blue)] hover:underline">
            Create one
          </Link>
        </p>
      </div>
    </main>
  );
}
