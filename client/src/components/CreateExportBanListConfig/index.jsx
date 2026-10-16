import React from 'react';
import { gql } from '@apollo/client';
import { useMutation } from '@apollo/client/react';

import graphQLErrors from '../../utils/graphql-errors.js';

import { ErrorModal, LoadingModal } from '../';

import addToCache from './add-to-cache.js';
import Form from './form';

const CREATE_EXPORT_BAN_LIST_CONFIG = gql`
  mutation CreateExportBanListConfig(
    $exportBanList: Int!
    $banList: Int!
    $activePoints: Int!
    $expiredPoints: Int!
  ) {
    createExportBanListConfig(
      exportBanList: $exportBanList
      banList: $banList
      activePoints: $activePoints
      expiredPoints: $expiredPoints
    ) {
      id
      activePoints
      expiredPoints

      exportBanList {
        id
        name
      }
    }
  }
`;

export default function (props) {
  const [createExportBanListConfig, { loading, error }] = useMutation(
    CREATE_EXPORT_BAN_LIST_CONFIG,
    { update: addToCache }
  );

  return (
    <>
      {loading && <LoadingModal />}
      {error && <ErrorModal errors={graphQLErrors(error)} />}
      <Form
        {...props}
        onSubmit={async (data) => {
          await createExportBanListConfig({
            variables: { ...data, exportBanList: props.exportBanListID }
          });
        }}
      />
    </>
  );
}
