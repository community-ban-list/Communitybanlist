import React from 'react';
import { gql } from '@apollo/client';
import { useMutation } from '@apollo/client/react';

import graphQLErrors from '../../utils/graphql-errors.js';
import { Navigate } from 'react-router';

import { ErrorModal, LoadingModal } from '../';

import addToCache from './add-to-cache.js';
import Form from './form';

const CREATE_EXPORT_BAN_LIST = gql`
  mutation CreateExportBanList(
    $name: String!
    $server: String!
    $type: String!
    $threshold: Int
    $defaultActivePoints: Int
    $defaultExpiredPoints: Int
    $maxBanAge: Int
    $discordWebhook: String
  ) {
    createExportBanList(
      name: $name
      server: $server
      type: $type
      threshold: $threshold
      defaultActivePoints: $defaultActivePoints
      defaultExpiredPoints: $defaultExpiredPoints
      maxBanAge: $maxBanAge
      discordWebhook: $discordWebhook
    ) {
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
  }
`;

const UPDATE_EXPORT_BAN_LIST = gql`
  mutation UpdateExportBanList(
    $id: Int!
    $name: String!
    $server: String!
    $threshold: Int
    $defaultActivePoints: Int
    $defaultExpiredPoints: Int
    $maxBanAge: Int
    $discordWebhook: String
  ) {
    updateExportBanList(
      id: $id
      name: $name
      server: $server
      threshold: $threshold
      defaultActivePoints: $defaultActivePoints
      defaultExpiredPoints: $defaultExpiredPoints
      maxBanAge: $maxBanAge
      discordWebhook: $discordWebhook
    ) {
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
  }
`;

export default function (props) {
  const [mutateExportBanList, { loading, error, data }] = useMutation(
    props.exportBanList ? UPDATE_EXPORT_BAN_LIST : CREATE_EXPORT_BAN_LIST,
    {
      update: props.exportBanList ? undefined : addToCache
    }
  );

  if (!error && data && props.exportBanList) return <Navigate to="/export-ban-lists" replace />;
  if (!error && data && !props.exportBanList)
    return <Navigate to={`/export-ban-lists/${data.createExportBanList.id}`} replace />;

  return (
    <>
      {loading && <LoadingModal />}
      {error && <ErrorModal errors={graphQLErrors(error)} />}
      <Form
        {...props}
        onSubmit={async (data) => {
          await mutateExportBanList({
            variables: props.exportBanList ? { ...data, id: props.exportBanList.id } : data
          });
        }}
      />
    </>
  );
}
