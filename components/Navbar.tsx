"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { NotificationBell } from "@/components/NotificationBell";
import { isAdminOrAbove } from "@/lib/roles";
import { useScrollOverflow } from "@/lib/useScrollOverflow";

const links = [
  { href: "/", label: "News" },
  { href: "/tournaments", label: "Tournaments" },
  { href: "/games", label: "Games" },
  { href: "/events", label: "Events" },
  { href: "/players", label: "Players" },
];

export function Navbar() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const role = (session?.user as any)?.role;
  const { ref: navLinksRef, canScrollLeft, canScrollRight, onScroll } = useScrollOverflow<HTMLDivElement>();

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
      {/* flex-wrap + the nav-links div going w-full order-3 below drops the
          links onto their own full-width row on mobile, instead of being
          squeezed into whatever space is left between the logo and the
          bell/avatar and silently clipped/scrolled out of view. sm:flex-nowrap
          restores the original single-row layout once there's room for it. */}
      <div
        className="flex-wrap sm:flex-nowrap"
        style={{ maxWidth: "80rem", margin: "0 auto", padding: "0.5rem 1rem", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}
      >
        <Link href="/" className="font-rajdhani" style={{ fontSize: "20px", fontWeight: 700, letterSpacing: "0.04em", color: "var(--text-primary)", textDecoration: "none", flexShrink: 0 }}>
          FGC <span style={{ color: "var(--blue)" }}>Ranks</span>
        </Link>

        {/* relative wrapper carries the w-full/order classes (participation
            in the OUTER logo/links/icons row); the inner div is the actual
            horizontally-scrollable row the chevrons below are measuring.
            Same overflow-indicator pattern as TournamentManageTabs' tab bar
            (commit 78eb976), but checking both edges since this row -- unlike
            that tab bar, which always starts at its leftmost tab -- can be
            scrolled either direction (confirmed on a real phone: "Players"
            cut off at the left extreme, "News" cut off at the right).
            No gradient/fade, just the muted icon; pointer-events-none so
            neither chevron blocks a tap on the link underneath its edge. */}
        <div className="relative w-full order-3 sm:w-auto sm:order-none">
          <div ref={navLinksRef} onScroll={onScroll} style={{ display: "flex", gap: "4px", overflowX: "auto" }}>
            {links.map(({ href, label }) => {
              const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
              return (
                <Link key={href} href={href} style={{ fontSize: "13px", fontWeight: 500, padding: "6px 14px", borderRadius: "6px", textDecoration: "none", border: "1px solid", transition: "all 0.15s", color: active ? "var(--blue)" : "var(--text-secondary)", background: active ? "var(--blue-dim)" : "transparent", borderColor: active ? "rgba(79,142,247,0.2)" : "transparent", whiteSpace: "nowrap", flexShrink: 0 }}>
                  {label}
                </Link>
              );
            })}
            {/* Single consolidated entry point — /admin is one dashboard with
                a sub-tab for each admin tool (Review queue, Manage games,
                Manage TOs, and Admin roles for SUPER_ADMIN), replacing what
                used to be four separate nav links to four separate /admin/*
                routes. Those routes still exist and still work directly. */}
            {isAdminOrAbove(role) && (
              <Link
                href="/admin"
                style={{
                  fontSize: "13px",
                  fontWeight: 500,
                  padding: "6px 14px",
                  borderRadius: "6px",
                  textDecoration: "none",
                  border: "1px solid",
                  transition: "all 0.15s",
                  color: pathname.startsWith("/admin") ? "var(--gold)" : "var(--text-secondary)",
                  background: pathname.startsWith("/admin") ? "var(--gold-dim)" : "transparent",
                  borderColor: pathname.startsWith("/admin") ? "rgba(240,180,41,0.25)" : "transparent",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                Admin
              </Link>
            )}
          </div>

          {canScrollLeft && (
            <span className="absolute left-0 top-1/2 pointer-events-none" style={{ transform: "translateY(-50%)", color: "var(--text-muted)" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 6l-6 6 6 6" />
              </svg>
            </span>
          )}
          {canScrollRight && (
            <span className="absolute right-0 top-1/2 pointer-events-none" style={{ transform: "translateY(-50%)", color: "var(--text-muted)" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </span>
          )}
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
