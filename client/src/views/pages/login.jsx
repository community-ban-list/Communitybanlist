import React, { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { Button, Card, CardHeader, Container, Row, Col } from 'reactstrap';

import Layout from '../layout/layout.jsx';

import Auth from '../../utils/auth.js';

export default function () {
  const navigate = useNavigate();

  const urlParams = new URLSearchParams(window.location.search);
  const signingIn = Auth.isLoggedIn === false && urlParams.get('openid.claimed_id') !== null;
  // Steam's answer can only be used once, so a sign-in that failed is not tried again with it.
  const [failed, setFailed] = useState(false);

  // Hooks must run on every render, so the effect checks whether to sign in. Calling it only while
  // signing in crashed the page once React Router 7's useNavigate added hooks of its own.
  useEffect(() => {
    if (!signingIn || failed) return;
    Auth.attemptAuth(window.location.search).then((signedIn) => {
      if (signedIn) navigate('/login', { replace: true });
      else setFailed(true);
    });
  });

  // Is fully logged in
  if (Auth.isLoggedIn && Auth.saveToken !== null) return <Navigate to="/" replace />;

  // Is logged in, but not selected remember me option
  if (Auth.isLoggedIn && Auth.saveToken === null)
    return (
      <Layout>
        <section className="section section-lg pt-lg-0 mt--100">
          <Container>
            <Row className="justify-content-center">
              <Col lg="5">
                <Card className="shadow border-0">
                  <CardHeader className="bg-transparent pb-5">
                    <div className="text-muted text-center mt-2 mb-3">
                      <small>Remember Me?</small>
                    </div>
                    <div className="btn-wrapper text-center">
                      <Button
                        color="default"
                        onClick={() => {
                          Auth.saveToken = false;
                          navigate('/');
                        }}
                      >
                        <i className="fas fa-times me-2" />
                        No thanks!
                      </Button>
                      <Button
                        color="default"
                        onClick={() => {
                          Auth.saveToken = true;
                          Auth.storeToken();
                          navigate('/');
                        }}
                      >
                        <i className="fas fa-check me-2" />
                        Yes please!
                      </Button>
                    </div>
                  </CardHeader>
                </Card>
              </Col>
            </Row>
          </Container>
        </section>
      </Layout>
    );

  // Not logged in, but has auth option
  if (signingIn) {
    return (
      <Layout>
        <section className="section section-lg pt-lg-0 mt--100">
          <Container>
            <Row className="justify-content-center">
              <Col lg="5">
                <Card className="shadow border-0">
                  <CardHeader className="bg-transparent pb-5">
                    <div className="text-center mt-2 mb-3">
                      {failed ? 'Sign-in failed, please try again.' : 'Loading...'}
                    </div>
                    <div className="btn-wrapper text-center">
                      {failed ? (
                        <Button color="default" href="/auth/steam">
                          Try again
                        </Button>
                      ) : (
                        <i className="fas fa-circle-notch fa-spin fa-4x" />
                      )}
                    </div>
                  </CardHeader>
                </Card>
              </Col>
            </Row>
          </Container>
        </section>
      </Layout>
    );
  }

  window.location.href = '/auth/steam';
  return null;
}
