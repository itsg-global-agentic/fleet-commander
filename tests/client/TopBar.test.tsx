// =============================================================================
// Fleet Commander — TopBar Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { TeamDashboardRow } from '../../src/shared/types';
import { makeTeam } from './test-utils';

// ---------------------------------------------------------------------------
// Mock the FleetContext module so TopBar's useFleet() returns controlled data
// ---------------------------------------------------------------------------

let mockTeams: TeamDashboardRow[] = [];

vi.mock('../../src/client/context/FleetContext', () => ({
  useFleet: () => ({
    teams: mockTeams,
    selectedTeamId: null,
    setSelectedTeamId: () => {},
    connected: true,
    lastEvent: null,
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

  it('renders the "Fleet Commander" title', () => {
    render(<TopBar />);
    expect(screen.getByText('Fleet Commander')).toBeInTheDocument();
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

});
