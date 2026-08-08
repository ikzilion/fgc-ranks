// lib/streamTournamentQuery.ts
//
// The Stream (OBS broadcast) page's GraphQL query, in exactly one place.
// Used by BOTH app/tournaments/[id]/stream/page.tsx (the server component's
// initial fetch, passed down as `initialTournament`) and
// components/StreamBracket.tsx (the client component's own polling fetch,
// every POLL_INTERVAL_MS) -- these previously carried two independently
// hand-copied strings that were provably able to drift apart: adding
// `entrants` to pools here (needed for FinalsCutoffWinnersRoster, see
// lib/bracketTierView.tsx) was applied to StreamBracket.tsx's copy but not
// caught in the server page's copy, so the FIRST paint of a Finals-cutoff
// pool's Top 24 view was silently missing its Winners-side roster until the
// first poll refetched it up to POLL_INTERVAL_MS later -- confirmed live,
// Aug 8, 2026. Same duplicated-string bug class the "Semifinal Cutoff" ->
// "Top 24" label rename already got caught by once this session (see
// modelBRoundLabel/MODEL_B_FINALS_TAB_LABEL) -- a single shared source here
// makes it structurally impossible for the two fetches to disagree on shape.

// No GraphQL fragments in this codebase (no Apollo Client) -- this is just
// a plain, reused string.
export const STREAM_MATCH_FIELDS = `
  id
  round
  status
  bracketSide
  bracketRound
  bracketPosition
  player1Score
  player2Score
  isForfeit
  player1 { id tag }
  player2 { id tag }
  winner { id tag }
  nextMatch { id }
  nextLoserMatch { id }
`;

export const GET_STREAM_TOURNAMENT = `
  query GetStreamTournament($id: ID!) {
    tournament(id: $id) {
      id
      name
      game
      status
      format
      streamBackgroundUrl
      sponsorBannerUrl
      sponsorBannerUrls { url linkUrl }
      sponsorBannerIntervalSeconds
      bracketLineColor
      bracketBoxColor
      bracketFontColor
      poolModel
      bracket {
        id
        seedingMethod
        size
        matches { ${STREAM_MATCH_FIELDS} }
      }
      pools {
        id
        poolNumber
        roundNumber
        isFinalsCutoff
        entrants {
          id
          player { id tag avatarUrl }
        }
        bracket {
          id
          seedingMethod
          size
          matches { ${STREAM_MATCH_FIELDS} }
        }
      }
      mainBracket {
        id
        seedingMethod
        size
        seedOrder { id }
        matches { ${STREAM_MATCH_FIELDS} }
      }
    }
  }
`;
