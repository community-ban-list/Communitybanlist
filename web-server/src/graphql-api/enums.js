import { gql } from 'graphql-tag';

export default gql`
  enum OrderDirection {
    ASC
    DESC
  }

  enum BanOrderBy {
    created
  }
`;
