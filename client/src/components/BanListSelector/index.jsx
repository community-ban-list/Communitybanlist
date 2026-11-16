import React from 'react';
import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';
import { Input } from 'reactstrap';

import { LoadError } from '../LoadStatus/index.jsx';

// Also read by the config form, to name the ban list chosen.
export const GET_BAN_LISTS = gql`
  query GetBanLists {
    banLists {
      id
      name

      organisation {
        id
        name
      }
    }
  }
`;

export default function (props) {
  const { loading, error, data, refetch } = useQuery(GET_BAN_LISTS);

  if (loading) return <p role="status">Loading...</p>;
  if (error) return <LoadError error={error} retry={refetch} small />;

  return (
    <Input type="select" {...props}>
      <option value={null}>Select a ban list...</option>
      {data.banLists.map((banList, key) => (
        <option value={banList.id} key={key}>
          {banList.organisation.name}'s {banList.name}
        </option>
      ))}
    </Input>
  );
}
