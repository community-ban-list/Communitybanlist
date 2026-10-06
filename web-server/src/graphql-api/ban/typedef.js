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
