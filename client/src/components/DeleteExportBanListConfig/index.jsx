import React, { useState } from 'react';
import { gql } from '@apollo/client';
import { useMutation } from '@apollo/client/react';

import { Button } from 'reactstrap';

import ConfirmModal from '../ConfirmModal';

import removeFromCache from './remove-from-cache.js';

const DELETE_EXPORT_BAN_LIST_CONFIG = gql`
  mutation DeleteExportBanListConfig($id: Int!) {
    deleteExportBanListConfig(id: $id) {
      id
      exportBanList {
        id
      }
    }
  }
`;

// The Delete button for an export ban list's custom points for a ban list. It asks first, and says
// what changes: without them, that ban list's bans count for the list's default points. A paused ban
// list's bans count for nothing until it counts again, and the web server adds no custom points for
// it until then. onDeleted is called with the ban list's name once they are deleted.
export default function (props) {
  const { exportBanListConfig, exportBanList } = props;
  const { banList } = exportBanListConfig;
  const banListName = `${banList.organisation.name}'s ${banList.name}`;
  const { defaultActivePoints: active, defaultExpiredPoints: expired } = exportBanList;
  const defaultPoints = `${active} for an active ban and ${expired} for an expired ban`;

  const [confirming, setConfirming] = useState(false);
  const [deleteExportBanListConfig, { loading, error, data, reset }] = useMutation(
    DELETE_EXPORT_BAN_LIST_CONFIG,
    {
      update: removeFromCache,
      onCompleted: () => {
        setConfirming(false);
        if (props.onDeleted) props.onDeleted(banListName);
      }
    }
  );

  return (
    <>
      <Button
        color="danger"
        size="sm"
        disabled={loading}
        aria-label={`Delete the custom points for ${banListName}`}
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
        title={`Delete the custom points for ${banListName}?`}
        confirmLabel="Delete custom points"
        busyLabel="Deleting..."
        busy={loading}
        error={error}
        returnFocus={!loading && !data?.deleteExportBanListConfig}
        onCancel={() => setConfirming(false)}
        onConfirm={() => deleteExportBanListConfig({ variables: { id: exportBanListConfig.id } })}
      >
        {banList.paused ? (
          <p className="mb-0">
            {banListName} is paused, so its bans count for nothing for now. Once it counts again,
            they will count for this export ban list's default points: {defaultPoints}. Custom
            points for it cannot be added back while it is paused.
          </p>
        ) : (
          <p className="mb-0">
            Bans on {banListName} will count for this export ban list's default points:{' '}
            {defaultPoints}.
          </p>
        )}
      </ConfirmModal>
    </>
  );
}
