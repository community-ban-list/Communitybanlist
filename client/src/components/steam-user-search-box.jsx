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

export default function (props) {
  const [search, updateSearch] = useState(props.search || '');
  const navigate = useNavigate();

  return (
    <div className={classnames(props.frontpageVersion ? 'shadow' : '', props.className)}>
      <Form onSubmit={() => navigate(`/search/${search}`)}>
        <FormGroup>
          <InputGroup
            className={classnames({
              'input-group-alternative': props.frontpageVersion,
              'is-invalid':
                !props.frontpageVersion && search !== '' && !(search && search.match(/^[0-9]{17}$/))
            })}
          >
            <InputGroupText>
              <i className="fa fa-search" />
            </InputGroupText>

            <Input
              type="text"
              placeholder="Steam 64 ID"
              value={search}
              onChange={(e) => updateSearch(e.target.value)}
            />

            <Button
              color="primary"
              disabled={!props.frontpageVersion && !(search && search.match(/^[0-9]{17}$/))}
            >
              Search
            </Button>
          </InputGroup>
          <FormFeedback>A valid Steam 64 ID is a 17 digit number.</FormFeedback>
        </FormGroup>
      </Form>
    </div>
  );
}
