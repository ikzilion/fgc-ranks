// GraphQL type definitions — keep in sync with graphql/schema.graphql
// Always update the schema first before adding resolvers or UI, per CLAUDE.md conventions.
export const typeDefs = `#graphql

  scalar Date

  enum TournamentStatus { UPCOMING LIVE ENDED CANCELLED }
  enum TournamentVisibility { PUBLIC PRIVATE }
  enum MatchStatus      { PENDING IN_PROGRESS COMPLETED }
  enum UserRole         { PLAYER ADMIN SUPER_ADMIN }
  enum EventStatus      { PENDING APPROVED REJECTED }
  enum TORequestStatus  { PENDING APPROVED REJECTED }
  # MANUAL is a reordered ranked list still fed through the normal seed-vs-seed
  # bracket pairing math (resolveSeedOrder). MANUAL_BRACKET is a genuinely
  # different mechanism — literal Round-1 slot placement via drag-and-drop
  # (generateBracket/generateMainBracket's manualSlotAssignment arg), which
  # bypasses that pairing math entirely so the TO's exact matchups are kept.
  enum SeedingMethod    { RANDOM RANDOM_WITHIN_TIERS MANUAL AVOID_SAME_POOL MANUAL_BRACKET }
  # Pool play + top-cut only — which pool-stage model a "Pools + Bracket"
  # tournament uses. A = round-robin pools, fresh bracket restart. B =
  # EVO-style continuous carry-over — massive-scale (128+ entrant) fields
  # only; generateModelBPools builds Round 1, advanceModelBRound advances
  # every round after (real match results regrouped via
  # computeNextRepooledRound) through to the real Finals bracket. C =
  # double-elim pools, fresh bracket restart (the existing/default model).
  enum PoolModel        { A B C }
  enum BracketSide      { WINNERS LOSERS GRAND_FINAL GRAND_FINAL_RESET }
  enum NotificationType {
    MATCH_REPORTED
    TOURNAMENT_LIVE
    TOURNAMENT_ENDED
    PLAYER_JOINED
    TO_STATUS_GRANTED
  }

  # SECURITY (July 31, 2026): every field on this type that carries personal
  # or account-security information is gated owner-or-admin in the resolver
  # (see graphql/resolvers/index.ts's User field resolvers), NOT merely
  # hidden by the UI. Player.user is reachable from the fully public
  # players/player queries, so before this gating an unauthenticated caller
  # could read every registered account's email and role straight off
  # /api/graphql in a single request — same bug class as the Player.displayId
  # gap. These fields are therefore NULLABLE: a non-null field returning null
  # for an unauthorized caller would error the whole query instead of just
  # omitting the value. Only id and isTO stay public (the TO badge on
  # player cards genuinely needs them).
  type User {
    id: ID!
    email: String
    role: UserRole
    # Tournament Organizer trust flag — see models/User.ts. Independent of
    # role; grants only the ability to create a "full" (non-restricted)
    # tournament, nothing else ADMIN/SUPER_ADMIN can do. Public: drives the
    # gold "TO" badge on public player cards.
    isTO: Boolean!
    player: Player
    createdAt: Date
    # Grace-period account deletion (settled July 28, 2026) — non-null means
    # this account is pending deletion, scheduled to be scrubbed on this
    # date unless cancelled first. See models/User.ts and
    # cancelAccountDeletion/cancelMyPendingDeletion.
    scheduledScrubAt: Date
    # Admin restore tool — the original email, retained for a limited window
    # after a scrub (see models/User.ts's scrubBackupEmail). Only ever
    # populated on an already-scrubbed (isDeleted) account.
    scrubBackupEmail: String
    scrubBackupExpiresAt: Date
  }

  type TORequest {
    id: ID!
    player: Player!
    # Required at request time — a way for the reviewing admin to reach the
    # requester outside the app if needed.
    contactEmail: String!
    reason: String
    status: TORequestStatus!
    # Only set when status is REJECTED.
    rejectionReason: String
    createdAt: Date!
    # Set the moment status leaves PENDING — the 7-day re-request cooldown
    # after a rejection is measured from this.
    resolvedAt: Date
  }

  type Player {
    id: ID!
    user: User
    tag: String!
    playerNumber: Int
    displayId: String
    region: String
    team: String
    avatarUrl: String
    twitchUrl: String
    # Social media links (settled July 28, 2026) — fixed platform set, same
    # on Event. See models/Player.ts and components/SocialLinks.tsx.
    twitterUrl: String
    instagramUrl: String
    youtubeUrl: String
    discordUrl: String
    tiktokUrl: String
    # Generic "website/other" slot — one only. otherLinkLabel is only
    # meaningful when otherLinkUrl is also set.
    otherLinkUrl: String
    otherLinkLabel: String
    # Computed, not stored — batched Get Streams check via lib/twitch.ts
    # (graphql/loaders.ts's twitchLiveLoader coalesces every Player/Event
    # needing this within one request into as few external calls as
    # possible). False whenever twitchUrl is unset, unparseable, or the
    # Twitch app credentials aren't configured — never null, so callers
    # don't need to distinguish "definitely offline" from "couldn't check".
    isLiveOnTwitch: Boolean!
    characters: [String!]!
    wins: Int!
    losses: Int!
    # ATP-style rolling ranking points — computed at read time from this
    # player's tournament placements, not a stored counter. See lib/ranking.ts.
    points: Int!
    # Per-game ranking points/rank, alongside the combined points above —
    # same 52-week window and best-10 cap, just filtered to one game before
    # the cap is applied (see lib/ranking.ts's computeGameRankingsForPlayer).
    # Every game this player has an in-window result in, no minimum
    # threshold — a game with just 1 counted tournament still appears.
    gameRankings: [GameRanking!]!
    winRate: Float
    tournaments: [Entrant!]!
    createdAt: Date!
    # Admin soft-delete — see deletePlayer. Personal info is scrubbed and
    # login disabled, but the document/historical references stay intact.
    isDeleted: Boolean!
    deletedAt: Date
    # Admin restore tool (settled July 28, 2026) — the original tag,
    # retained for a limited window after a scrub (see
    # models/Player.ts's scrubBackupTag). Non-null here is exactly what
    # restorableDeletedPlayers filters on. Only ever populated on an
    # already-scrubbed (isDeleted) player.
    scrubBackupTag: String
    # Head-to-head record against a specific opponent, from THIS player's
    # perspective (wins = this player's wins over opponent). Only counts
    # completed matches (forfeits included — a forfeit still has a real
    # winner/loser).
    headToHead(opponentId: ID!): HeadToHead
  }

  type GameRanking {
    game: String!
    points: Int!
    # 1-indexed position among every OTHER player with an in-window result
    # in this same game — not among all players site-wide.
    rank: Int!
  }

  # One row of a specific game's full leaderboard (Query.gameLeaderboard) —
  # rank is 1-indexed and contiguous among visible (non-soft-deleted)
  # players only, same convention Query.players already uses.
  type GameLeaderboardEntry {
    player: Player!
    points: Int!
    rank: Int!
  }

  # One page of the Players list (Query.playersLeaderboard) — totalCount is
  # the full match count (not just this page's length), needed to know how
  # many numbered pages exist.
  type PlayerLeaderboardPage {
    players: [Player!]!
    totalCount: Int!
  }

  type HeadToHead {
    opponent: Player!
    wins: Int!
    losses: Int!
  }

  # One slot in the sponsor banner slideshow — see Tournament.sponsorBannerUrls.
  # linkUrl is optional per banner (settled July 28, 2026): each sponsor's
  # banner click-throughs to that sponsor's own site independently of
  # whichever other banners are also rotating. null/empty = not clickable.
  type SponsorBannerSlide {
    url: String!
    linkUrl: String
  }

  input SponsorBannerSlideInput {
    url: String!
    linkUrl: String
  }

  type Tournament {
    id: ID!
    name: String!
    game: String!
    status: TournamentStatus!
    cancellationReason: String
    visibility: TournamentVisibility!
    entrantCount: Int!
    startDate: Date!
    endDate: Date
    isEntered(playerId: ID): Boolean!
    isOrganizer(playerId: ID): Boolean!
    isInvited(playerId: ID): Boolean!
    # The caller's own Entrant record (id + checkedInAt), not the full list --
    # for the fast tournament-page summary query, which needs just enough to
    # drive JoinTournamentButton/SelfCheckInButton without fetching every
    # entrant. Same cheap Entrant.findOne shape as isEntered, just returning
    # the doc instead of a boolean.
    myEntrant(playerId: ID): Entrant
    organizers: [Player!]!
    invitedPlayers: [Player!]!
    entrants: [Entrant!]!
    matches: [Match!]!
    bracket: Bracket
    streamBackgroundUrl: String
    sponsorBannerUrl: String
    # Sponsor banner slideshow — when non-empty, the stream view rotates
    # through these instead of the single sponsorBannerUrl above. See
    # models/Tournament.ts.
    sponsorBannerUrls: [SponsorBannerSlide!]!
    # Required once sponsorBannerUrls has 2+ entries — null while no
    # slideshow is configured.
    sponsorBannerIntervalSeconds: Int
    bracketLineColor: String
    bracketBoxColor: String
    bracketFontColor: String
    logoUrl: String
    isOnlineOnly: Boolean!
    address: String
    twitchUrl: String
    format: String
    capacity: Int
    entryFee: String
    prizePot: String
    eventId: ID
    # When eventId is set, these three resolve from the linked Event's
    # CURRENT data instead of this tournament's own stored fields — a live
    # link, not a value copied at link time. See the field resolvers.
    event: Event
    # TO permission overhaul — set once at creation (never re-derived), see
    # models/Tournament.ts. When true: visibility can never become PUBLIC,
    # streamBackgroundUrl/sponsorBannerUrl can never be set, and this
    # tournament is excluded from the ranking/points computation.
    isRestricted: Boolean!
    # Pool play + top-cut bracket format (format === "Pools + Bracket") only.
    # Empty for a standard tournament and before generatePools has run.
    pools: [Pool!]!
    # Set once generateMainBracket has run (after every pool is complete).
    # Rendered/used exactly like a standard tournament's bracket field.
    mainBracket: Bracket
    # True once every Pool's own Grand Final has completed — gates the
    # "Generate Main Bracket" action. Always false when there are no pools.
    allPoolsComplete: Boolean!
    # Auto-suggested pool count for generatePools, targeting ~6-8 entrants
    # per pool — a pure function of entrantCount, purely a UI convenience
    # (the TO can always override with a direct number).
    suggestedPoolCount: Int!
    # Pool play + top-cut only — which pool-stage model this tournament
    # uses (see the PoolModel enum). Set once at creation; unused/ignored
    # for a "Standard Bracket" tournament.
    poolModel: PoolModel!
    # Pool format Model B only — false for every other tournament, and false
    # once its Finals bracket (mainBracket) has already been generated.
    # True once every pool of the current (latest) round has finished — gates
    # the "Advance to next round" action (advanceModelBRound), the Model B
    # analogue of allPoolsComplete/"Generate Main Bracket" above.
    modelBCurrentRoundComplete: Boolean!
    # Marks this as an illustrative example/demo tournament (e.g. the
    # showcase tournaments for browsing each bracket format) rather than a
    # real community competition — display-only, doesn't affect any
    # behavior. See models/Tournament.ts.
    isExample: Boolean!
  }

  type Pool {
    id: ID!
    poolNumber: Int!
    entrants: [Entrant!]!
    # Set only for a double-elim pool (Models B/C) — null for a round-robin
    # (Model A) pool, which has no elimination bracket to render.
    bracket: Bracket
    # Model A (round-robin) only — every match this pool's entrants played
    # against each other. Empty for a Model B/C pool (its matches live on
    # its bracket instead, via bracket.matches).
    matches: [Match!]!
    # Model A (round-robin) only — this pool's entrants ranked by the
    # sets-won / games-won / head-to-head / random tiebreak order. Null for
    # a Model B/C pool (advancement there is read off the pool's own
    # Grand Final instead).
    standings: [PoolStanding!]
    # Pool format Model B only — which repooling round this pool belongs to
    # (1 = the tournament's own first pool round). Always 1 for Model A/C.
    roundNumber: Int!
    # Pool format Model B only — true for the final Semifinal-cutoff round,
    # whose bracket (built by buildFinalsCutoffBracket) has no Grand Final
    # of its own. Always false for Model A/C.
    isFinalsCutoff: Boolean!
  }

  # One row of a round-robin pool's standings table (Pool format Model A
  # only) — see Pool.standings.
  type PoolStanding {
    entrant: Entrant!
    matchWins: Int!
    matchLosses: Int!
    gamesWon: Int!
    gamesLost: Int!
    rank: Int!
  }

  type Event {
    id: ID!
    displayId: String
    name: String!
    isOnlineOnly: Boolean!
    address: String
    logoUrl: String
    twitchUrl: String
    # Social media links (settled July 28, 2026) — fixed platform set, same
    # on Player. See models/Event.ts and components/SocialLinks.tsx.
    twitterUrl: String
    instagramUrl: String
    youtubeUrl: String
    discordUrl: String
    tiktokUrl: String
    otherLinkUrl: String
    otherLinkLabel: String
    # Free-text markdown source, optional — rendered on the public Event
    # page via components/MarkdownContent.tsx. See models/Event.ts.
    description: String
    # Same computed/batched pattern as Player.isLiveOnTwitch — see that
    # field's comment. Independent of any player's individual live status.
    isLiveOnTwitch: Boolean!
    status: EventStatus!
    # Only set when status is REJECTED.
    rejectionReason: String
    creator: Player
    managers: [Player!]!
    tournaments: [Tournament!]!
    # Cheap summary counts for the browse-page cards — computed via
    # countDocuments/distinct rather than populating the tournaments list in full.
    tournamentCount: Int!
    gameCount: Int!
    newsPosts: [NewsPost!]!
    createdAt: Date!
  }

  type Game {
    id: ID!
    name: String!
    iconUrl: String
    # Count of Tournament documents whose game string matches this Game's
    # name exactly — cheap countDocuments, same pattern as
    # Event.tournamentCount, not a stored/synced counter.
    tournamentCount: Int!
  }

  type Entrant {
    id: ID!
    player: Player!
    tournament: Tournament!
    seed: Int
    placement: Int
    # Day-of attendance confirmation — set by checkInEntrant (self or TO/
    # admin), null until then. Distinct from having joined at all
    # (Tournament.entrants already includes everyone who's joined,
    # checked in or not); a TO reviews who's missing before generating the
    # bracket, see Query behavior around bracket generation on the client.
    checkedInAt: Date
    # Size-scaled ranking points this entrant's placement earned from THIS
    # tournament specifically (scaledPointsForPlacement, lib/ranking.ts) --
    # not the player's overall cached rankingPoints. See resolver comment.
    pointsEarned: Int!
  }

  # addEntrantByOrganizer's return shape — distinct from Entrant! (what
  # joinTournament returns) specifically so the caller can tell "actually
  # just added" apart from "already an entrant, no-op" without an extra
  # round trip. Used by the QR-scan add-player flow to show the right
  # feedback for each case.
  type AddEntrantResult {
    entrant: Entrant!
    alreadyEntered: Boolean!
  }

  # checkInEntrant's return shape — same "tell a no-op apart from a real
  # change" reasoning as AddEntrantResult, so the QR-scan check-in flow can
  # show "already checked in" instead of a misleading fresh-success message.
  type CheckInResult {
    entrant: Entrant!
    alreadyCheckedIn: Boolean!
  }

  type Match {
    id: ID!
    tournament: Tournament!
    player1: Player
    player2: Player
    player1Score: Int!
    player2Score: Int!
    isForfeit: Boolean!
    winner: Player
    round: String!
    status: MatchStatus!
    bracket: Bracket
    bracketSide: BracketSide
    bracketRound: Int
    bracketPosition: Int
    nextMatch: Match
    nextLoserMatch: Match
    # True only for a bracket's current terminal/last-played match: this
    # match is COMPLETED and nothing it feeds (nextMatch/nextLoserMatch, or
    # a Grand Final Reset it may have spawned) has itself been played yet.
    # Gates the Undo button (undoMatchResult) — replaces the old per-match
    # Delete action, which cascaded arbitrarily deep and was found to be
    # breaking live brackets in production.
    canUndo: Boolean!
  }

  type Bracket {
    id: ID!
    tournament: Tournament!
    # Set only for a pool's own bracket (Pool play + top-cut format) — null
    # for a standard tournament's bracket and for a pools tournament's main
    # bracket.
    poolId: ID
    seedingMethod: SeedingMethod!
    seedOrder: [Player!]!
    size: Int!
    matches: [Match!]!
    createdAt: Date!
  }

  type AuthPayload {
    # DEPRECATED, always null (July 31, 2026). This used to be a signed JWT
    # keyed by the NextAuth secret, but nothing ever verified it — real
    # sessions are entirely NextAuth's — and handing it out leaked an HMAC
    # oracle over that secret. Kept as a nullable always-null field purely so
    # an already-deployed client still selecting it keeps parsing. See the
    # SECURITY note in graphql/resolvers/index.ts.
    token: String
    user: User!
  }

  type Notification {
    id: ID!
    type: NotificationType!
    message: String!
    link: String
    read: Boolean!
    createdAt: Date!
  }

  # A TO's reusable stream-background/sponsor-banner library (see
  # models/StreamAsset.ts) — shared across every tournament they organize,
  # not per-tournament. type is "stream-bg" or "sponsor-banner", matching
  # the existing /api/upload route's own type values exactly (no separate
  # enum to keep in sync between two parallel naming schemes).
  type StreamAsset {
    id: ID!
    type: String!
    url: String!
    # The original filename the TO uploaded (e.g. "channels4_banner.jpg") --
    # null for the handful of assets uploaded before this field existed,
    # which have no way to recover their original name retroactively.
    filename: String
    createdAt: Date!
  }

  type NewsPost {
    id: ID!
    title: String!
    content: String!
    author: Player
    createdAt: Date!
    updatedAt: Date!
  }

  # Color theme system (settled July 29, 2026) — see lib/theme.ts.
  type Theme {
    id: String!
    name: String!
  }

  type Query {
    # Site-wide active color theme — public, no auth required (every
    # visitor's page needs this to render with the right palette). See
    # lib/theme.ts and app/layout.tsx.
    activeTheme: String!
    # The full list of available themes (id + display name), for the admin
    # theme-switcher UI.
    availableThemes: [Theme!]!
    myNotifications: [Notification!]!
    unreadNotificationCount: Int!
    # The calling player's own reusable stream-asset library (Stream
    # Settings' picker dropdown) — type is "stream-bg" or "sponsor-banner".
    # Empty for a signed-out caller, same convention as myNotifications.
    myStreamAssets(type: String!): [StreamAsset!]!
    # The FULL ranked leaderboard for one specific game — every player with
    # an in-window result in that game (same 52-week window/best-10 cap as
    # the combined system, see lib/ranking.ts's computeGameLeaderboard), not
    # just a top-N slice. Powers /games/[game].
    gameLeaderboard(game: String!): [GameLeaderboardEntry!]!

    players(limit: Int, offset: Int): [Player!]!
    # Real server-side pagination + search for the Players list page
    # (settled July 29, 2026 — scales to 100k+ players, unlike "players"
    # above which the Players page used to fetch up to 1000 of and
    # paginate/search client-side). "search" matches a player's tag by
    # prefix only ("starts with", case-insensitive) — the one match a plain
    # MongoDB index can actually serve; not the old client-side "contains
    # anywhere in tag/region/characters" behavior.
    playersLeaderboard(page: Int, pageSize: Int, search: String): PlayerLeaderboardPage!
    player(id: ID!): Player
    playerByTag(tag: String!): Player
    # Looks up by the human-readable displayId (e.g. "FGC-000001") — what a
    # TO types into "Add organizer by Player ID", not the raw Mongo _id.
    # Same pattern as eventByDisplayId. Works for any player regardless of
    # whether they've entered the tournament in question.
    playerByDisplayId(displayId: String!): Player

    tournaments(status: TournamentStatus, limit: Int, offset: Int): [Tournament!]!
    tournament(id: ID!): Tournament

    events(limit: Int, offset: Int): [Event!]!
    event(id: ID!): Event
    # Looks up by the human-readable displayId (e.g. "EVT-000001") — what a
    # TO actually types into a tournament's "Event ID" field, not the raw
    # Mongo _id. Mirrors playerByTag's role for Player.
    eventByDisplayId(displayId: String!): Event
    # ADMIN-only — the review queue's data source.
    pendingEvents: [Event!]!
    # ADMIN-only — running total tracked incrementally in lib/blobStorage.ts,
    # not computed on demand. Display-only (admin dashboard); pair with the
    # hardcoded BLOB_STORAGE_LIMIT_BYTES constant client-side, not a second
    # field here, since the limit itself never changes per-request.
    blobStorageUsageBytes: Int!

    matches(tournamentId: ID!): [Match!]!
    match(id: ID!): Match

    # Curated Games, sorted by name, PLUS a synthetic entry for any distinct
    # Tournament.game value that doesn't match a curated name (drift-guard —
    # see models/Game.ts) — public, no auth required, same as tournaments.
    games: [Game!]!
    # ADMIN-only — every name currently in the HiddenGameName collection
    # (see hideUncuratedGame), so /admin/games can actually show what's
    # hidden and offer an Unhide action for each.
    hiddenGameNames: [String!]!

    # The calling session's own most recent TO request (any status), or null
    # if it's never made one — lets the profile page show "Request pending",
    # a rejection-cooldown message, or a fresh "Request TO status" button.
    myTORequest: TORequest
    # ADMIN-only — the TO-request review queue's data source.
    pendingTORequests: [TORequest!]!

    # SUPER_ADMIN-only (settled July 28, 2026) — the admin restore tool's
    # data source: every scrubbed player still within its
    # SCRUB_BACKUP_RETENTION_MS restore window (lib/accountDeletion.ts).
    restorableDeletedPlayers: [Player!]!

    # eventId omitted = global homepage posts only (unchanged pre-Events
    # behavior). eventId set = that Event's own news section instead.
    newsPosts(limit: Int, offset: Int, eventId: ID): [NewsPost!]!

    me: User
  }

  type Mutation {
    # turnstileToken is verified against Cloudflare's siteverify endpoint
    # before anything else in this mutation runs.
    register(email: String!, password: String!, tag: String!, turnstileToken: String!): AuthPayload!
    login(email: String!, password: String!): AuthPayload!
    requestPasswordReset(email: String!): Boolean!
    resetPassword(token: String!, newPassword: String!): Boolean!
    verifyEmail(token: String!): Boolean!
    # Same anti-enumeration convention as requestPasswordReset — always
    # returns true regardless of whether the email exists or is already verified.
    resendVerificationEmail(email: String!): Boolean!
    # Self-service account deletion — authenticated, caller's own account
    # only. Emails a confirmation link; confirmAccountDeletion (below) does
    # the actual deletion once clicked. No argument since it always targets
    # the calling session's own account.
    requestAccountDeletion: Boolean!
    # Token-only, no login required to use the link — same precedent as
    # resetPassword. Grace-period account deletion (settled July 28, 2026):
    # this no longer scrubs immediately — it starts a 7-day pending-deletion
    # window (User.scheduledScrubAt), cancellable via cancelAccountDeletion/
    # cancelMyPendingDeletion below. The actual scrub only happens once that
    # window elapses.
    confirmAccountDeletion(token: String!): Boolean!
    # Cancels a pending deletion via the token from the "your account is
    # scheduled for deletion" email — no login required, same precedent as
    # confirmAccountDeletion. Idempotent (true even if already
    # cancelled/not pending).
    cancelAccountDeletion(token: String!): Boolean!
    # Cancels a pending deletion for the calling session's own account — the
    # "sign back in and cancel" path, no token needed. Same
    # no-argument-always-targets-self convention as requestAccountDeletion.
    cancelMyPendingDeletion: Boolean!

    updatePlayer(
      id: ID!
      tag: String
      region: String
      avatarUrl: String
      characters: [String!]
      team: String
      twitchUrl: String
      twitterUrl: String
      instagramUrl: String
      youtubeUrl: String
      discordUrl: String
      tiktokUrl: String
      otherLinkUrl: String
      otherLinkLabel: String
    ): Player!
    # ADMIN-only. Soft-delete: disables login, scrubs personal info (email,
    # password, avatar, region, team), but keeps the Player document and all
    # Match/Entrant/Tournament/Event references intact.
    deletePlayer(id: ID!): Boolean!
    # SUPER_ADMIN-only (settled July 28, 2026) — reverses a scrub within its
    # restore window, recovering the original tag/email from the temporary
    # backup (see models/Player.ts's scrubBackupTag). The account's password
    # is NOT recoverable (randomized at scrub time by design) — the
    # restored player needs a fresh password reset to log back in.
    restoreDeletedPlayer(playerId: ID!): Player!
    # SUPER_ADMIN-only (settled July 29, 2026) — site-wide, not per-player;
    # changes what every visitor sees. Returns the new active theme id.
    # See lib/theme.ts.
    setActiveTheme(themeId: String!): String!
    # SUPER_ADMIN-only — the one in-app way to grant/revoke ADMIN. Regular
    # ADMINs cannot call these.
    grantAdmin(playerId: ID!): Boolean!
    revokeAdmin(playerId: ID!): Boolean!

    # TO permission overhaul — request/approval flow. Requires the same
    # account-trust threshold as createTournament (24h account age).
    # Enforces server-side (not just UI) that a player can't queue a second
    # request while one is already PENDING, and that a REJECTED request
    # blocks re-requesting for 7 days from its resolvedAt.
    requestTOStatus(contactEmail: String!, reason: String): TORequest!
    # ADMIN-only. Approving sets the requester's User.isTO to true.
    approveTORequest(id: ID!): TORequest!
    # ADMIN-only. Reason is required, same convention as rejectEvent.
    rejectTORequest(id: ID!, reason: String!): TORequest!
    # ADMIN-only direct grant/revoke — mirrors grantAdmin/revokeAdmin, no
    # request required first. Granting auto-resolves (approves) any
    # dangling PENDING request for that player instead of leaving it in
    # the queue.
    grantTOStatus(playerId: ID!): Boolean!
    revokeTOStatus(playerId: ID!): Boolean!

    createTournament(
      name: String!
      game: String!
      startDate: Date!
      logoUrl: String
      isOnlineOnly: Boolean
      address: String
      twitchUrl: String
      format: String
      capacity: Int
      entryFee: String
      prizePot: String
      eventId: ID
      # Pool play + top-cut only — ignored/irrelevant for any other format.
      # Omitted = Model C (the existing default). Model B is rejected
      # server-side (not buildable yet).
      poolModel: PoolModel
    ): Tournament!
    updateTournamentDetails(
      id: ID!
      logoUrl: String
      isOnlineOnly: Boolean
      address: String
      twitchUrl: String
      format: String
      capacity: Int
      entryFee: String
      prizePot: String
      # Pass an existing Event's raw id to link, or an empty string/null to
      # unlink. Validated against a real Event server-side either way.
      eventId: ID
    ): Tournament!

    # ADMIN-only — curated Games management (nav "Games" tab + Tournament
    # creation's game dropdown draw from this list). name must be unique;
    # a duplicate throws a friendly error rather than a raw Mongo one.
    createGame(name: String!, iconUrl: String): Game!
    updateGame(id: ID!, name: String, iconUrl: String): Game!
    # Allowed even with tournaments still referencing this Game's name by
    # string — same precedent as deleteEvent. Those tournaments just fall
    # back to surfacing as a synthetic/orphan Games-list entry afterward
    # (see the games resolver), never disappearing from browsing.
    deleteGame(id: ID!): Boolean!
    # Admin management gap for uncurated game entries — these two apply only
    # to UNCURATED orphan entries (see the games resolver); curated Games
    # already have their working edit/delete path above.
    #
    # "Curate with corrected name": turns an orphan entry into a real
    # curated Game, either under oldName's own exact string or a corrected
    # newName — either way, retroactively renames Tournament.game on every
    # tournament currently using oldName to newName, so they end up attached
    # to the resulting Game instead of leaving a second orphan behind. If a
    # curated Game already exists under newName (e.g. fixing a typo into an
    # already-curated spelling), merges into it rather than erroring.
    curateUncuratedGame(oldName: String!, newName: String!, iconUrl: String): Game!
    # "Hide from list": hides an orphan entry (by its exact game-name
    # string) from the shared games list — does NOT touch any
    # Tournament.game value and does NOT create a real Game document.
    hideUncuratedGame(name: String!): Boolean!
    # Reverses hideUncuratedGame — removes the name from HiddenGameName, so
    # it can surface again in the games list (only if it's still a real
    # uncurated name with active tournaments; otherwise it just stays gone,
    # which is correct, not a bug).
    unhideUncuratedGame(name: String!): Boolean!

    createEvent(
      name: String!
      isOnlineOnly: Boolean
      address: String
      logoUrl: String
      twitchUrl: String
      description: String
      twitterUrl: String
      instagramUrl: String
      youtubeUrl: String
      discordUrl: String
      tiktokUrl: String
      otherLinkUrl: String
      otherLinkLabel: String
    ): Event!
    updateEvent(
      id: ID!
      name: String
      isOnlineOnly: Boolean
      address: String
      logoUrl: String
      twitchUrl: String
      description: String
      twitterUrl: String
      instagramUrl: String
      youtubeUrl: String
      discordUrl: String
      tiktokUrl: String
      otherLinkUrl: String
      otherLinkLabel: String
    ): Event!
    deleteEvent(id: ID!): Boolean!
    addEventManager(eventId: ID!, playerId: ID!): Event!
    removeEventManager(eventId: ID!, playerId: ID!): Event!
    # ADMIN-only. Edit-and-approve in one call — any field left null keeps
    # its current value, same partial-update convention as updateEvent.
    approveEvent(
      id: ID!
      name: String
      isOnlineOnly: Boolean
      address: String
      logoUrl: String
      twitchUrl: String
      description: String
      twitterUrl: String
      instagramUrl: String
      youtubeUrl: String
      discordUrl: String
      tiktokUrl: String
      otherLinkUrl: String
      otherLinkLabel: String
    ): Event!
    # ADMIN-only. Reason is required.
    rejectEvent(id: ID!, reason: String!): Event!
    updateTournamentStatus(id: ID!, status: TournamentStatus!): Tournament!
    cancelTournament(id: ID!, reason: String!): Tournament!
    updateTournamentVisibility(id: ID!, visibility: TournamentVisibility!): Tournament!
    inviteToTournament(tournamentId: ID!, playerId: ID!): Tournament!
    cancelTournamentInvite(tournamentId: ID!, playerId: ID!): Tournament!
    declineTournamentInvite(tournamentId: ID!, playerId: ID!): Tournament!
    addTournamentOrganizer(tournamentId: ID!, playerId: ID!): Tournament!
    removeTournamentOrganizer(tournamentId: ID!, playerId: ID!): Tournament!
    # sponsorBannerUrls/sponsorBannerIntervalSeconds: the slideshow — see
    # Tournament.sponsorBannerUrls. Passing an array with 2+ entries requires
    # a valid interval (either in this same call or already saved). Each
    # slide's linkUrl is independent — omit/null it on a slide for no
    # click-through link on that specific banner.
    updateTournamentStreamAssets(id: ID!, streamBackgroundUrl: String, sponsorBannerUrl: String, sponsorBannerUrls: [SponsorBannerSlideInput!], sponsorBannerIntervalSeconds: Int): Tournament!
    updateTournamentBracketLineColor(id: ID!, bracketLineColor: String!, bracketBoxColor: String, bracketFontColor: String): Tournament!

    joinTournament(tournamentId: ID!, playerId: ID!): Entrant!
    # Organizer/admin-initiated add — the ORGANIZER-side counterpart to
    # joinTournament (which only lets a player add themselves, or an admin
    # add anyone). Powers the QR-scan "add player" flow: a TO scans a real
    # walk-up player's Player ID QR and adds them directly, without that
    # player needing to self-join. Same LIVE/ENDED status gate and
    # duplicate-entry handling as joinTournament, but does NOT enforce the
    # PRIVATE-tournament invite check — an organizer manually adding someone
    # is already the authority over their own roster, invite or not.
    addEntrantByOrganizer(tournamentId: ID!, playerId: ID!): AddEntrantResult!
    # Day-of attendance confirmation, before bracket seeding — distinct from
    # joining. Self check-in (playerId must match the caller) or TO/admin
    # check-in on an entrant's behalf (manual toggle in the entrant list, or
    # the QR-scan "Check in" mode in Tablet/Phone Mode — both reuse this
    # same mutation, no separate self/TO variants). No-shows are never
    # auto-removed; generateBracket still runs regardless of who has or
    # hasn't checked in — the client-side warning list before generating is
    # purely advisory, the TO decides case-by-case via removeEntrant.
    checkInEntrant(tournamentId: ID!, playerId: ID!): CheckInResult!
    setPlacement(entrantId: ID!, placement: Int!): Entrant!
    # Resets placement back to fully unset AND clears placementSetManually —
    # see clearPlacement's resolver comment for why the flag is reset too,
    # not just the value.
    clearPlacement(entrantId: ID!): Entrant!

    reportResult(matchId: ID!, player1Score: Int, player2Score: Int, isForfeit: Boolean, forfeitingPlayerId: ID): Match!
    editMatchResult(matchId: ID!, player1Score: Int, player2Score: Int, isForfeit: Boolean, forfeitingPlayerId: ID): Match!
    # Replaces the old deleteMatch — only ever valid on a bracket's current
    # terminal match (Match.canUndo), so there's never anything to cascade.
    # Clears this one match's own score/winner back to PENDING, reverses its
    # win/loss stat effects, and un-applies any automatic placement it
    # triggered (Grand Final/Reset) — a manually-set placement is untouched.
    undoMatchResult(matchId: ID!): Match!

    # manualSeedOrder: MANUAL only — a ranked list (every entrant, no gaps).
    # manualSlotAssignment: MANUAL_BRACKET only — a literal Round-1 slot
    # assignment sized to nextPowerOfTwo(entrantCount); a null entry is an
    # intentional bye, so unlike manualSeedOrder this list CAN have gaps.
    generateBracket(tournamentId: ID!, seedingMethod: SeedingMethod!, manualSeedOrder: [ID!], manualSlotAssignment: [ID]): Bracket!
    deleteBracket(tournamentId: ID!): Boolean!
    # Pool play + top-cut bracket format only (tournament.format === "Pools +
    # Bracket"). Splits every current entrant evenly across poolCount pools
    # (or the auto-suggested count if omitted) and generates each pool's own
    # double-elimination Bracket via the same generator generateBracket uses.
    generatePools(tournamentId: ID!, poolCount: Int): [Pool!]!
    # Pool format Model B only (tournament.poolModel === "B"). Requires at
    # least 128 entrants (Model B needs a large field to be worth its extra
    # complexity — Model A/C's generatePools already covers smaller fields).
    # Builds Round 1 only: splits every current entrant evenly across a
    # power-of-two pool count targeting ~15 entrants/pool, and generates each
    # pool's own double-elimination Bracket exactly like generatePools does
    # for Model A/C. Later rounds are regrouped ("repooled") from these
    # pools' results by a separate mechanism, not this mutation.
    generateModelBPools(tournamentId: ID!): [Pool!]!
    # Pool format Model B only. Requires Tournament.modelBCurrentRoundComplete
    # (every pool of the current round finished). Reads that round's REAL
    # results (lib/bracket.ts's extractPoolSurvivors), regroups them via
    # computeNextRepooledRound, and persists the next round exactly like
    # generateModelBPools persists Round 1 -- real Pool + Bracket + Match
    # documents. Once the field has narrowed to the final ~24-entrant
    # Semifinal pool, that round is instead built via buildFinalsCutoffBracket
    # (no Grand Final of its own — see Pool.isFinalsCutoff). Calling this
    # again once THAT round finishes resolves its 8 real qualifiers and
    # generates the tournament's real Finals bracket (buildDoubleEliminationBracket),
    # setting Tournament.mainBracketId — the same "Main Bracket" slot Model
    # A/C's generateMainBracket already fills. Returns the newly created
    # pools for this call (empty once it generates the Finals bracket
    # instead, since that's exposed via Tournament.mainBracket, not a Pool).
    advanceModelBRound(tournamentId: ID!): [Pool!]!
    # Pool play + top-cut only. Requires every pool's Grand Final to have
    # completed (Tournament.allPoolsComplete). Seeds the fresh main bracket
    # from the 2 advancers per pool (winners-finalist + losers-finalist).
    # manualSlotAssignment: MANUAL_BRACKET only — same shape as
    # generateBracket's, but placing the pool advancers (winners-finalist +
    # losers-finalist per pool) rather than raw tournament entrants.
    generateMainBracket(tournamentId: ID!, seedingMethod: SeedingMethod!, manualSlotAssignment: [ID]): Bracket!
    # Pool play + top-cut only. Reverts back to "entrants only, no pools" —
    # deletes every Pool and its own Bracket/Match documents. Blocked while
    # a main bracket already exists (delete that first) since it was seeded
    # from these pools' results.
    deletePools(tournamentId: ID!): Boolean!
    # Pool play + top-cut only. Reverts back to "pools complete, no main
    # bracket yet" — deletes the main Bracket/Match documents and clears
    # Tournament.mainBracketId, without touching the pools themselves.
    deleteMainBracket(tournamentId: ID!): Boolean!

    deleteTournament(id: ID!): Boolean!
    leaveTournament(entrantId: ID!): Boolean!

    markNotificationRead(id: ID!): Boolean!
    markAllNotificationsRead: Boolean!

    # eventId omitted = global homepage post (ADMIN-only, unchanged). Set =
    # posted to that Event's news section instead (creator/manager-gated).
    createNewsPost(title: String!, content: String!, eventId: ID): NewsPost!
    updateNewsPost(id: ID!, title: String, content: String): NewsPost!
    deleteNewsPost(id: ID!): Boolean!
  }
`;
