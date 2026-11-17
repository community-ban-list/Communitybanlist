import React from 'react';

// Shows its fallback in place of its children once they fail to render, rather than React removing
// everything from the page, until resetKey changes, e.g. as the user goes to another address.
export default class ErrorBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prevProps, prevState) {
    // The update that caught the error is left alone, as the change of resetKey may be what led to
    // the error, and trying again at once would fail again.
    if (this.state.error && prevState.error && prevProps.resetKey !== this.props.resetKey)
      this.setState({ error: null });
  }

  render() {
    return this.state.error ? this.props.fallback : this.props.children;
  }
}
