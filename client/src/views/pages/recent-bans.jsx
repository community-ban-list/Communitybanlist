import React from 'react';
import { Card, CardBody, Container, Table, UncontrolledTooltip } from 'reactstrap';

import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';

import Layout from '../layout/layout.jsx';

import { Loading, LoadError, LoadMore } from '../../components/LoadStatus/index.jsx';

import { BanDates, SteamUser } from '../../components';

const query = gql`
  query RecentBans($after: String) {
    bans(orderBy: "created", orderDirection: DESC, first: 20, after: $after) {
      edges {
        cursor
        node {
          id
          steamUser {
            id
            name
            avatar
          }
          banList {
            id
            name
            organisation {
              id
              name
              discord
            }
          }
          reason
          created
          expires
        }
      }
      pageInfo {
        hasPreviousPage
        hasNextPage
        startCursor
        endCursor
      }
    }
  }
`;

export default function () {
  const { loading, error, data, fetchMore, refetch } = useQuery(query);
  return (
    <Layout>
      <section className="section section-lg pt-lg-0 mt--200">
        <Container>
          <Card className="shadow border-0">
            <CardBody className="pt-5 pb-2">
              <div className="icon icon-shape bg-gradient-primary rounded-circle text-white mb-4">
                <i className="fa fa-clock" />
              </div>
              <h6 className="text-primary text-uppercase">Recent Bans</h6>
              <p className="description mt-2">
                View players recently banned on one of our many partner organisations.
              </p>
            </CardBody>
            <Table className="align-middle table-flush" responsive>
              <thead className="thead-light">
                <tr>
                  <th>Players</th>
                  <th>Ban List</th>
                  <th>
                    Reason
                    <span id="tooltip-reason-recent-bans">
                      <i className="ms-2 fa fa-question-circle" />
                    </span>
                    <UncontrolledTooltip
                      boundariesElement="viewport"
                      delay={0}
                      target="tooltip-reason-recent-bans"
                    >
                      The ban reasons shown on CommunityBanList.com are based on keywords found in
                      the reason and notes listed on partner organisations' ban lists. We cannot
                      guarantee that the reasons displayed reflect the true reason for the ban.
                      Please see our FAQ for more information.
                    </UncontrolledTooltip>
                  </th>
                  <th>
                    Time{' '}
                    <span id="tooltip-time-recent-bans">
                      <i className="ms-2 fa fa-question-circle" />
                    </span>
                    <UncontrolledTooltip
                      boundariesElement="viewport"
                      delay={0}
                      target="tooltip-time-recent-bans"
                    >
                      The ban times shown on CommunityBanList.com are based on the dates listed on
                      partner organisations' ban lists. In the case of remote ban lists, where ban
                      creation dates are not documented, the time shown is the time when we first
                      imported the ban.
                    </UncontrolledTooltip>
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={4} className="text-center">
                      <Loading />
                    </td>
                  </tr>
                )}
                {error && (
                  <tr>
                    <td colSpan={4} className="text-center">
                      <LoadError error={error} retry={refetch} />
                    </td>
                  </tr>
                )}
                {data && (
                  <>
                    {data.bans.edges.map((edge, key) => (
                      <tr key={key}>
                        <td>
                          <SteamUser steamUser={edge.node.steamUser} />
                        </td>
                        <td>
                          <a
                            href={edge.node.banList.organisation.discord}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-decoration-underline"
                          >
                            {edge.node.banList.organisation.name}
                          </a>
                          <br />
                          {edge.node.banList.name}
                        </td>
                        <td style={{ whiteSpace: 'pre-wrap' }}>
                          {edge.node.reason.replace(/, /g, '\n')}
                        </td>
                        <td>
                          <BanDates created={edge.node.created} expires={edge.node.expires} />
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td colSpan={4} className="text-center">
                        <LoadMore
                          hasNextPage={data.bans.pageInfo.hasNextPage}
                          fetchMore={() =>
                            fetchMore({
                              query,
                              variables: { after: data.bans.pageInfo.endCursor }
                            })
                          }
                        />
                      </td>
                    </tr>
                  </>
                )}
              </tbody>
            </Table>
          </Card>
        </Container>
      </section>
    </Layout>
  );
}
