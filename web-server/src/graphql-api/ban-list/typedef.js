import { gql } from 'graphql-tag';

export default gql`
  type BanList {
    id: Int
    name: String
    organisation: Organisation
  }
`;
