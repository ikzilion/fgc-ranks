"use client";

// components/Navbar.tsx
// Top navigation bar with FGC.HUB branding, nav links, and active state.

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/tournaments", label: "Tournaments" },
  { href: "/players",     label: "Players" },
];

export function Navbar() {
  const pathname = usePathname();

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
      <div
        style={{
          maxWidth: "80rem",
          margin: "0 auto",
          padding: "0 1rem",
          height: "52px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        {/* Brand */}
        <Link
          href="/tournaments"
          className="font-rajdhani"
          style={{
            fontSize: "22px",
            fontWeight: 700,
            letterSpacing: "0.04em",
            color: "var(--text-primary)",
            textDecoration: "none",
          }}
        >
          FGC<span style={{ color: "var(--blue)" }}>.</span>HUB
        </Link>

        {/* Nav links */}
        <div style={{ display: "flex", gap: "4px" }}>
          {links.map(({ href, label }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                style={{
                  fontSize: "13px",
                  fontWeight: 500,
                  letterSpacing: "0.02em",
                  padding: "6px 14px",
                  borderRadius: "6px",
                  textDecoration: "none",
                  border: "1px solid",
                  transition: "all 0.15s",
                  color:       active ? "var(--blue)"         : "var(--text-secondary)",
                  background:  active ? "var(--blue-dim)"     : "transparent",
                  borderColor: active ? "rgba(79,142,247,0.2)" : "transparent",
                }}
              >
                {label}
              </Link>
            );
          })}
        </div>

        {/* Right side — placeholder avatar (wire up to session later) */}
        <div
          style={{
            width: "30px",
            height: "30px",
            borderRadius: "50%",
            background: "var(--blue-dim)",
            border: "1px solid rgba(79,142,247,0.3)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "11px",
            fontWeight: 700,
            color: "var(--blue)",
            cursor: "pointer",
            fontFamily: "'Rajdhani', sans-serif",
          }}
        >
          ?
        </div>
      </div>
    </nav>
  );
}
