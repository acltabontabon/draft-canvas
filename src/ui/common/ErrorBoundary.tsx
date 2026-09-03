import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './Button';

export interface ErrorBoundaryAction {
  label: string;
  onClick: () => void;
}

interface ErrorBoundaryProps {
  /** Diagnostics-only tag, never shown to the user. */
  scope: string;
  message: string;
  actions: ErrorBoundaryAction[];
  onError?: (error: Error, componentStack: string) => void;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * There is no hook-based error-boundary API in React — this must stay a
 * class component regardless of the rest of the codebase's function-only
 * convention.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
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
