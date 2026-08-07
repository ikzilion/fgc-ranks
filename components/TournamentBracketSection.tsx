// components/TournamentBracketSection.tsx
"use client";

// Owns the lifted player-search state (Aug 1, 2026) for the Overview/TO
// page's bracket section -- extracted out of the async Server Component
// TournamentBody in app/tournaments/[id]/page.tsx because useState/useMemo
// can't live in a Server Component, and a function (render-prop) can't cross
// the Server->Client prop boundary either, so the JSX that consumes
// highlightedPlayerIds (EntrantSearchFilter, PoolsSection, BracketView) has
// to be built here instead of passed in pre-built from the server side.
// Stream broadcast view is untouched -- StreamBracket.tsx builds its own
// BracketView calls directly and never renders this component.
import { useMemo, useState } from "react";
import { StandardBracketSection } from "@/components/StandardBracketSection";
import { PoolsSection } from "@/components/PoolsSection";
import { EntrantSearchFilter } from "@/components/EntrantSearchFilter";

export function TournamentBracketSection({ tournament, canManage, isPoolsFormat }: { tournament: any; canManage: boolean; isPoolsFormat: boolean }) {
  const [query, setQuery] = useState("");

  const highlightedPlayerIds = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return new Set<string>();
    return new Set<string>(
      tournament.entrants
        .filter((e: any) => e.player.tag.toLowerCase().includes(q))
        .map((e: any) => e.player.id)
    );
  }, [query, tournament.entrants]);

  return (
    <div className="max-w-[1800px] mx-auto mb-6">
      <div className="flex flex-col sm:flex-row gap-4 items-start">
        {/* Entrants — left sidebar next to the Bracket instead of down
            with Matches, so both are visible together without scrolling
            past the (often very tall) bracket to check who's entered.
            EntrantSearchFilter renders this AND a mobile-only search bar
            as two separate flex items (order-1 search / order-3 list) so
            a large tournament's bracket (order-2) sits between them on
            mobile instead of forcing a scroll past the whole entrant list
            first (settled scope, July 29, 2026) -- desktop is unaffected
            since sm:order-none reverts both to plain source order and the
            search bar is sm:hidden entirely. */}
        <EntrantSearchFilter
          entrants={tournament.entrants}
          canManage={canManage}
          tournamentId={tournament.id}
          status={tournament.status}
          query={query}
          onQueryChange={setQuery}
        />

        {/* min-w-0 is load-bearing: a flex item's default min-width:auto
            would let the bracket's intrinsic content width stretch this
            column (pushing the sidebar off-layout) instead of shrinking
            to the space actually available and scrolling internally via
            its own overflow-x-auto + sticky scrollbar — same class of
            gotcha as the min-h-0 fix on the Stream Settings modal's
            scroll container, just the width axis instead of height.
            w-full is equally load-bearing on mobile specifically: this
            row is `items-start` (so the sidebar doesn't get stretched to
            the bracket's full height once it's a sm:flex-row sibling),
            but on mobile it's flex-col, where items-start's cross-axis
            is WIDTH — without an explicit w-full here, this column sizes
            to its content's natural (unclipped) width instead of the
            viewport, so BracketView's internal overflow-x-auto never
            sees a bounded container to scroll within and the whole page
            overflows horizontally instead. */}
        <div className="flex-1 min-w-0 w-full order-2 sm:order-none">
          {isPoolsFormat ? (
            // Tabbed — one bracket visible at a time (Main Bracket, once
            // generated, plus one tab per pool) instead of every pool
            // stacked vertically on one long page. Pools stay viewable
            // via their own tab as history/reference once the main
            // bracket exists, not just during the pool stage.
            //
            // Deliberately NOT passed: tournament.bracketLineColor/
            // bracketBoxColor/bracketFontColor -- those are Stream-only as
            // of Aug 1, 2026 (reversing the July 29, 2026 "apply uniformly
            // across every view" decision, commit 2826625). Overview always
            // renders with plain theme colors regardless of what's set on
            // the tournament; only components/StreamBracket.tsx's own
            // BracketView calls still receive these props. See the Notion
            // writeup for the full reasoning.
            <PoolsSection
              tournamentId={tournament.id}
              pools={tournament.pools}
              mainBracket={tournament.mainBracket}
              entrantCount={tournament.entrants.length}
              suggestedPoolCount={tournament.suggestedPoolCount}
              allPoolsComplete={tournament.allPoolsComplete}
              poolModel={tournament.poolModel}
              modelBCurrentRoundComplete={tournament.modelBCurrentRoundComplete}
              canManage={canManage}
              highlightedPlayerIds={highlightedPlayerIds}
            />
          ) : (
            // Standard (non-Pools+Bracket) tournaments — adds the same
            // live-narrowing Top 24/Top 8 filtered-view tabs Models A/C's
            // main bracket already has above, via the shared
            // lib/bracketTierView.tsx logic (see StandardBracketSection.tsx).
            // No lineColor/boxColor/fontColor here -- Stream-only, see the
            // PoolsSection comment above for the full reasoning.
            <StandardBracketSection
              tournamentId={tournament.id}
              bracket={tournament.bracket}
              entrants={tournament.entrants}
              canManage={canManage}
              highlightedPlayerIds={highlightedPlayerIds}
            />
          )}
        </div>
      </div>
    </div>
  );
}
