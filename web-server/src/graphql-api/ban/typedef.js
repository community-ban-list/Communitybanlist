import { gql } from 'graphql-tag';

export default gql`
  type Ban {
    id: String
    steamUser: SteamUser
    created: Date
    expires: Date
    expired: Boolean
    reason: String
    banList: BanList
    "Whether the ban is on a ban list that is paused, so it counts for nothing. Only a player's bans say."
    paused: Boolean
  }

  type BanConnection {
    edges: [BanEdge]
    pageInfo: PageInfo
  }

  type BanEdge {
    cursor: String
    node: Ban
  }
`;
