import { gql } from '@apollo/client';

// Add a newly created export ban list config to its export ban list's configs in the cache, so the
// configs page shows it. This file has no JSX, so the web server's tests can load it too.
export default function addToCache(cache, { data }) {
  // A failed create has no config. Leave the cache alone: Apollo Client reports an error thrown here
  // in place of the GraphQL errors, and the form would show an empty error.
  if (!data || !data.createExportBanListConfig) return;
  const { createExportBanListConfig } = data;

  cache.modify({
    id: cache.identify(createExportBanListConfig.exportBanList),
    fields: {
      exportBanListConfigs(exportBanListConfigs = [], { readField }) {
        const newExportBanListConfig = cache.writeFragment({
          data: createExportBanListConfig,
          fragment: gql`
            fragment NewExportBanListConfig on ExportBanListConfig {
              id
              activePoints
              expiredPoints

              exportBanList {
                id
                name
              }
            }
          `
        });

        if (
          exportBanListConfigs.some((ref) => readField('id', ref) === createExportBanListConfig.id)
        )
          return exportBanListConfigs;

        return [...exportBanListConfigs, newExportBanListConfig];
      }
    }
  });
}
