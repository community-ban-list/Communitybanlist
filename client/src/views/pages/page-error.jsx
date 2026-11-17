import React from 'react';

import { Button, Card, CardBody, Container } from 'reactstrap';

import Layout from '../layout/layout.jsx';

import ErrorBoundary from '../../components/ErrorBoundary/index.jsx';

function Message() {
  return (
    <div role="alert" className="text-center py-4">
      <i className="fas fa-exclamation-triangle fa-4x" aria-hidden="true" />
      <h4 className="mt-4">Something went wrong</h4>
      <p>This page could not be shown. Please reload it to try again.</p>
      <Button color="primary" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  );
}

// Shown in place of a page that failed to render, rather than the whole site going blank. If the
// site's layout is what failed, the message shows without it.
export default function PageError() {
  return (
    <ErrorBoundary fallback={<Message />}>
      <Layout>
        <section className="section section-lg pt-lg-0 mt--200">
          <Container>
            <Card className="shadow border-0">
              <CardBody>
                <Message />
              </CardBody>
            </Card>
          </Container>
        </section>
      </Layout>
    </ErrorBoundary>
  );
}
