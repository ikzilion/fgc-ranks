// components/ZoomableAvatar.tsx
"use client";

import { useState } from "react";

interface Props {
  avatarUrl?: string | null;
  tag: string;
  // Sizing/font classes passed in so this matches each call site's existing
  // layout exactly (profile page's big w-16 h-16 header avatar vs
  // PlayerCard's compact w-12 h-12 one) — background/border/text color stay
  // fixed since both current call sites already share the same values.
  sizeClassName: string;
  textClassName: string;
}

const AVATAR_STYLE = { background: "var(--blue-dim)", border: "2px solid rgba(79,142,247,0.4)", color: "var(--blue)" };

export function ZoomableAvatar({ avatarUrl, tag, sizeClassName, textClassName }: Props) {
  const [open, setOpen] = useState(false);
  const baseClassName = `${sizeClassName} rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden font-rajdhani font-bold ${textClassName}`;

  // No avatar set — nothing to zoom into, so this stays a plain non-
  // interactive initials div, same as before this feature existed.
  if (!avatarUrl) {
    return (
      <div className={baseClassName} style={AVATAR_STYLE}>
        {tag.slice(0, 2).toUpperCase()}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`View ${tag}'s full avatar`}
        className={`${baseClassName} p-0 cursor-pointer hover:opacity-80 transition-opacity`}
        style={AVATAR_STYLE}
      >
        <img src={avatarUrl} alt={tag} className="w-full h-full object-cover" />
      </button>

      {open && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 px-4"
          style={{ background: "rgba(0,0,0,0.8)" }}
          onClick={() => setOpen(false)}
        >
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="absolute top-4 right-4 w-9 h-9 rounded-full flex items-center justify-center text-lg font-bold cursor-pointer"
            style={{ background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)" }}
          >
            ✕
          </button>
          {/* Capped rather than shown at native resolution — some avatars
              could be much larger than needed here. stopPropagation so a
              click on the image itself doesn't also trigger the overlay's
              close handler. */}
          <img
            src={avatarUrl}
            alt={tag}
            className="rounded-lg object-contain"
            style={{ maxWidth: "min(90vw, 480px)", maxHeight: "80vh" }}
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
