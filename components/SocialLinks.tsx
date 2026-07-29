// components/SocialLinks.tsx
// Shared social-media icon row for Players and Events (settled July 28,
// 2026) — same fixed platform set (X/Twitter, Instagram, YouTube, Discord,
// TikTok) plus one generic "website/other" slot on both, so this is a
// single shared display component rather than duplicating the row per
// entity type. Distinct from twitchUrl, which stays exactly where it
// already renders on each page (with its own live-status badge) — this
// component is only the 5 fixed platforms + the generic slot.
//
// No icon library dependency exists anywhere in this codebase yet — the
// Twitch link already established emoji-as-icon as the convention instead
// (the "📺 Watch on Twitch" links), so this follows that same pattern
// rather than introducing a new dependency for it.
//
// Only platforms that actually have a link set render anything — no empty
// icon placeholders — and the whole row renders nothing at all if nothing
// is set (checked by the caller too, via the same hasAnySocialLink helper,
// so a page can decide whether to render a wrapping heading/margin around it).
//
// Each link shows its platform name alongside the icon (settled July 28,
// 2026, follow-up to commit 320e559) — the fixed platforms now use the same
// icon+label pill shape the generic "other" link already used from the
// start (it always showed its user-typed otherLinkLabel as visible text;
// only the 5 fixed platforms were icon-only before this).

interface SocialLinkFields {
  twitterUrl?: string | null;
  instagramUrl?: string | null;
  youtubeUrl?: string | null;
  discordUrl?: string | null;
  tiktokUrl?: string | null;
  otherLinkUrl?: string | null;
  otherLinkLabel?: string | null;
  // Applied to this component's own root element, only when it actually
  // renders something -- lets a caller add layout spacing (e.g. "mt-2")
  // without needing its own wrapping <div> that would otherwise render an
  // empty (if invisible) element even when there's nothing to show.
  className?: string;
}

type PlatformKey = Exclude<keyof SocialLinkFields, "otherLinkUrl" | "otherLinkLabel" | "className">;

const PLATFORMS: { key: PlatformKey; icon: string; label: string }[] = [
  { key: "twitterUrl", icon: "🐦", label: "X / Twitter" },
  { key: "instagramUrl", icon: "📸", label: "Instagram" },
  { key: "youtubeUrl", icon: "▶️", label: "YouTube" },
  { key: "discordUrl", icon: "💬", label: "Discord" },
  { key: "tiktokUrl", icon: "🎵", label: "TikTok" },
];

export function hasAnySocialLink(fields: SocialLinkFields): boolean {
  return PLATFORMS.some(p => !!fields[p.key]) || !!fields.otherLinkUrl;
}

const ICON_BADGE_STYLE = { background: "var(--navy-4)", border: "1px solid var(--border-strong)" };

export function SocialLinks({ className, ...fields }: SocialLinkFields) {
  if (!hasAnySocialLink(fields)) return null;

  return (
    <div className={`flex items-center gap-2 flex-wrap ${className ?? ""}`}>
      {PLATFORMS.map(p => {
        const url = fields[p.key];
        if (!url) return null;
        return (
          <a
            key={p.key}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title={p.label}
            aria-label={p.label}
            className="flex items-center gap-1.5 h-8 px-3 rounded-full text-[12px] font-semibold flex-shrink-0 hover:bg-[var(--navy-3)] transition-colors"
            style={{ ...ICON_BADGE_STYLE, color: "var(--text-secondary)" }}
          >
            <span>{p.icon}</span>
            <span>{p.label}</span>
          </a>
        );
      })}
      {fields.otherLinkUrl && (
        <a
          href={fields.otherLinkUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 h-8 px-3 rounded-full text-[12px] font-semibold flex-shrink-0 hover:bg-[var(--navy-3)] transition-colors"
          style={{ ...ICON_BADGE_STYLE, color: "var(--text-secondary)" }}
        >
          <span>🔗</span>
          <span>{fields.otherLinkLabel || "Link"}</span>
        </a>
      )}
    </div>
  );
}
