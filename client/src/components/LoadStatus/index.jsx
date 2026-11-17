import React, { useState } from 'react';

import { Button } from 'reactstrap';

import { loadErrorMessages } from '../../utils/graphql-errors.js';

// Each of these is marked load-status: in a row across a table, it keeps to the part of the table
// in view and wraps, as on a narrow screen the table scrolls sideways (theme/_components.scss).

// What a page or list shows while it loads. The page's footer waits while it shows (see
// theme/_sections.scss), so the footer is not drawn under it and then pushed down as the content
// arrives.
export function Loading() {
  return (
    <div role="status" className="load-status loading-placeholder">
      <div className="text-center mt-2 mb-3">Loading...</div>
      <div className="btn-wrapper text-center">
        <i className="fas fa-circle-notch fa-spin fa-4x" aria-hidden="true" />
      </div>
    </div>
  );
}

// What a page or list shows when it could not be loaded: why, and, with retry, a button that loads
// it again. retry returns a promise, as a query's refetch does. The query's own error shows how the
// new try went, so the button only says that it is trying. A small one fits in a form.
export function LoadError(props) {
  const [retrying, setRetrying] = useState(false);
  const messages = loadErrorMessages(props.error);

  return (
    <div className={`load-status ${props.small ? 'mb-3' : 'text-center mt-2 mb-2'}`}>
      <div role="alert">
        {!props.small && (
          <>
            <div className="mb-2">Error!</div>
            <div className="btn-wrapper">
              <i className="fas fa-exclamation-triangle fa-4x" aria-hidden="true" />
            </div>
          </>
        )}
        {messages.map((message) => (
          <div className={props.small ? 'mb-2' : 'mt-2 mb-2'} key={message}>
            {message}
          </div>
        ))}
      </div>
      {props.retry && (
        <Button
          color="primary"
          size={props.small ? 'sm' : undefined}
          onClick={() => {
            if (retrying) return;
            setRetrying(true);
            const done = () => setRetrying(false);
            Promise.resolve(props.retry()).then(done, done);
          }}
        >
          {retrying ? 'Trying again...' : 'Try again'}
        </Button>
      )}
    </div>
  );
}

// The Load More button under a list. fetchMore loads the next page and returns a promise, as a
// query's fetchMore does. The button says while the page loads, and why it could not be loaded,
// which leaves the list as it was. It stays focusable while loading, so a keyboard user keeps their
// place, and a second press is ignored.
export function LoadMore(props) {
  const [state, setState] = useState({ loading: false, error: null });

  return (
    <div className="load-status">
      {state.error && (
        <div role="alert" className="mb-3">
          Could not load more. {loadErrorMessages(state.error).join(' ')}
        </div>
      )}
      <Button
        color="primary"
        disabled={!props.hasNextPage}
        onClick={() => {
          if (state.loading) return;
          setState({ loading: true, error: null });
          Promise.resolve(props.fetchMore()).then(
            () => setState({ loading: false, error: null }),
            (error) => setState({ loading: false, error })
          );
        }}
      >
        <i
          className={`fa ${state.loading ? 'fa-circle-notch fa-spin' : 'fa-angle-double-down'} me-2`}
          aria-hidden="true"
        />
        {state.loading ? 'Loading...' : 'Load More'}
      </Button>
    </div>
  );
}
