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
      The order to list players in: id, the default, which lists players listed under their EOS ID
      before Steam players, as ids are compared as text; reputationRank, which lists ranked
      players; reputationPointsMonthChange, which lists ranked players whose points rose this month;
      or lastViewed, which lists players with reputation points who have been viewed.
      """
      orderBy: String
      orderDirection: OrderDirection
    ): SteamUserConnection

    steamUser(
      "A player's SteamID64, or their EOS ID, in lowercase, if their bans give no SteamID64."
      id: String!
    ): SteamUser

    loggedInSteamUser: SteamUser
  }
`;
