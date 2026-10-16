import { gql } from 'graphql-tag';

export default gql`
  type Query {
    organisations: [Organisation]
    banLists: [BanList]

    bans(
      first: Int
      after: String
      last: Int
      before: String
      "The order to list bans in: created, the default."
      orderBy: String
      orderDirection: OrderDirection
    ): BanConnection

    steamUsers(
      first: Int
      after: String
      last: Int
      before: String
      """
      The order to list players in: id, the default; reputationRank, which lists ranked players;
      reputationPointsMonthChange, which lists ranked players whose points rose this month; or
      lastViewed, which lists players who have been viewed.
      """
      orderBy: String
      orderDirection: OrderDirection
    ): SteamUserConnection

    steamUser(id: String!): SteamUser

    loggedInSteamUser: SteamUser
  }
`;
