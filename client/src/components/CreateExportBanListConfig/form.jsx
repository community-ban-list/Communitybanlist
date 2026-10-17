import React from 'react';
import { useQuery } from '@apollo/client/react';
import { useForm, Controller } from 'react-hook-form';
import {
  Button,
  CardBody,
  Col,
  Form,
  FormFeedback,
  FormGroup,
  FormText,
  Input,
  Label,
  Row
} from 'reactstrap';

import { EXPORT_LIST_LIMITS } from 'scbl-lib/config';

import { CONFIG_FIELDS, configFormOptions } from '../../utils/export-list-forms.js';

import { BanListSelector } from '../';
import { GET_BAN_LISTS } from '../BanListSelector';

export default function (props) {
  // The ban lists that BanListSelector looks up, read from the cache, so the points rules' messages
  // can name the one chosen.
  const { data: banListsData } = useQuery(GET_BAN_LISTS, { fetchPolicy: 'cache-only' });

  // The form checks the config against the limits on export ban lists as the owner types, with
  // the list's settings and configs, as the web server will.
  const {
    register,
    handleSubmit,
    control,
    formState: { errors }
  } = useForm(configFormOptions(props.exportBanList, banListsData?.banLists, EXPORT_LIST_LIMITS));

  // reactstrap's Input takes the ref as innerRef.
  const registerInput = (name) => {
    const { ref, ...rest } = register(name, CONFIG_FIELDS[name]);
    return { ...rest, innerRef: ref };
  };

  return (
    <>
      <CardBody>
        <Form onSubmit={handleSubmit(props.onSubmit)}>
          <Row>
            <Col xs="12">
              <FormGroup>
                <Label>Ban List</Label>
                <Controller
                  name="banList"
                  control={control}
                  rules={CONFIG_FIELDS.banList}
                  render={({ field }) => (
                    <BanListSelector
                      onChange={(e) => field.onChange(e.target.value)}
                      checked={field.value}
                      invalid={errors.banList?.message}
                    />
                  )}
                />
                <FormText>Please select a ban list to apply the custom points values to.</FormText>
                <FormFeedback>{errors.banList?.message}</FormFeedback>
              </FormGroup>
            </Col>
            <Col xs="6">
              <FormGroup>
                <Label>Number of points for active bans</Label>
                <Input
                  type="number"
                  {...registerInput('activePoints')}
                  invalid={!!(errors.activePoints?.message || errors.points?.message)}
                />
                <FormText>
                  Please provide a number of points a player gets for each active ban in the
                  specified ban list.
                </FormText>
                <FormFeedback>{errors.activePoints?.message}</FormFeedback>
              </FormGroup>
            </Col>
            <Col xs="6">
              <FormGroup>
                <Label>Number of points for expired bans</Label>
                <Input
                  type="number"
                  {...registerInput('expiredPoints')}
                  invalid={!!(errors.expiredPoints?.message || errors.points?.message)}
                />
                <FormText>
                  Please provide a number of points a player gets for each expired ban in the
                  specified ban list.
                </FormText>
                <FormFeedback>{errors.expiredPoints?.message}</FormFeedback>
              </FormGroup>
            </Col>
            {errors.points?.message && (
              <Col xs="12">
                {/* The points rules' problems are about both points, so they show under both. */}
                <FormFeedback className="d-block mb-3">{errors.points.message}</FormFeedback>
              </Col>
            )}
            <Col xs="12" className="text-center">
              <Button color="info">Add</Button>
            </Col>
          </Row>
        </Form>
      </CardBody>
    </>
  );
}
