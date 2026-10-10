import React from 'react';
import { Link } from 'react-router';

import steamAvatar from '../../assets/img/misc/avatar.jpg';

export default function (props) {
  return (
    <Link to={`/search/${props.steamUser.id}`}>
      <span className="d-flex align-items-center">
        <span className="avatar avatar-sm rounded-circle">
          <img alt="..." src={props.steamUser.avatar || steamAvatar} />
        </span>
        <span className="ms-2">
          <span className="mb-0 text-sm fw-bold">{props.steamUser.name || props.steamUser.id}</span>
        </span>
      </span>
    </Link>
  );
}
