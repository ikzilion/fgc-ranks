// lib/useScrollOverflow.ts
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Shared by TournamentManageTabs' tab bar (right-edge only, commit 78eb976)
// and Navbar's nav-links row (both edges) -- both needed the exact same
// scrollWidth/clientWidth/scrollLeft overflow check, so this is the second
// call site rather than a premature abstraction.
export function useScrollOverflow<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const recompute = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // +1 tolerance for subpixel rounding -- without it, a row that exactly
    // fits can read as "1px of overflow" on some zoom levels.
    const hasOverflow = el.scrollWidth > el.clientWidth + 1;
    const atStart = el.scrollLeft <= 1;
    const atEnd = el.scrollLeft >= el.scrollWidth - el.clientWidth - 1;
    setCanScrollLeft(hasOverflow && !atStart);
    setCanScrollRight(hasOverflow && !atEnd);
  }, []);

  useEffect(() => {
    recompute();
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, [recompute]);

  return { ref, canScrollLeft, canScrollRight, onScroll: recompute };
}
