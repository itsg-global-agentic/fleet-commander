// =============================================================================
// Fleet Commander — FetchErrorBanner Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

// ---------------------------------------------------------------------------
// Mock FleetContext — control fetchError value
// ---------------------------------------------------------------------------

let mockFetchError: string | null = null;

vi.mock('../../src/client/context/FleetContext', () => ({
  useTeams: () => ({
    teams: [],
    fetchError: mockFetchError,
  }),
}));

// Import after mocks
import { FetchErrorBanner } from '../../src/client/components/FetchErrorBanner';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FetchErrorBanner', () => {
  beforeEach(() => {
    mockFetchError = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when fetchError is null', () => {
    const { container } = render(<FetchErrorBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('renders warning banner when fetchError is set', () => {
    mockFetchError = 'Server error: 500 Internal Server Error';
    render(<FetchErrorBanner />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('displays the specific error message', () => {
    mockFetchError = 'Failed to fetch';
    render(<FetchErrorBanner />);
    expect(screen.getByText(/Data may be stale/)).toBeInTheDocument();
    expect(screen.getByText(/Failed to fetch/)).toBeInTheDocument();
  });

  it('displays the warning icon', () => {
    mockFetchError = 'Network error';
    render(<FetchErrorBanner />);
    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    // The warning icon is ⚠ (&#9888;)
    expect(alert.textContent).toContain('\u26A0');
  });
});
