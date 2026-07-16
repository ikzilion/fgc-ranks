// GraphQL type definitions — keep in sync with graphql/schema.graphql
// Always update the schema first before adding resolvers or UI, per CLAUDE.md conventions.
export const typeDefs = `#graphql

  scalar Date

  enum TournamentStatus { UPCOMING LIVE ENDED }
  enum MatchStatus      { PENDING IN_PROGRESS COMPLETED }
  enum UserRole         { PLAYER ADMIN }
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
    entrantCount: Int!
    startDate: Date!
    endDate: Date
    isEntered(playerId: ID): Boolean!
    entrants: [Entrant!]!
    matches: [Match!]!
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
    player1: Player!
    player2: Player!
    player1Score: Int!
    player2Score: Int!
    winner: Player
    round: String!
    status: MatchStatus!
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

    updatePlayer(id: ID!, tag: String, region: String, avatarUrl: String, characters: [String!]): Player!

    createTournament(name: String!, game: String!, startDate: Date!): Tournament!
    updateTournamentStatus(id: ID!, status: TournamentStatus!): Tournament!

    joinTournament(tournamentId: ID!, playerId: ID!): Entrant!
    setPlacement(entrantId: ID!, placement: Int!): Entrant!

    createMatch(tournamentId: ID!, player1Id: ID!, player2Id: ID!, round: String!): Match!
    reportResult(matchId: ID!, player1Score: Int!, player2Score: Int!): Match!

    deleteMatch(id: ID!): Boolean!
    deleteTournament(id: ID!): Boolean!
    leaveTournament(entrantId: ID!): Boolean!

    markNotificationRead(id: ID!): Boolean!
    markAllNotificationsRead: Boolean!
  }
`;
