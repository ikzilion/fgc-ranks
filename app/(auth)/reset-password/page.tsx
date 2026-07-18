// app/(auth)/reset-password/page.tsx
"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords don't match");
      return;
    }

    setLoading(true);

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
    const res = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `
          mutation ResetPassword($token: String!, $newPassword: String!) {
            resetPassword(token: $token, newPassword: $newPassword)
          }
        `,
        variables: { token, newPassword: password },
      }),
    });

    const json = await res.json();
    setLoading(false);

    if (json.errors) {
      setError(json.errors[0]?.message ?? "Something went wrong. Please try again.");
      return;
    }

    setSuccess(true);
    setTimeout(() => router.push("/login"), 2000);
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="font-rajdhani text-3xl font-bold text-[var(--text-primary)] mb-1">Set new password</h1>
        <p className="text-[13px] text-[var(--text-secondary)] mb-8">Choose a new password for your account</p>

        <div className="fgc-card p-6">
          {!token ? (
            <p className="text-[12px] px-3 py-2 rounded" style={{ background: "var(--coral-dim)", color: "var(--coral)" }}>
              This reset link is missing its token. Request a new one from the{" "}
              <Link href="/forgot-password" className="underline">forgot password</Link> page.
            </p>
          ) : success ? (
            <p className="text-[13px] text-[var(--text-secondary)]">
              Password updated. Redirecting you to sign in...
            </p>
          ) : (
            <form onSubmit={handleSubmit}>
              <div className="mb-4">
                <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">New password</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  minLength={8}
                  placeholder="••••••••"
                  className="w-full px-3 py-2.5 rounded-md text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--blue)]"
                  style={{ background: "var(--navy-3)", border: "1px solid var(--border-strong)" }}
                />
              </div>

              <div className="mb-6">
                <label className="block text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Confirm password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  required
                  minLength={8}
                  placeholder="••••••••"
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
                {loading ? "Updating..." : "Update password"}
              </button>
            </form>
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

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}
