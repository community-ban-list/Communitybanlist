import React from 'react';
import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';
import { Table } from 'reactstrap';

import { CreateExportBanListConfig, DeleteExportBanListConfig } from '../';

// The list's settings are for the config form, which checks a config against them.
const GET_EXPORT_BAN_LIST_CONFIGS = gql`
  query GetExportBanListConfigs($exportBanListID: Int!) {
    loggedInSteamUser {
      exportBanList(id: $exportBanListID) {
        id
        type
        threshold
        defaultActivePoints
        defaultExpiredPoints
        maxBanAge

        exportBanListConfigs {
          id
          activePoints
          expiredPoints

          banList {
            id
            name
            paused

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
  const { loading, error, data } = useQuery(GET_EXPORT_BAN_LIST_CONFIGS, {
    variables: { exportBanListID: props.exportBanListID }
  });

  return (
    <>
      <Table className="align-middle table-flush" responsive>
        <thead className="thead-light">
          <tr>
            <th>Ban List</th>
            <th>Active Points</th>
            <th>Expired Points</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {/* The edit form's query may have cached the configs already. */}
          {loading && !data && (
            <tr>
              <td colSpan={4} className="text-center">
                <div className="text-center mt-2 mb-3">Loading...</div>
                <div className="btn-wrapper text-center">
                  <i className="fas fa-circle-notch fa-spin fa-4x" />
                </div>
              </td>
            </tr>
          )}
          {error && (
            <tr>
              <td colSpan={4} className="text-center">
                <div className="text-center mt-2 mb-2">Error!</div>
                <div className="btn-wrapper text-center">
                  <i className="fas fa-exclamation-triangle fa-4x" />
                </div>
                <div className="text-center mt-2 mb-2">
                  [ERR 1] Something went wrong. Sad times.
                </div>
              </td>
            </tr>
          )}
          {data && data.loggedInSteamUser?.exportBanList && (
            <>
              {data.loggedInSteamUser.exportBanList.exportBanListConfigs.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-center">
                    <strong>You have no custom ban list point configurations.</strong>
                  </td>
                </tr>
              )}
              {data.loggedInSteamUser.exportBanList.exportBanListConfigs.map(
                (exportBanListConfig, key) => (
                  <tr key={key}>
                    <th>
                      {exportBanListConfig.banList.organisation.name}'s{' '}
                      {exportBanListConfig.banList.name}
                      {exportBanListConfig.banList.paused && (
                        <div className="small text-muted fw-normal">
                          Paused: its bans count for nothing until it is resumed. This config is
                          kept.
                        </div>
                      )}
                    </th>
                    <td>{exportBanListConfig.activePoints}</td>
                    <td>{exportBanListConfig.expiredPoints}</td>
                    <td>
                      <DeleteExportBanListConfig exportBanListConfigID={exportBanListConfig.id} />
                    </td>
                  </tr>
                )
              )}
            </>
          )}
        </tbody>
      </Table>
      <CreateExportBanListConfig
        exportBanListID={props.exportBanListID}
        exportBanList={data?.loggedInSteamUser?.exportBanList}
      />
    </>
  );
}
