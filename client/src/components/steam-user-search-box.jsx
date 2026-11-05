import React, { useState } from 'react';
import { useNavigate } from 'react-router';
import classnames from 'classnames';
import {
  Button,
  Form,
  FormFeedback,
  FormGroup,
  Input,
  InputGroup,
  InputGroupText
} from 'reactstrap';

import { parsePlayerInput } from 'scbl-lib/player-ids';

export default function (props) {
  const [search, updateSearch] = useState(props.search || '');
  const navigate = useNavigate();
  // The player's ID as CBL stores it, so an EOS ID in capitals or a Steam profile's address finds
  // the same page as the ID itself.
  const player = parsePlayerInput(search);

  return (
    <div className={classnames(props.frontpageVersion ? 'shadow' : '', props.className)}>
      <Form onSubmit={() => navigate(`/search/${player?.id ?? search}`)}>
        <FormGroup>
          <InputGroup
            className={classnames({
              'input-group-alternative': props.frontpageVersion,
              'is-invalid': !props.frontpageVersion && search !== '' && !player
            })}
          >
            <InputGroupText>
              <i className="fa fa-search" />
            </InputGroupText>

            <Input
              type="text"
              placeholder="Steam 64 ID or EOS ID"
              value={search}
              onChange={(e) => updateSearch(e.target.value)}
            />

            <Button color="primary" disabled={!props.frontpageVersion && !player}>
              Search
            </Button>
          </InputGroup>
          <FormFeedback>
            Enter a Steam 64 ID, which is a 17 digit number, or an EOS ID, which is 32 characters
            made of the digits 0-9 and the letters a-f.
          </FormFeedback>
        </FormGroup>
      </Form>
    </div>
  );
}
