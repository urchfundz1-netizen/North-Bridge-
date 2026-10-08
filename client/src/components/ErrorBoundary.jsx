/**
 * Render-error boundary.
 *
 * React unmounts the whole tree when a component throws, so without this the
 * customer sees a blank white page. The error is logged with its component stack
 * for the console, and the supplied fallback is rendered in its place.
 */

import { Component } from 'react';

export class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // In a real deployment this is where the error would be reported to
    // monitoring; for now the console is enough to debug a render failure.
    console.error('Unhandled render error:', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    const { fallback, children } = this.props;

    if (!error) return children;
    if (typeof fallback === 'function') return fallback(error);
    return fallback ?? null;
  }
}
