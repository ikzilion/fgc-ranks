// app/layout.tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Navbar } from "@/components/Navbar";
import { SessionProvider } from "next-auth/react";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { getThemeOrDefault, ThemePalette } from "@/lib/theme";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "FGC Ranks",
  description: "Fighting Game Community tournament tracker and player records",
};

// Color theme system (settled July 29, 2026) — GraphQL, same "GraphQL for
// all data fetching" convention every page-level fetch in this app follows,
// not a direct DB/lib/theme.ts call from here. cache: "no-store" since the
// active theme can change at any moment via the admin switcher and needs to
// take effect immediately, site-wide, on the very next request — this does
// mean the root layout (and therefore every route under it) renders
// dynamically rather than statically now, an accepted tradeoff at this
// app's traffic scale for always-correct theming over shaving a few
// otherwise-static auth pages down to edge-cached HTML.
async function getActiveThemePalette(): Promise<ThemePalette> {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const res = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: `query { activeTheme }` }),
      cache: "no-store",
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
      </body>
    </html>
  );
}
