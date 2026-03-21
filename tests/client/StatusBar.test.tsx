// =============================================================================
// Fleet Commander — StatusBar Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

// ---------------------------------------------------------------------------
// Mock FleetContext — control connected and lastEvent values
// ---------------------------------------------------------------------------

let mockConnected = true;
let mockLastEvent: Date | null = null;

vi.mock('../../src/client/context/FleetContext', () => ({
  useFleet: () => ({
    teams: [],
    selectedTeamId: null,
    setSelectedTeamId: () => {},
    connected: mockConnected,
    lastEvent: mockLastEvent,
  }),
}));

// Import after mocks
import { StatusBar } from '../../src/client/components/StatusBar';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StatusBar', () => {
  beforeEach(() => {
    mockConnected = true;
    mockLastEvent = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders "Connected" when connected is true', () => {
    render(<StatusBar />);
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('renders "Disconnected" when connected is false', () => {
    mockConnected = false;
    render(<StatusBar />);
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
  });

  it('renders a green dot when connected', () => {
    const { container } = render(<StatusBar />);
    const dot = container.querySelector('.rounded-full');
    expect(dot).toHaveClass('bg-green-500');
  });

  it('renders a red dot when disconnected', () => {
    mockConnected = false;
    const { container } = render(<StatusBar />);
    const dot = container.querySelector('.rounded-full');
    expect(dot).toHaveClass('bg-red-500');
  });

  it('does not show "Last update" when lastEvent is null', () => {
    render(<StatusBar />);
    expect(screen.queryByText(/Last update/)).not.toBeInTheDocument();
  });

  it('shows "Last update: Xs ago" when lastEvent is set', () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-03-21T10:00:10Z').getTime());
    mockLastEvent = new Date('2026-03-21T10:00:00Z');
    render(<StatusBar />);
    expect(screen.getByText('Last update: 10s ago')).toBeInTheDocument();
  });
});
