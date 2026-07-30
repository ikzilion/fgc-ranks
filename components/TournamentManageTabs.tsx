// components/TournamentManageTabs.tsx
// Tabbed reorganization of the TO/admin tournament-page button area
// (settled July 28, 2026) -- these buttons had accumulated flat, ungrouped
// rows across many separate features (Edit details, Manage Organizers,
// Invite, Stream settings), making the page hard to navigate. Only ever
// rendered when canManage is true (see app/tournaments/[id]/page.tsx) --
// non-managing viewers get NO tab bar and NO wrapper at all, just the
// Overview content (children) directly, so the public page is byte-for-byte
// unchanged.
//
// Same pill-button TabBar visual convention as PoolsSection.tsx's own
// (main-bracket/pool-tab switching) and StreamBracket.tsx's ViewTabs
// (round/pool-tier switching on the broadcast view) -- this codebase
// doesn't share a single TabBar component across these, each screen
// re-declares its own small copy rather than a premature shared
// abstraction, so this follows that same precedent rather than extracting
// a new one.
//
// The status badge/actions (TournamentStatusButton), results link, Join/
// Self-check-in, Streamer Mode, and Tablet/Phone Mode all stay OUTSIDE this
// component entirely (still rendered directly in page.tsx) -- the first
// group because they're glanceable/frequent status info that would be worse
// buried in a tab, the latter two because they're live-event mode-switches
// a TO reaches for constantly, not settings to configure once and forget
// (judgment call per the settled scope; flagged here and in the PR).
//
// Overview tab renders `children` -- the exact same bracket/pools + entrant
// list JSX page.tsx already builds today, passed through unchanged so its
// own (deliberately wider) max-w-[1800px] container isn't constrained by
// this component's own max-w-5xl tab-bar/panel area. This is what makes
// Overview "preserve today's default view" literally true, not just
// visually similar.
"use client";

import { useState } from "react";
import { useScrollOverflow } from "@/lib/useScrollOverflow";
import { EditTournamentDetailsButton } from "./EditTournamentDetailsButton";
import { ManageOrganizersButton } from "./ManageOrganizersButton";
import { InvitePlayerButton } from "./InvitePlayerButton";
import { StreamAssetsButton } from "./StreamAssetsButton";

type TabId = "overview" | "manage" | "stream";

const TABS: { key: TabId; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "manage", label: "Manage" },
  { key: "stream", label: "Stream" },
];

// Duplicated (not imported) from PoolsSection.tsx's own TabBar -- same
// visual convention, kept as a local copy per this codebase's existing
// per-screen-tab-bar precedent (see this file's header comment).
//
// A single scrollable row (overflow-x-auto + nowrap, same precedent as
// Navbar.tsx's own nav-links row) instead of flex-wrap -- wrapping silently
// absorbed narrow-viewport overflow with no indication more tabs existed
// off-screen; a horizontally-scrollable row plus the chevron below at least
// hints at it (settled scope, July 29, 2026, 2 previewed options). Only the
// right edge needs a chevron here (this bar always starts scrolled to its
// leftmost tab), unlike Navbar's nav-links row which needs both.
function TabBar({ activeKey, onSelect }: { activeKey: TabId; onSelect: (key: TabId) => void }) {
  const { ref: scrollRef, canScrollRight, onScroll } = useScrollOverflow<HTMLDivElement>();

  return (
    <div className="relative">
      <div ref={scrollRef} onScroll={onScroll} className="flex gap-2 overflow-x-auto">
        {TABS.map(tab => {
          const active = tab.key === activeKey;
          return (
            <button
              key={tab.key}
              onClick={() => onSelect(tab.key)}
              className="font-rajdhani text-[13px] font-bold tracking-wide px-3 py-1.5 rounded"
              style={
                active
                  ? { background: "var(--blue)", color: "white", border: "none", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }
                  : { background: "var(--navy-4)", color: "var(--text-secondary)", border: "1px solid var(--border)", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }
              }
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* No gradient/fade behind it -- just the icon itself, per the settled
          scope. pointer-events-none so it never blocks a tap on whatever tab
          happens to sit underneath its edge. */}
      {canScrollRight && (
        <span
          className="absolute right-0 top-1/2 pointer-events-none"
          style={{ transform: "translateY(-50%)", color: "var(--text-muted)" }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </span>
      )}
    </div>
  );
}

interface Props {
  tournamentId: string;
  status: string;
  // Manage tab
  logoUrl?: string;
  isOnlineOnly: boolean;
  address?: string;
  twitchUrl?: string;
  format?: string;
  capacity?: number | null;
  entryFee?: string;
  prizePot?: string;
  event?: { id: string; displayId: string; name: string; logoUrl?: string } | null;
  organizers: any[];
  visibility: string;
  invitedPlayers: any[];
  entrants: any[];
  allPlayers: any[];
  isRestricted?: boolean;
  // Stream tab
  streamBackgroundUrl?: string;
  sponsorBannerUrl?: string;
  sponsorBannerUrls?: { url: string; linkUrl?: string | null }[];
  sponsorBannerIntervalSeconds?: number | null;
  bracketLineColor?: string;
  bracketBoxColor?: string;
  bracketFontColor?: string;
  // Overview tab content -- see this file's header comment.
  children: React.ReactNode;
}

export function TournamentManageTabs({
  tournamentId,
  status,
  logoUrl,
  isOnlineOnly,
  address,
  twitchUrl,
  format,
  capacity,
  entryFee,
  prizePot,
  event,
  organizers,
  visibility,
  invitedPlayers,
  entrants,
  allPlayers,
  isRestricted,
  streamBackgroundUrl,
  sponsorBannerUrl,
  sponsorBannerUrls,
  sponsorBannerIntervalSeconds,
  bracketLineColor,
  bracketBoxColor,
  bracketFontColor,
  children,
}: Props) {
  const [tab, setTab] = useState<TabId>("overview");

  return (
    <>
      <div className="max-w-5xl mx-auto mb-6">
        <TabBar activeKey={tab} onSelect={setTab} />

        {tab === "manage" && (
          <div className="fgc-card p-4 mt-3 flex flex-wrap items-center gap-2">
            <EditTournamentDetailsButton
              tournamentId={tournamentId}
              logoUrl={logoUrl}
              isOnlineOnly={isOnlineOnly}
              address={address}
              twitchUrl={twitchUrl}
              format={format}
              capacity={capacity}
              entryFee={entryFee}
              prizePot={prizePot}
              event={event}
              canManage
            />
            <ManageOrganizersButton tournamentId={tournamentId} organizers={organizers} canManage />
            <InvitePlayerButton
              tournamentId={tournamentId}
              visibility={visibility}
              invitedPlayers={invitedPlayers}
              entrants={entrants}
              allPlayers={allPlayers}
              canManage
              isRestricted={isRestricted}
              status={status}
            />
          </div>
        )}

        {tab === "stream" && (
          <div className="fgc-card p-4 mt-3 flex flex-wrap items-center gap-2">
            <StreamAssetsButton
              tournamentId={tournamentId}
              streamBackgroundUrl={streamBackgroundUrl}
              sponsorBannerUrl={sponsorBannerUrl}
              sponsorBannerUrls={sponsorBannerUrls}
              sponsorBannerIntervalSeconds={sponsorBannerIntervalSeconds}
              bracketLineColor={bracketLineColor}
              bracketBoxColor={bracketBoxColor}
              bracketFontColor={bracketFontColor}
              canManage
              isRestricted={isRestricted}
            />
          </div>
        )}
      </div>

      {tab === "overview" && children}
    </>
  );
}
