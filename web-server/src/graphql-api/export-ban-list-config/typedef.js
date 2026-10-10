import { gql } from 'graphql-tag';

export default gql`
  type ExportBanListConfig {
    id: Int
    activePoints: Int
    expiredPoints: Int

    exportBanList: ExportBanList
    banList: BanList
  }
`;
