import React from 'react';
import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';

import { CardBody, Col, Row } from 'reactstrap';

import { SteamUser } from '../index';
import { Loading, LoadError } from '../LoadStatus/index.jsx';

const GET_RECENTLY_VIEWED_PLAYERS = gql`
  query {
    steamUsers(orderBy: "lastViewed", orderDirection: DESC, first: 12) {
      edges {
        cursor
        node {
          id
          name
          avatar
          reputationPoints
          reputationRank
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
  const { loading, error, data, refetch } = useQuery(GET_RECENTLY_VIEWED_PLAYERS);

  return (
    <CardBody>
      <Row>
        <Col xs="12" className="text-center">
          <h5>Recently Viewed Players</h5>
        </Col>
        {data &&
          data.steamUsers.edges.map((edge, key) => (
            <Col md="4" className="py-2" key={key}>
              <SteamUser steamUser={edge.node} />
            </Col>
          ))}
      </Row>
      {loading && <Loading />}
      {error && <LoadError error={error} retry={refetch} />}
    </CardBody>
  );
}
