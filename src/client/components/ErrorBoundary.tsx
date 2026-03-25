// =============================================================================
// Fleet Commander -- ErrorBoundary
// React Error Boundaries require class components (no functional equivalent).
// =============================================================================

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Top-level error boundary that catches unhandled React render errors and
 * displays a dark-themed fallback UI instead of a blank white screen.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[ErrorBoundary] Uncaught error:', error, errorInfo);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            width: '100vw',
            backgroundColor: '#0d1117',
            color: '#e6edf3',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
            padding: '2rem',
            textAlign: 'center',
          }}
        >
          <h1
            style={{
              fontSize: '1.5rem',
              fontWeight: 600,
              color: '#F85149',
              marginBottom: '1rem',
            }}
          >
            Something went wrong
          </h1>

          {this.state.error && (
            <p
              style={{
                fontSize: '0.875rem',
                color: '#8b949e',
                maxWidth: '36rem',
                marginBottom: '1.5rem',
                wordBreak: 'break-word',
              }}
            >
              {this.state.error.message}
            </p>
          )}

          <button
            type="button"
            onClick={this.handleReload}
            style={{
              padding: '0.5rem 1rem',
              fontSize: '0.875rem',
              fontWeight: 500,
              color: '#e6edf3',
              backgroundColor: 'transparent',
              border: '1px solid #30363d',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
