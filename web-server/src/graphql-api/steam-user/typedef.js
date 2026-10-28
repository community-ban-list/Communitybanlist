import { gql } from 'graphql-tag';

export default gql`
  type SteamUser {
    id: String
    name: String
    profileURL: String
    avatar: String
    avatarMedium: String
    avatarFull: String
    lastRefreshedInfo: Date

    reputationPoints: Int
    reputationPointsMonthBefore: Int
    reputationPointsMonthChange: Int
    lastRefreshedReputationPoints: Date
    riskRating: Float
    reputationRank: Int
    lastRefreshedReputationRank: Date

    """
    When the player was last looked up, while they had reputation points. Such a lookup answers with
    its own time, and saves it in the background, usually within 30 seconds, so lists ordered by it
    show the view after that.
    """
    lastViewed: Date

    bans(
      first: Int
      after: String
      last: Int
      before: String
      "The order to list the player's bans in: created, the default."
      orderBy: String
      orderDirection: OrderDirection
      expired: Boolean
    ): BanConnection

    exportBanList(id: Int!): ExportBanList
    exportBanLists: [ExportBanList]
  }

  type SteamUserConnection {
    edges: [SteamUserEdge]
    pageInfo: PageInfo
  }

  type SteamUserEdge {
    cursor: String
    node: SteamUser
  }
`;
