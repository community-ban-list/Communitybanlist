import React from 'react';
import { gql } from '@apollo/client';
import { useMutation } from '@apollo/client';

import { Button } from 'reactstrap';

import { ErrorModal, LoadingModal } from '../';

const DELETE_EXPORT_BAN_LIST = gql`
  mutation DeleteExportBanList($id: Int!) {
    deleteExportBanList(id: $id) {
      id
    }
  }
`;

function removeFromCache(cache, { data }) {
  if (!data || !data.deleteExportBanList) return;
  const { deleteExportBanList } = data;

  cache.modify({
    fields: {
      loggedInSteamUser(loggedInSteamUser) {
        if (!loggedInSteamUser) return loggedInSteamUser;

        cache.modify({
          id: loggedInSteamUser.__ref,
          fields: {
            exportBanLists(exportBanLists = [], { readField }) {
              return exportBanLists.filter(
                (exportBanList) => deleteExportBanList.id !== readField('id', exportBanList)
              );
            }
          }
        });

        return loggedInSteamUser;
      }
    }
  });
}

export default function (props) {
  const [deleteExportBanList, { loading, error }] = useMutation(DELETE_EXPORT_BAN_LIST, {
    update: removeFromCache,
    errorPolicy: 'none',
    onError: (error) => console.error('Failed to delete export ban list:', error.message)
  });

  return (
    <>
      {loading && <LoadingModal />}
      {error && (
        <ErrorModal errors={error.graphQLErrors.length ? error.graphQLErrors : [error]} />
      )}
      <Button
        color="danger"
        size="sm"
        disabled={loading}
        onClick={() => {
          deleteExportBanList({ variables: { id: props.exportBanListID } });
        }}
      >
        Delete
      </Button>
    </>
  );
}
