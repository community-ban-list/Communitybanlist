import { gql } from 'graphql-tag';

export default gql`
  type Organisation {
    id: Int
    name: String
    discord: String

    banLists: [BanList]
  }
`;
