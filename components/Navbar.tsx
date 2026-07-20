"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { NotificationBell } from "@/components/NotificationBell";

const links = [
  { href: "/", label: "News" },
  { href: "/tournaments", label: "Tournaments" },
  { href: "/events", label: "Events" },
  { href: "/players", label: "Players" },
];

export function Navbar() {
  const pathname = usePathname();
  const { data: session } = useSession();

  // The stream/broadcast view (/tournaments/[id]/stream) is meant to be
  // captured as a clean OBS browser source — no site chrome at all. There's
  // no route-group split for a separate chromeless root layout here, so this
  // is the pragmatic way to keep it a single page without restructuring
  // every other route into a parallel layout tree for one page.
  if (pathname.endsWith("/stream")) return null;

  return (
    <nav
      className="scanline"
      style={{
        background: "var(--navy-2)",
        borderBottom: "1px solid var(--border)",
        position: "sticky",
        top: 0,
        zIndex: 50,
      }}
    >
      <div style={{ maxWidth: "80rem", margin: "0 auto", padding: "0 1rem", height: "52px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
        <Link href="/" className="font-rajdhani" style={{ fontSize: "20px", fontWeight: 700, letterSpacing: "0.04em", color: "var(--text-primary)", textDecoration: "none", flexShrink: 0 }}>
          FGC <span style={{ color: "var(--blue)" }}>Ranks</span>
        </Link>

        <div style={{ display: "flex", gap: "4px", overflowX: "auto" }}>
          {links.map(({ href, label }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link key={href} href={href} style={{ fontSize: "13px", fontWeight: 500, padding: "6px 14px", borderRadius: "6px", textDecoration: "none", border: "1px solid", transition: "all 0.15s", color: active ? "var(--blue)" : "var(--text-secondary)", background: active ? "var(--blue-dim)" : "transparent", borderColor: active ? "rgba(79,142,247,0.2)" : "transparent" }}>
                {label}
              </Link>
            );
          })}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <NotificationBell />
          {session?.user ? (
            <>
              <Link
                href={`/players/${(session.user as any).playerId}`}
                style={{ width: "30px", height: "30px", borderRadius: "50%", background: "var(--blue-dim)", border: "1px solid rgba(79,142,247,0.3)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px", fontWeight: 700, color: "var(--blue)", fontFamily: "'Rajdhani', sans-serif", textDecoration: "none", cursor: "pointer", overflow: "hidden" }}
              >
                {(session.user as any).avatarUrl ? (
                  <img src={(session.user as any).avatarUrl} alt="avatar" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  (session.user as any).tag?.slice(0, 2).toUpperCase() ?? session.user.email?.slice(0, 2).toUpperCase()
                )}
              </Link>
              <button
                onClick={() => signOut({ callbackUrl: "/login" })}
                style={{ fontSize: "12px", color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
              >
                Sign out
              </button>
            </>
          ) : (
            <Link href="/login" style={{ fontSize: "13px", fontWeight: 500, padding: "6px 14px", borderRadius: "6px", textDecoration: "none", border: "1px solid rgba(79,142,247,0.2)", color: "var(--blue)", background: "var(--blue-dim)" }}>
              Sign in
            </Link>
          )}
        </div>
      </div>
    </nav>
  );
}
