import React from 'react';
import { Card, CardBody, Container } from 'reactstrap';

import { DISCORD_INVITE } from 'scbl-lib/config';

import Layout from '../layout/layout.js';

export default function () {
  return (
    <Layout>
      <section className="section section-lg pt-lg-0 mt--200">
        <Container>
          <Card className="shadow border-0">
            <CardBody className="pt-5 pb-2 border-bottom">
              <div className="icon icon-shape bg-gradient-success rounded-circle text-white mb-4">
                <i className="fa fa-angle-double-up" />
              </div>
              <h6 className="text-success text-uppercase">Become a Partner Organisation</h6>
              <p className="description mt-2">
                Join the fight against harmful players by contributing ban information to
                CommunityBanList.com!
              </p>
            </CardBody>
            <CardBody className="border-bottom">
              <h3>Introduction to Partner Organisations</h3>
              <p>
                Partner organisations are gaming communities that contribute ban information from
                their server's ban lists to the CommunityBanList.com database. Any Gaming community
                can become a partner organization providing they apply and are accepted on our
                discord.
              </p>
              <p>
                Becoming a partner organization requires very little effort. We request that you
                submit an application on our discord to become a partner and agree to the terms in
                that application. We primarily import bans from Battlemetrics and remote ban lists,
                but can easily add support for custom formats on request. Once your community is
                added to our system we will frequently automatically sync our database with your ban
                list and require no further involvement from you. We will share information from
                your ban list on this website and to Discord servers, however, this information is
                limited to the Steam ID of the banned player, the period of their ban and a list of
                categorized keywords found in their ban reason. We categorize ban reasons based on
                keywords for consistency, to maintain professionalism and to allow you to keep
                confidential notes in their ban lists private.
              </p>
              <p>
                There are currently no benefits to being a partner organization, however, everyone
                benefits from our partner organizations as the more partner organizations that
                contribute information on players the more effective CommunityBanList.com becomes in
                protecting the integrity of our partner's communities so, please consider
                contributing to thank others for their contributions.
              </p>
            </CardBody>
            <CardBody>
              <h3>Partner Agreement</h3>
              <p>
                <h4>Ban Evidence</h4>
              </p>
              <p>
                Community Ban List is not responsible for retaining Ban Evidence. Community Ban List
                does not import any Ban Evidence into our Databases. The Partner Organization is
                responsible for the storage of any Ban Evidence or Summary of Events leading to a
                Ban.
              </p>
              <p>
                Partner Organizations agree to share Ban Evidence or a Summary of Events with other
                Partners upon request.
              </p>
              <p>
                Partner Organizations that Export Player Bans to the Community Ban List Database
                agree to act in good faith when submitting Bans to Community Ban List.
                <p>
                  <b>
                    Bans Exported to Community Ban List must have occurred on your Game Server(s).
                    Bans that did not occur on your Game Server(s) may NOT be Exported to Community
                    Ban List.
                  </b>
                </p>
              </p>
              <p>
                Failure to act in good faith, or cooperate with Partners, undermines the Community
                Ban List and may result in a Partner Organization being removed.
              </p>
              <br />
              <p>
                <h4>Partner Organization Representative</h4>
              </p>
              <p>
                Partner Organizations shall have at least one active Representative from their
                Community in the Community Ban List Discord for purposes of any important or needed
                communications with Community Ban List Staff and other Partner Organizations.
              </p>
              <p>
                If the Partner Organization&#39;s Representative becomes inactive or unresponsive to
                requests from Community Ban List Staff or other Partner Organization Representatives
                the Partner Organization shall replace their Representative or risk having their
                Organization removed from the Community Ban List service.
              </p>
              <h5>Form</h5>
              <p>
                If you are interested in becoming a partner organisation, please follow the
                instructions on our <a href={DISCORD_INVITE}>Discord</a>.
              </p>
              <br />
              <h6>Notes</h6>
              <p>
                <ul>
                  <li>
                    The ban list name is intended for communities with multiple ban lists or who may
                    wish to share additional information on what their ban list contains, such as if
                    their ban list contains bans from multiple different games. In this case, ban
                    lists should be named to communicate what the ban list contains, e.g. "Hate
                    speech ban list". If this is not the case, you may leave the ban list name as
                    "Public Server".
                  </li>
                  <li>
                    The ban list link should either be a link to a remote ban list or a
                    Battlemetrics ban list invite. Battlemetrics ban list invites can be obtained by
                    navigating to <a href="https://www.battlemetrics.com/rcon/ban-lists">here</a>,
                    clicking "Share" on the appropriate ban list and generating an invite using the
                    default options. If your ban list uses a different format please state that in
                    your request and we will request further information from you.
                  </li>
                </ul>
              </p>
              <br />
              <p>
                If you wish to stop contributing as a partner organisation, please contact us on our{' '}
                <a href={DISCORD_INVITE}>Discord</a>.
              </p>
            </CardBody>
          </Card>
        </Container>
      </section>
    </Layout>
  );
}
