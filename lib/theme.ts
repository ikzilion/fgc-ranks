// lib/theme.ts
// Site-wide color theme system (settled July 29, 2026, see the Notion
// "Color theme system" writeup) -- ONE active theme applies to every
// visitor at once (not a per-player preference: no localStorage, no
// Player/User schema field). Only a Super Admin can change it
// (setActiveTheme resolver, graphql/resolvers/index.ts).
//
// Extensible by design: adding a future seasonal/event theme is just adding
// another entry to THEMES below (same CSS custom property keys
// app/globals.css's own :root block already defines) -- nothing structural
// to change. app/layout.tsx reads the active theme id (via the public
// activeTheme GraphQL query, same "GraphQL for all data fetching"
// convention every other page follows) and applies the resolved palette as
// an inline style on <html>, which -- by ordinary CSS specificity --
// overrides globals.css's own :root block for every visitor without
// needing a second stylesheet or a [data-theme] selector block per theme.
//
// THEMES.default's values are kept identical to globals.css's :root block
// on purpose (that block stays as the no-JS/fallback default) -- if you
// change one, change the other, or they'll drift apart.
import { SiteSettings } from "@/models/SiteSettings";

export interface ThemePalette {
  id: string;
  name: string;
  navy: string;
  navy2: string;
  navy3: string;
  navy4: string;
  blue: string;
  blueDim: string;
  coral: string;
  coralDim: string;
  gold: string;
  goldDim: string;
  green: string;
  greenDim: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  border: string;
  borderStrong: string;
}

export const DEFAULT_THEME_ID = "default";

export const THEMES: Record<string, ThemePalette> = {
  default: {
    id: "default",
    name: "Default (Navy / Blue)",
    navy: "#0D0F1A",
    navy2: "#13162A",
    navy3: "#1B1F35",
    navy4: "#252A45",
    blue: "#4F8EF7",
    blueDim: "#1E3A6E",
    coral: "#FF4D4D",
    coralDim: "#4A1515",
    gold: "#F0B429",
    goldDim: "#3D2E00",
    green: "#22C55E",
    greenDim: "#0D3320",
    textPrimary: "#F0F2FF",
    textSecondary: "#8B8FA8",
    textMuted: "#4B4F68",
    border: "rgba(255,255,255,0.07)",
    borderStrong: "rgba(255,255,255,0.14)",
  },
  // "--blue" is this app's PRIMARY ACCENT slot (buttons, active tabs,
  // links) despite the variable's literal name -- every component already
  // references it semantically ("the accent color"), not literally "blue",
  // which is exactly what makes remapping it to orange here a palette-only
  // change with zero component edits. --coral/--gold/--green stay close to
  // their default-theme values on purpose: they're functional/status colors
  // (live/error, points, success) that need to stay recognizable and
  // distinct from the new orange accent, not swapped along with the brand
  // colors -- gold in particular was picked to read clearly as a different
  // hue from the bright-orange accent rather than blending into it.
  orange: {
    id: "orange",
    name: "Grey / Orange",
    navy: "#1A1A1A",
    navy2: "#242424",
    navy3: "#2E2E2E",
    navy4: "#3A3A3A",
    blue: "#FF7A29",
    blueDim: "#4A2A10",
    coral: "#FF4D4D",
    coralDim: "#4A1515",
    gold: "#F0B429",
    goldDim: "#3D2E00",
    green: "#22C55E",
    greenDim: "#0D3320",
    textPrimary: "#FFFFFF",
    textSecondary: "#C7C7C7",
    textMuted: "#8A8A8A",
    border: "rgba(255,255,255,0.08)",
    borderStrong: "rgba(255,255,255,0.16)",
  },
};

export function getThemeOrDefault(id?: string | null): ThemePalette {
  return (id && THEMES[id]) || THEMES[DEFAULT_THEME_ID];
}

export function listAvailableThemes(): { id: string; name: string }[] {
  return Object.values(THEMES).map(t => ({ id: t.id, name: t.name }));
}

const SETTINGS_ID = "siteSettings";

// Callers must have already called connectToDatabase(), same convention as
// lib/blobStorage.ts/lib/counter.ts.
export async function getActiveThemeId(): Promise<string> {
  const doc = await SiteSettings.findById(SETTINGS_ID);
  return doc?.activeTheme ?? DEFAULT_THEME_ID;
}

export async function setActiveThemeId(themeId: string): Promise<void> {
  if (!THEMES[themeId]) throw new Error(`Unknown theme "${themeId}"`);
  await SiteSettings.findByIdAndUpdate(SETTINGS_ID, { activeTheme: themeId }, { upsert: true });
}
