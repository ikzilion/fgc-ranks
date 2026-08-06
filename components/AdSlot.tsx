// components/AdSlot.tsx
"use client";

import { useEffect, useRef } from "react";

const ADSENSE_CLIENT_ID = process.env.NEXT_PUBLIC_ADSENSE_CLIENT_ID;
const ADSENSE_SLOT_ID = process.env.NEXT_PUBLIC_ADSENSE_SLOT_ID;

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

// Site-wide Google AdSense placement (settled Aug 2026). Manual ad unit, not
// Auto ads -- Auto ads are injected globally by Google's own script with no
// per-route control, which would make it impossible to suppress ads on a
// TO's own tournament management view (see app/tournaments/[id]/page.tsx's
// canManage-gated usage of this component). Every placement site-wide reuses
// this same one ad unit/slot id -- reusing a single AdSense ad unit across
// many pages of a site is standard practice; it's placing MULTIPLE units on
// the SAME page that AdSense's policies frown on, which nothing here does.
//
// Renders nothing at all (no container, no script call, no layout shift)
// when either env var is unset -- lets this ship structurally ahead of a
// real AdSense account/Publisher ID existing, and keeps degrading safely if
// the env var is ever unset later. See app/layout.tsx for the matching
// conditional adsbygoogle.js <Script> load and app/ads.txt/route.ts for the
// site-verification file, both gated the same way.
export function AdSlot({ className = "" }: { className?: string }) {
  const pushedRef = useRef(false);

  useEffect(() => {
    if (!ADSENSE_CLIENT_ID || !ADSENSE_SLOT_ID) return;
    // StrictMode/re-render guard -- push() registers this <ins> for a fetch;
    // calling it twice for the same element throws "already have ads in it".
    if (pushedRef.current) return;
    pushedRef.current = true;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (err) {
      console.error("[AdSlot] adsbygoogle push error:", err);
    }
  }, []);

  if (!ADSENSE_CLIENT_ID || !ADSENSE_SLOT_ID) return null;

  return (
    <div className={className}>
      <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">Advertisement</p>
      <div className="fgc-card p-2 flex items-center justify-center" style={{ minHeight: 100 }}>
        <ins
          className="adsbygoogle"
          style={{ display: "block", width: "100%" }}
          data-ad-client={ADSENSE_CLIENT_ID}
          data-ad-slot={ADSENSE_SLOT_ID}
          data-ad-format="auto"
          data-full-width-responsive="true"
        />
      </div>
    </div>
  );
}
