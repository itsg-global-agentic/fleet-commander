// =============================================================================
// Fleet Commander -- ErrorBoundary Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ErrorBoundary } from '../../src/client/components/ErrorBoundary';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A component that throws on render, used to trigger the error boundary. */
function ThrowingComponent({ message }: { message: string }) {
  throw new Error(message);
}

/** A harmless child component for the happy-path test. */
function GoodChild() {
  return <p>All systems nominal</p>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ErrorBoundary', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Suppress noisy console.error output from React and componentDidCatch
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('renders children when no error is thrown', () => {
    render(
      <ErrorBoundary>
        <GoodChild />
      </ErrorBoundary>,
    );

    expect(screen.getByText('All systems nominal')).toBeInTheDocument();
  });

  it('renders fallback UI when a child throws', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent message="kaboom" />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('displays the error message in the fallback', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent message="flux capacitor overload" />
      </ErrorBoundary>,
    );

    expect(screen.getByText('flux capacitor overload')).toBeInTheDocument();
  });

  it('renders a Reload button in the fallback', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent message="oops" />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('calls window.location.reload when the Reload button is clicked', () => {
    const reloadMock = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadMock },
      writable: true,
    });

    render(
      <ErrorBoundary>
        <ThrowingComponent message="oops" />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

    expect(reloadMock).toHaveBeenCalledOnce();
  });

  it('logs the error via console.error', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent message="log-test" />
      </ErrorBoundary>,
    );

    expect(consoleErrorSpy).toHaveBeenCalled();
    const callArgs = consoleErrorSpy.mock.calls.flat().map(String);
    expect(callArgs.some((arg) => arg.includes('log-test'))).toBe(true);
  });
});
