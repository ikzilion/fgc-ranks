// app/layout.tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Script from "next/script";
import { Navbar } from "@/components/Navbar";
import { SessionProvider } from "next-auth/react";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Analytics } from "@vercel/analytics/next";
import { getThemeOrDefault, ThemePalette } from "@/lib/theme";

// Google AdSense (settled Aug 2026) -- loaded once, site-wide, same
// unconditional-mount-when-configured pattern as SpeedInsights/Analytics
// below. Only the ad-request script itself; NOT the enable_page_level_ads
// call, which would turn on Auto ads (Google auto-injecting ads anywhere it
// wants, with no way to suppress them on a specific route) -- see
// components/AdSlot.tsx for why manual ad units were chosen instead.
// Renders nothing when the Publisher ID env var isn't set yet.
const ADSENSE_CLIENT_ID = process.env.NEXT_PUBLIC_ADSENSE_CLIENT_ID;

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "FGC Ranks",
  description: "Fighting Game Community tournament tracker and player records",
};

// Color theme system (settled July 29, 2026) — GraphQL, same "GraphQL for
// all data fetching" convention every page-level fetch in this app follows,
// not a direct DB/lib/theme.ts call from here. The active theme isn't
// viewer-dependent (same for every visitor) and only changes on a rare
// Super Admin action, so it doesn't need the zero-cache treatment
// viewer-scoped fetches elsewhere in this app use — same reasoning as
// app/players/[id]/page.tsx's GET_PLAYERS_FOR_PICKER fetch, which uses a
// short revalidate window for the same "global, not per-viewer" reason.
// next: {revalidate: 30} restores static/ISR rendering for every route
// under this layout (previously forced all-ƒ-dynamic by cache: "no-store"
// here) at the cost of up to a 30s staleness window on a theme switch —
// accepted tradeoff (performance audit, July 29, 2026). Revisit if a Super
// Admin ever needs a theme change to take effect instantly instead.
async function getActiveThemePalette(): Promise<ThemePalette> {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const res = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: `query { activeTheme }` }),
      next: { revalidate: 30 },
    });
    const json = await res.json();
    return getThemeOrDefault(json.data?.activeTheme);
  } catch {
    return getThemeOrDefault(undefined);
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = await getActiveThemePalette();
  // Applied as an inline style on <html> (where :root's own custom
  // properties resolve) rather than a second stylesheet or a [data-theme]
  // selector block per theme — inline style already wins CSS specificity
  // over globals.css's plain :root block, so this cleanly overrides the
  // hardcoded defaults there for every visitor without touching any
  // component. Adding a future theme is exactly and only adding another
  // entry to lib/theme.ts's THEMES object; nothing here needs to change.
  const themeStyle = {
    "--navy": theme.navy,
    "--navy-2": theme.navy2,
    "--navy-3": theme.navy3,
    "--navy-4": theme.navy4,
    "--blue": theme.blue,
    "--blue-dim": theme.blueDim,
    "--coral": theme.coral,
    "--coral-dim": theme.coralDim,
    "--gold": theme.gold,
    "--gold-dim": theme.goldDim,
    "--green": theme.green,
    "--green-dim": theme.greenDim,
    "--text-primary": theme.textPrimary,
    "--text-secondary": theme.textSecondary,
    "--text-muted": theme.textMuted,
    "--border": theme.border,
    "--border-strong": theme.borderStrong,
  } as React.CSSProperties;

  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`} style={themeStyle}>
      {/* Plain block body, not flex — every page's <main> relies on normal
          block-level auto-margin centering (max-w-4xl mx-auto). A flex
          column body would disable that: auto margins suppress flex-stretch,
          so <main> would shrink to its content width instead of filling up
          to its max-width cap (this bit Events' browse-page cards, fixed
          per-page there before the root cause here was found). */}
      <body className="min-h-full" suppressHydrationWarning>
        <SessionProvider>
          <Navbar />
          {children}
        </SessionProvider>
        {/* Real-user performance monitoring — collects zero data outside a
            real Vercel deployment (nothing in local dev), so it's safe to
            mount unconditionally here rather than gating it per-environment. */}
        <SpeedInsights />
        {/* Visitor/pageview analytics — distinct from SpeedInsights above
            (that's performance timing, this is traffic/visitor counts).
            Same zero-cost-outside-Vercel reasoning, mounted unconditionally. */}
        <Analytics />
        {ADSENSE_CLIENT_ID && (
          <Script
            async
            strategy="afterInteractive"
            src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT_ID}`}
            crossOrigin="anonymous"
          />
        )}
      </body>
    </html>
  );
}
