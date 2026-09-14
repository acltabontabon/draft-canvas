import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './Button';

export interface ErrorBoundaryAction {
  label: string;
  onClick: () => void;
}

interface ErrorBoundaryProps {
  message: string;
  actions: ErrorBoundaryAction[];
  onError?: (error: Error, componentStack: string) => void;
  /** A change to this clears the error and renders the children again — the screen they show
   *  changed (the canvas that crashed was closed), so there's something new worth trying. */
  resetKey?: unknown;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  /** The `resetKey` the current error happened under. */
  resetKey: unknown;
}

/**
 * There is no hook-based error-boundary API in React — this must stay a
 * class component regardless of the rest of the codebase's function-only
 * convention.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState): Partial<ErrorBoundaryState> | null {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info.componentStack ?? '');
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="dc-error-boundary" role="alert">
        <p className="dc-error-boundary-message">{this.props.message}</p>
        <div className="dc-error-boundary-actions">
          {this.props.actions.map((action) => (
            <Button key={action.label} variant="quiet" onClick={action.onClick}>
              {action.label}
            </Button>
          ))}
        </div>
      </div>
    );
  }
}
