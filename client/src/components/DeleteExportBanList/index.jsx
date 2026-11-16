import React, { useState } from 'react';
import { gql } from '@apollo/client';
import { useMutation } from '@apollo/client/react';

import { Button } from 'reactstrap';

import ConfirmModal from '../ConfirmModal';

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

// The Delete button for an export ban list. A deleted list cannot be brought back, so it asks
// first, and says what the deletion removes: the servers that use the list lose all of its bans, as
// its export bans go with it, and a BattleMetrics list's ban list on BattleMetrics is deleted too,
// with its invites and its subscribers, as ExportBanList's deleteExportBanList does. A list that
// never got its BattleMetrics ban list has none to delete. onDeleted is called with the list's name
// once it is deleted.
export default function (props) {
  const { exportBanList } = props;
  const [confirming, setConfirming] = useState(false);
  const [deleteExportBanList, { loading, error, data, reset }] = useMutation(
    DELETE_EXPORT_BAN_LIST,
    {
      update: removeFromCache,
      errorPolicy: 'none',
      onError: (error) => console.error('Failed to delete export ban list:', error.message),
      onCompleted: () => {
        setConfirming(false);
        if (props.onDeleted) props.onDeleted(exportBanList.name);
      }
    }
  );

  return (
    <>
      <Button
        className={props.className}
        color="danger"
        size="sm"
        disabled={loading}
        aria-label={`Delete ${exportBanList.name}`}
        onClick={() => {
          // An error from an earlier try is not shown again.
          reset();
          setConfirming(true);
        }}
      >
        Delete
      </Button>
      <ConfirmModal
        isOpen={confirming}
        title={`Delete "${exportBanList.name}"?`}
        confirmLabel="Delete export ban list"
        busyLabel="Deleting..."
        busy={loading}
        error={error}
        returnFocus={!loading && !data?.deleteExportBanList}
        onCancel={() => setConfirming(false)}
        onConfirm={() => deleteExportBanList({ variables: { id: exportBanList.id } })}
      >
        <p>
          Servers using this export ban list lose all of its bans, so the players it bans can join
          them again.
        </p>
        {exportBanList.type === 'battlemetrics' && exportBanList.battlemetricsID && (
          <p>
            Its BattleMetrics ban list is deleted too: its share invite stops working, and the
            organisations subscribed to it are removed from it. This can take a few minutes.
          </p>
        )}
        <p className="mb-0">This cannot be undone.</p>
      </ConfirmModal>
    </>
  );
}
