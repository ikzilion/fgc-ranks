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
  enum SeedingMethod    { RANDOM RANDOM_WITHIN_TIERS MANUAL }
  enum BracketSide      { WINNERS LOSERS GRAND_FINAL GRAND_FINAL_RESET }
  enum NotificationType {
    MATCH_REPORTED
    TOURNAMENT_LIVE
    TOURNAMENT_ENDED
    PLAYER_JOINED
  }

  type User {
    id: ID!
    email: String!
    role: UserRole!
    # Tournament Organizer trust flag — see models/User.ts. Independent of
    # role; grants only the ability to create a "full" (non-restricted)
    # tournament, nothing else ADMIN/SUPER_ADMIN can do.
    isTO: Boolean!
    player: Player
    createdAt: Date!
  }

  type TORequest {
    id: ID!
    player: Player!
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
    characters: [String!]!
    wins: Int!
    losses: Int!
    # ATP-style rolling ranking points — computed at read time from this
    # player's tournament placements, not a stored counter. See lib/ranking.ts.
    points: Int!
    winRate: Float
    tournaments: [Entrant!]!
    createdAt: Date!
    # Admin soft-delete — see deletePlayer. Personal info is scrubbed and
    # login disabled, but the document/historical references stay intact.
    isDeleted: Boolean!
    # Head-to-head record against a specific opponent, from THIS player's
    # perspective (wins = this player's wins over opponent). Only counts
    # completed matches (forfeits included — a forfeit still has a real
    # winner/loser).
    headToHead(opponentId: ID!): HeadToHead
  }

  type HeadToHead {
    opponent: Player!
    wins: Int!
    losses: Int!
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
    organizers: [Player!]!
    invitedPlayers: [Player!]!
    entrants: [Entrant!]!
    matches: [Match!]!
    bracket: Bracket
    streamBackgroundUrl: String
    sponsorBannerUrl: String
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
  }

  type Event {
    id: ID!
    displayId: String
    name: String!
    isOnlineOnly: Boolean!
    address: String
    logoUrl: String
    twitchUrl: String
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
  }

  type Bracket {
    id: ID!
    tournament: Tournament!
    seedingMethod: SeedingMethod!
    seedOrder: [Player!]!
    size: Int!
    matches: [Match!]!
    createdAt: Date!
  }

  type AuthPayload {
    token: String!
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

  type NewsPost {
    id: ID!
    title: String!
    content: String!
    author: Player
    createdAt: Date!
    updatedAt: Date!
  }

  type Query {
    myNotifications: [Notification!]!
    unreadNotificationCount: Int!

    players(limit: Int, offset: Int): [Player!]!
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

    matches(tournamentId: ID!): [Match!]!
    match(id: ID!): Match

    # Curated Games, sorted by name, PLUS a synthetic entry for any distinct
    # Tournament.game value that doesn't match a curated name (drift-guard —
    # see models/Game.ts) — public, no auth required, same as tournaments.
    games: [Game!]!

    # The calling session's own most recent TO request (any status), or null
    # if it's never made one — lets the profile page show "Request pending",
    # a rejection-cooldown message, or a fresh "Request TO status" button.
    myTORequest: TORequest
    # ADMIN-only — the TO-request review queue's data source.
    pendingTORequests: [TORequest!]!

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
    # resetPassword. Performs the same soft-delete as the ADMIN deletePlayer
    # mutation (disables login, scrubs personal info, keeps historical
    # records intact).
    confirmAccountDeletion(token: String!): Boolean!

    updatePlayer(id: ID!, tag: String, region: String, avatarUrl: String, characters: [String!], team: String): Player!
    # ADMIN-only. Soft-delete: disables login, scrubs personal info (email,
    # password, avatar, region, team), but keeps the Player document and all
    # Match/Entrant/Tournament/Event references intact.
    deletePlayer(id: ID!): Boolean!
    # SUPER_ADMIN-only — the one in-app way to grant/revoke ADMIN. Regular
    # ADMINs cannot call these.
    grantAdmin(playerId: ID!): Boolean!
    revokeAdmin(playerId: ID!): Boolean!

    # TO permission overhaul — request/approval flow. Requires the same
    # account-trust threshold as createTournament (24h account age).
    # Enforces server-side (not just UI) that a player can't queue a second
    # request while one is already PENDING, and that a REJECTED request
    # blocks re-requesting for 7 days from its resolvedAt.
    requestTOStatus(reason: String): TORequest!
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

    createEvent(name: String!, isOnlineOnly: Boolean, address: String, logoUrl: String, twitchUrl: String): Event!
    updateEvent(id: ID!, name: String, isOnlineOnly: Boolean, address: String, logoUrl: String, twitchUrl: String): Event!
    deleteEvent(id: ID!): Boolean!
    addEventManager(eventId: ID!, playerId: ID!): Event!
    removeEventManager(eventId: ID!, playerId: ID!): Event!
    # ADMIN-only. Edit-and-approve in one call — any field left null keeps
    # its current value, same partial-update convention as updateEvent.
    approveEvent(id: ID!, name: String, isOnlineOnly: Boolean, address: String, logoUrl: String, twitchUrl: String): Event!
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
    updateTournamentStreamAssets(id: ID!, streamBackgroundUrl: String, sponsorBannerUrl: String): Tournament!
    updateTournamentBracketLineColor(id: ID!, bracketLineColor: String!, bracketBoxColor: String, bracketFontColor: String): Tournament!

    joinTournament(tournamentId: ID!, playerId: ID!): Entrant!
    setPlacement(entrantId: ID!, placement: Int!): Entrant!

    reportResult(matchId: ID!, player1Score: Int, player2Score: Int, isForfeit: Boolean, forfeitingPlayerId: ID): Match!
    editMatchResult(matchId: ID!, player1Score: Int, player2Score: Int, isForfeit: Boolean, forfeitingPlayerId: ID): Match!

    generateBracket(tournamentId: ID!, seedingMethod: SeedingMethod!, manualSeedOrder: [ID!]): Bracket!
    deleteBracket(tournamentId: ID!): Boolean!

    deleteMatch(id: ID!): Boolean!
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
