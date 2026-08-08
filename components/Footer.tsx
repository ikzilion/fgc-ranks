// components/Footer.tsx
//
// First footer this site has had (Aug 2026) -- added specifically to give
// the Termly cookie-consent banner (see components/TermlyCMP.tsx) a
// persistent, visible way for a visitor to reopen their consent choices
// after initially dismissing the banner, per Termly's own convention: any
// element with the exact class "termly-display-preferences" is
// auto-wired by Termly's script (loaded via TermlyCMP) to reopen the
// preference center -- no click handler needed on our side. Deliberately
// minimal (not a full sitemap/link-farm footer) since that wasn't asked
// for and isn't needed yet -- this exists to host that one link, styled
// like the site's existing small muted-utility-text convention (e.g.
// PoolsSection.tsx's entrant counts), not as a prominent call-to-action.
"use client";

import { usePathname } from "next/navigation";

export function Footer() {
  const pathname = usePathname();

  // Same reasoning as Navbar.tsx: the OBS broadcast view is meant to be a
  // clean, chrome-free capture source.
  if (pathname.endsWith("/stream")) return null;

  return (
    <footer style={{ borderTop: "1px solid var(--border)" }}>
      <div style={{ maxWidth: "80rem", margin: "0 auto", padding: "1rem" }} className="text-[11px] text-[var(--text-muted)]">
        {/* href="#" is Termly's own documented snippet, verbatim -- their
            script intercepts the click, the href itself is never followed. */}
        <a href="#" className="termly-display-preferences hover:text-[var(--text-secondary)]">
          Consent Preferences
        </a>
      </div>
    </footer>
  );
}
