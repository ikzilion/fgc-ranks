// components/AdminThemeSwitcher.tsx
// SUPER_ADMIN-only site-wide color theme switcher (settled July 29, 2026,
// see lib/theme.ts) — same list-with-action-button pattern as
// AdminAccountRestoreManager/AdminUserManager's grant/revoke rows. This is
// deliberately more disruptive than those (it changes what EVERY visitor
// sees, immediately), so it gets an explicit confirm() naming both the
// target theme and that scope, same precedent as other site-wide/
// destructive-ish actions elsewhere in this app.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface ThemeOption {
  id: string;
  name: string;
}

export function AdminThemeSwitcher({ activeTheme, availableThemes }: { activeTheme: string; availableThemes: ThemeOption[] }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSelect(theme: ThemeOption) {
    if (theme.id === activeTheme) return;
    if (!confirm(`Switch the site-wide color theme to "${theme.name}"? This changes what every visitor sees immediately — not just your own view.`)) {
      return;
    }

    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation SetActiveTheme($themeId: String!) { setActiveTheme(themeId: $themeId) }`,
          variables: { themeId: theme.id },
        }),
      });
      const json = await res.json();
      if (json.errors) {
        setError(json.errors[0]?.message ?? "Failed to change the theme");
      } else {
        router.refresh();
      }
    } catch {
      setError("Something went wrong. Try again.");
    }
    setLoading(false);
  }

  return (
    <>
      <p className="text-[12px] text-[var(--text-secondary)] mb-4">
        Site-wide — applies to every visitor at once, not a per-player preference.
      </p>

      {error && (
        <p className="text-[12px] mb-4 px-3 py-2 rounded" style={{ background: "var(--coral-dim)", color: "var(--coral)" }}>
          {error}
        </p>
      )}

      <div className="fgc-card">
        {availableThemes.map(theme => {
          const active = theme.id === activeTheme;
          return (
            <div key={theme.id} className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b border-[var(--border)] last:border-0">
              <p className="font-rajdhani text-[15px] font-bold text-[var(--text-primary)]">{theme.name}</p>
              {active ? (
                <span
                  className="text-[11px] font-semibold px-3 py-1.5 rounded flex-shrink-0"
                  style={{ background: "var(--green-dim)", color: "var(--green)" }}
                >
                  Active
                </span>
              ) : (
                <button
                  onClick={() => handleSelect(theme)}
                  disabled={loading}
                  className="text-[11px] font-semibold px-3 py-1.5 rounded flex-shrink-0"
                  style={{
                    background: "var(--navy-4)",
                    color: "var(--text-secondary)",
                    border: "1px solid var(--border-strong)",
                    cursor: loading ? "not-allowed" : "pointer",
                    opacity: loading ? 0.6 : 1,
                  }}
                >
                  {loading ? "..." : "Switch to this theme"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
