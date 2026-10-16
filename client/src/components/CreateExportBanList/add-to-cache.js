import { gql } from '@apollo/client';

// Add a newly created export ban list to the signed-in user's export ban lists in the cache, so the
// list page shows it. This file has no JSX, so the web server's tests can load it too.
export default function addToCache(cache, { data }) {
  // A failed create has no list. Leave the cache alone: Apollo Client reports an error thrown here
  // in place of the GraphQL errors, and the form would show an empty error.
  if (!data || !data.createExportBanList) return;
  const { createExportBanList } = data;

  cache.modify({
    fields: {
      loggedInSteamUser(loggedInSteamUser) {
        cache.modify({
          id: loggedInSteamUser.__ref,
          fields: {
            exportBanLists(exportBanLists = [], { readField }) {
              const newExportBanList = cache.writeFragment({
                data: createExportBanList,
                fragment: gql`
                  fragment NewExportBanList on ExportBanList {
                    id
                    name
                    server
                    type
                    threshold
                    defaultActivePoints
                    defaultExpiredPoints
                    maxBanAge
                    discordWebhook
                  }
                `
              });

              if (exportBanLists.some((ref) => readField('id', ref) === createExportBanList.id))
                return exportBanLists;

              return [...exportBanLists, newExportBanList];
            }
          }
        });

        return loggedInSteamUser;
      }
    }
  });
}
