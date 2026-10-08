import React from 'react';
import { gql } from '@apollo/client';
import { useMutation } from '@apollo/client/react';

import graphQLErrors from '../../utils/graphql-errors.js';

import { Button } from 'reactstrap';

import { ErrorModal, LoadingModal } from '../';

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

function removeFromCache(cache, { data: { deleteExportBanListConfig } }) {
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

export default function (props) {
  const [deleteExportBanListConfig, { loading, error }] = useMutation(
    DELETE_EXPORT_BAN_LIST_CONFIG,
    {
      update: removeFromCache
    }
  );

  return (
    <>
      {loading && <LoadingModal />}
      {error && <ErrorModal errors={graphQLErrors(error)} />}
      <Button
        color="danger"
        size="sm"
        onClick={() => {
          deleteExportBanListConfig({ variables: { id: props.exportBanListConfigID } });
        }}
      >
        Delete
      </Button>
    </>
  );
}
