import React from 'react';
import { useForm } from 'react-hook-form';
import {
  Alert,
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

import {
  LIST_FIELDS,
  OUTSIDE_LIMITS_NOTE,
  listFormOptions,
  outsideLimits
} from '../../utils/export-list-forms.js';

import { ExportBanListConfigs } from '../';

export default function (props) {
  // The form checks its values against the limits on export ban lists as the owner types, as the
  // web server will: a new list's every setting, or the changes to a saved list.
  const {
    register,
    handleSubmit,
    formState: { errors }
  } = useForm(listFormOptions(props.exportBanList, EXPORT_LIST_LIMITS));

  // reactstrap's Input takes the ref as innerRef.
  const registerInput = (name) => {
    const { ref, ...rest } = register(name, LIST_FIELDS[name]);
    return { ...rest, innerRef: ref };
  };

  // A saved list outside today's limits keeps working, but the owner should know that some changes
  // cannot be undone, and why.
  const outside = outsideLimits(props.exportBanList, EXPORT_LIST_LIMITS);

  return (
    <>
      <CardBody>
        <Form onSubmit={handleSubmit(props.onSubmit)}>
          {outside.length > 0 && (
            <Alert color="warning">
              <p>{OUTSIDE_LIMITS_NOTE}</p>
              <p className="mb-0">{outside[0].message}</p>
            </Alert>
          )}
          <Row>
            <Col xs="12">
              <FormGroup>
                <Label>Name</Label>
                <Input type="text" {...registerInput('name')} invalid={!!errors.name?.message} />
                <FormText>
                  Please provide a name for your export ban list so it can be identified in the
                  future.
                </FormText>
                <FormFeedback>{errors.name?.message}</FormFeedback>
              </FormGroup>
            </Col>
            <Col xs="12">
              <FormGroup>
                <Label>Community/Server Name</Label>
                <Input
                  type="text"
                  {...registerInput('server')}
                  invalid={!!errors.server?.message}
                />
                <FormText>
                  Please provide us with the name of your community/server so we can see who is
                  using CBL.
                </FormText>
                <FormFeedback>{errors.server?.message}</FormFeedback>
              </FormGroup>
            </Col>
            <Col xs="12">
              <FormGroup>
                <Label>Type</Label>
                <Input
                  type="select"
                  {...registerInput('type')}
                  invalid={errors.type?.message}
                  disabled={props.exportBanList}
                >
                  <option value="remote">Remote</option>
                  <option value="battlemetrics">Battlemetrics</option>
                </Input>
                <FormText>
                  Please select an export ban list type. Export ban lists can either be imported as
                  a remote ban list or shared with you via Battlemetrics.
                </FormText>
                <FormFeedback>{errors.type?.message}</FormFeedback>
              </FormGroup>
            </Col>
            <Col xs="12">
              <FormGroup>
                <Label>Threshold</Label>
                <Input
                  type="number"
                  {...registerInput('threshold')}
                  invalid={!!errors.threshold?.message}
                />
                <FormText>
                  Please provide a threshold for your export ban list. Once the sum of the points
                  for a player's bans equals or exceeds this number they will be added to your
                  export ban list.
                </FormText>
                <FormFeedback>{errors.threshold?.message}</FormFeedback>
              </FormGroup>
            </Col>
            <Col xs="6">
              <FormGroup>
                <Label>Default number of points for active bans</Label>
                <Input
                  type="number"
                  {...registerInput('defaultActivePoints')}
                  invalid={!!errors.defaultActivePoints?.message}
                />
                <FormText>
                  Please provide a default number of points a player gets for each active ban.
                </FormText>
                <FormFeedback>{errors.defaultActivePoints?.message}</FormFeedback>
              </FormGroup>
            </Col>
            <Col xs="6">
              <FormGroup>
                <Label>Default number of points for expired bans</Label>
                <Input
                  type="number"
                  {...registerInput('defaultExpiredPoints')}
                  invalid={!!errors.defaultExpiredPoints?.message}
                />
                <FormText>
                  Please provide a default number of points a player gets for each expired ban.
                </FormText>
                <FormFeedback>{errors.defaultExpiredPoints?.message}</FormFeedback>
              </FormGroup>
            </Col>
            <Col xs="12">
              <FormGroup>
                <Label>Max Ban Age (in Days)</Label>
                <Input
                  type="text"
                  {...registerInput('maxBanAge')}
                  invalid={!!errors.maxBanAge?.message}
                />
                <FormText>
                  Please provide a max age for bans in days. Once a ban exceeds this age they will
                  contribute no points to a player's total. Use 0 to ignore ban age.
                </FormText>
                <FormFeedback>{errors.maxBanAge?.message}</FormFeedback>
              </FormGroup>
            </Col>
            <Col xs="12">
              <FormGroup>
                <Label>Discord Webhook (Optional)</Label>
                <Input
                  type="text"
                  {...registerInput('discordWebhook')}
                  invalid={!!errors.discordWebhook?.message}
                />
                <FormText>
                  You may supply a Discord webhook address in order to receive updates when players
                  are added or removed from your export ban list.
                </FormText>
                <FormFeedback>{errors.discordWebhook?.message}</FormFeedback>
              </FormGroup>
            </Col>
            <Col xs="12" className="text-center">
              <Button color="info">Save</Button>
            </Col>
            <Col xs="12" className="">
              <p className="mt-4">
                Bans are not immediately added to export ban lists after creation or modification.
                Instead, they will be added when our database is next synchronised with our partner
                organisations' ban lists.
              </p>
              {!props.exportBanList && (
                <p>
                  You will be able to configure the number of points for each ban list independently
                  once the export ban list has been created.
                </p>
              )}
            </Col>
          </Row>
        </Form>
      </CardBody>
      {props.exportBanList && <ExportBanListConfigs exportBanListID={props.exportBanList.id} />}
    </>
  );
}
