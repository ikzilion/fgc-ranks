// GraphQL type definitions — keep in sync with graphql/schema.graphql
// Always update the schema first before adding resolvers or UI, per CLAUDE.md conventions.
export const typeDefs = `#graphql

  scalar Date

  enum TournamentStatus { UPCOMING LIVE ENDED CANCELLED }
  enum TournamentVisibility { PUBLIC PRIVATE }
  enum MatchStatus      { PENDING IN_PROGRESS COMPLETED }
  enum UserRole         { PLAYER ADMIN }
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
    player: Player
    createdAt: Date!
  }

  type Player {
    id: ID!
    user: User
    tag: String!
    region: String
    avatarUrl: String
    characters: [String!]!
    wins: Int!
    losses: Int!
    points: Int!
    winRate: Float
    tournaments: [Entrant!]!
    createdAt: Date!
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

  type Query {
    myNotifications: [Notification!]!
    unreadNotificationCount: Int!

    players(limit: Int, offset: Int): [Player!]!
    player(id: ID!): Player
    playerByTag(tag: String!): Player

    tournaments(status: TournamentStatus, limit: Int, offset: Int): [Tournament!]!
    tournament(id: ID!): Tournament

    matches(tournamentId: ID!): [Match!]!
    match(id: ID!): Match

    me: User
  }

  type Mutation {
    register(email: String!, password: String!, tag: String!): AuthPayload!
    login(email: String!, password: String!): AuthPayload!
    requestPasswordReset(email: String!): Boolean!
    resetPassword(token: String!, newPassword: String!): Boolean!

    updatePlayer(id: ID!, tag: String, region: String, avatarUrl: String, characters: [String!]): Player!

    createTournament(name: String!, game: String!, startDate: Date!): Tournament!
    updateTournamentStatus(id: ID!, status: TournamentStatus!): Tournament!
    cancelTournament(id: ID!, reason: String!): Tournament!
    updateTournamentVisibility(id: ID!, visibility: TournamentVisibility!): Tournament!
    inviteToTournament(tournamentId: ID!, playerId: ID!): Tournament!
    cancelTournamentInvite(tournamentId: ID!, playerId: ID!): Tournament!
    declineTournamentInvite(tournamentId: ID!, playerId: ID!): Tournament!
    addTournamentOrganizer(tournamentId: ID!, playerId: ID!): Tournament!
    removeTournamentOrganizer(tournamentId: ID!, playerId: ID!): Tournament!
    updateTournamentStreamAssets(id: ID!, streamBackgroundUrl: String, sponsorBannerUrl: String): Tournament!
    updateTournamentBracketLineColor(id: ID!, bracketLineColor: String!): Tournament!

    joinTournament(tournamentId: ID!, playerId: ID!): Entrant!
    setPlacement(entrantId: ID!, placement: Int!): Entrant!

    createMatch(tournamentId: ID!, player1Id: ID!, player2Id: ID!, round: String!): Match!
    reportResult(matchId: ID!, player1Score: Int, player2Score: Int, isForfeit: Boolean, forfeitingPlayerId: ID): Match!
    editMatchResult(matchId: ID!, player1Score: Int, player2Score: Int, isForfeit: Boolean, forfeitingPlayerId: ID): Match!

    generateBracket(tournamentId: ID!, seedingMethod: SeedingMethod!, manualSeedOrder: [ID!]): Bracket!
    deleteBracket(tournamentId: ID!): Boolean!

    deleteMatch(id: ID!): Boolean!
    deleteTournament(id: ID!): Boolean!
    leaveTournament(entrantId: ID!): Boolean!

    markNotificationRead(id: ID!): Boolean!
    markAllNotificationsRead: Boolean!
  }
`;
