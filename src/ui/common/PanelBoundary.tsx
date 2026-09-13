import { Component, type ErrorInfo, type ReactNode } from 'react';

interface PanelBoundaryProps {
  /** Called once per failure — the owner closes the panel, says so, and resets its loader. */
  onError: (error: Error, componentStack: string) => void;
  children: ReactNode;
}

/**
 * Contains a failing panel (its chunk, or its own render) to the panel: it renders nothing and hands
 * the failure to its owner, where an uncaught error would take down the whole editor — and, since a
 * panel's open flag outlives the crash, take it down again on every document opened afterwards.
 */
export class PanelBoundary extends Component<PanelBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError(error, info.componentStack ?? '');
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
