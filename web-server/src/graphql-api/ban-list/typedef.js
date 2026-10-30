import { gql } from 'graphql-tag';

export default gql`
  type BanList {
    id: Int
    name: String
    organisation: Organisation
    "Whether the ban list is paused: its bans count for nothing until it is resumed."
    paused: Boolean
  }
`;
