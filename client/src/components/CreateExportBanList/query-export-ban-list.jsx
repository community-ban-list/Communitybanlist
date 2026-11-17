import React from 'react';
import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';

import { CardBody } from 'reactstrap';

import { Loading, LoadError } from '../LoadStatus/index.jsx';
import MutateExportBanList from './mutate-export-ban-list';

// The list's configs are for the form, which checks changes to the list's settings with them.
const GET_EXPORT_BAN_LIST = gql`
  query GetExportBanList($id: Int!) {
    loggedInSteamUser {
      exportBanList(id: $id) {
        id
        name
        server
        type
        threshold
        defaultActivePoints
        defaultExpiredPoints
        maxBanAge
        discordWebhook

        exportBanListConfigs {
          id
          activePoints
          expiredPoints

          banList {
            id
            name

            organisation {
              id
              name
            }
          }
        }
      }
    }
  }
`;

export default function (props) {
  const { loading, error, data, refetch } = useQuery(GET_EXPORT_BAN_LIST, {
    variables: { id: props.exportBanListID }
  });

  if (loading)
    return (
      <CardBody>
        <Loading />
      </CardBody>
    );

  if (error)
    return (
      <CardBody>
        <LoadError error={error} retry={refetch} />
      </CardBody>
    );

  // loggedInSteamUser is null when the web server answers as signed out, e.g. as the sign-in has
  // expired.
  if (!data?.loggedInSteamUser?.exportBanList)
    return (
      <CardBody>
        <div className="text-center mt-2 mb-2">Unknown Export Ban List</div>
        <div className="btn-wrapper text-center">
          <i className="fas fa-question fa-4x" />
        </div>
        <div className="text-center mt-2 mb-2">We do not have this Steam user on record.</div>
      </CardBody>
    );

  return <MutateExportBanList exportBanList={data.loggedInSteamUser.exportBanList} />;
}
