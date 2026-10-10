import { gql } from 'graphql-tag';

export default gql`
  type PageInfo {
    hasNextPage: Boolean
    hasPreviousPage: Boolean
    startCursor: String
    endCursor: String
  }

  scalar Date

  directive @systemAdminOnly on FIELD_DEFINITION
`;
