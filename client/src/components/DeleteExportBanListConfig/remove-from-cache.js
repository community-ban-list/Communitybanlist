// Remove a deleted export ban list config from its export ban list's configs in the cache, so the
// configs page stops showing it. This file has no JSX, so the web server's tests can load it too.
export default function removeFromCache(cache, { data }) {
  // A failed delete has no config. Leave the cache alone: Apollo Client reports an error thrown here
  // in place of the GraphQL errors, and the page would show an empty error.
  if (!data || !data.deleteExportBanListConfig) return;
  const { deleteExportBanListConfig } = data;

  cache.modify({
    id: cache.identify(deleteExportBanListConfig.exportBanList),
    fields: {
      exportBanListConfigs(exportBanListConfigs = [], { readField }) {
        return exportBanListConfigs.filter(
          (exportBanListConfig) =>
            deleteExportBanListConfig.id !== readField('id', exportBanListConfig)
        );
      }
    }
  });
}
