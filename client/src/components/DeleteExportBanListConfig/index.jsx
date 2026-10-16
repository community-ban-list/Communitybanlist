import React from 'react';
import { gql } from '@apollo/client';
import { useMutation } from '@apollo/client/react';

import graphQLErrors from '../../utils/graphql-errors.js';

import { Button } from 'reactstrap';

import { ErrorModal, LoadingModal } from '../';

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
