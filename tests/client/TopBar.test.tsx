// =============================================================================
// Fleet Commander — TopBar Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { TeamDashboardRow } from '../../src/shared/types';
import { makeTeam } from './test-utils';

// ---------------------------------------------------------------------------
// Mock the FleetContext module so TopBar's useTeams() returns controlled data
// ---------------------------------------------------------------------------

let mockTeams: TeamDashboardRow[] = [];

vi.mock('../../src/client/context/FleetContext', () => ({
  useTeams: () => ({
    teams: mockTeams,
    fetchError: null,
  }),
}));

// Import TopBar after the mock is set up
import { TopBar } from '../../src/client/components/TopBar';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TopBar', () => {
  beforeEach(() => {
    mockTeams = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the "Fleet Commander" title', () => {
    render(<TopBar />);
    expect(screen.getByText('Fleet Commander')).toBeInTheDocument();
  });

  it('renders the logo image with correct src and alt attributes', () => {
    render(<TopBar />);
    const logo = screen.getByAltText('Fleet Commander logo');
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute('src', '/logo.svg');
    expect(logo).toHaveAttribute('width', '20');
    expect(logo).toHaveAttribute('height', '20');
  });

  it('shows correct counts for running teams', () => {
    mockTeams = [
      makeTeam({ id: 1, status: 'running' }),
      makeTeam({ id: 2, status: 'running' }),
    ];
    render(<TopBar />);
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('shows counts for active statuses but excludes done and failed', () => {
    mockTeams = [
      makeTeam({ id: 1, status: 'running' }),
      makeTeam({ id: 2, status: 'stuck' }),
      makeTeam({ id: 3, status: 'stuck' }),
      makeTeam({ id: 4, status: 'idle' }),
      makeTeam({ id: 5, status: 'done' }),
      makeTeam({ id: 6, status: 'done' }),
      makeTeam({ id: 7, status: 'done' }),
    ];
    render(<TopBar />);
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('stuck')).toBeInTheDocument();
    expect(screen.getByText('idle')).toBeInTheDocument();
    // done and failed should not appear
    expect(screen.queryByText('done')).not.toBeInTheDocument();
    expect(screen.queryByText('failed')).not.toBeInTheDocument();
  });

  it('does not render statuses with zero count', () => {
    mockTeams = [
      makeTeam({ id: 1, status: 'running' }),
    ];
    render(<TopBar />);
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.queryByText('stuck')).not.toBeInTheDocument();
    expect(screen.queryByText('idle')).not.toBeInTheDocument();
    expect(screen.queryByText('done')).not.toBeInTheDocument();
  });

  it('renders dot separators between multiple statuses', () => {
    mockTeams = [
      makeTeam({ id: 1, status: 'running' }),
      makeTeam({ id: 2, status: 'idle' }),
    ];
    const { container } = render(<TopBar />);
    // Middle-dot separator rendered as &middot; (·)
    const dots = container.querySelectorAll('span');
    const dotTexts = Array.from(dots).filter(el => el.textContent === '\u00B7');
    expect(dotTexts.length).toBe(1);
  });

  it('shows reset tooltip on daily and weekly usage indicators', async () => {
    // Fix Date.now to a known time, but let async code (fetch) resolve naturally
    const now = new Date('2026-03-18T10:00:00Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    // dailyResetsAt = 2h 30m from now, weeklyResetsAt = 5h 15m from now
    const usageResponse = {
      dailyPercent: 42,
      weeklyPercent: 60,
      sonnetPercent: 10,
      extraPercent: 5,
      zone: 'green',
      dailyResetsAt: '2026-03-18T12:30:00Z',
      weeklyResetsAt: '2026-03-18T15:15:00Z',
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => usageResponse,
    } as Response);

    render(<TopBar />);

    await waitFor(() => {
      expect(screen.getByText('Daily')).toBeInTheDocument();
    });

    // Daily indicator should have tooltip "Resets in 2h 30m"
    const dailySpan = screen.getByText('Daily').closest('span[title]');
    expect(dailySpan).toHaveAttribute('title', 'Resets in 2h 30m');

    // Weekly indicator should have tooltip "Resets in 5h 15m"
    const weeklySpan = screen.getByText('Weekly').closest('span[title]');
    expect(weeklySpan).toHaveAttribute('title', 'Resets in 5h 15m');

    // Sonnet and Extra should NOT have a title attribute
    const sonnetSpan = screen.getByText('Sonnet').closest('span');
    expect(sonnetSpan).not.toHaveAttribute('title');

    const extraSpan = screen.getByText('Extra').closest('span');
    expect(extraSpan).not.toHaveAttribute('title');
  });

  it('does not show reset tooltip when reset timestamps are null', async () => {
    const usageResponse = {
      dailyPercent: 42,
      weeklyPercent: 60,
      sonnetPercent: 10,
      extraPercent: 5,
      zone: 'green',
      dailyResetsAt: null,
      weeklyResetsAt: null,
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => usageResponse,
    } as Response);

    render(<TopBar />);

    await waitFor(() => {
      expect(screen.getByText('Daily')).toBeInTheDocument();
    });

    const dailySpan = screen.getByText('Daily').closest('span');
    expect(dailySpan).not.toHaveAttribute('title');
  });

});
