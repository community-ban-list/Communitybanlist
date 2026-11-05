import React from 'react';
import { Link } from 'react-router';

import { accountKind } from 'scbl-lib/player-ids';

import steamAvatar from '../../assets/img/misc/avatar.jpg';

// A player in a list, as a link to their page. A player listed under their EOS ID has no Steam
// name, so they show as the start and end of their EOS ID, marked EOS.
export default function (props) {
  if (!props.steamUser) return <span className="text-muted">Unknown player</span>;
  const { id, name, avatar } = props.steamUser;
  const eos = accountKind(id) === 'eos';

  return (
    <Link to={`/search/${id}`}>
      <span className="d-flex align-items-center">
        <span className="avatar avatar-sm rounded-circle">
          <img alt="..." src={avatar || steamAvatar} />
        </span>
        <span className="ms-2">
          <span className="mb-0 text-sm fw-bold" title={eos ? `EOS ID ${id}` : undefined}>
            {name || (eos ? `${id.slice(0, 8)}…${id.slice(-4)}` : id)}
          </span>
          {eos && <span className="badge bg-secondary ms-2">EOS</span>}
        </span>
      </span>
    </Link>
  );
}
