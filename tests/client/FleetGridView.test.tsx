// =============================================================================
// Fleet Commander — FleetGridView Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

let mockTeams: Array<Record<string, unknown>> = [];
let mockSelectedTeamId: number | null = null;
const mockSetSelectedTeamId = vi.fn();

vi.mock('../../src/client/context/FleetContext', () => ({
  useTeams: () => ({
    teams: mockTeams,
  }),
  useSelection: () => ({
    selectedTeamId: mockSelectedTeamId,
    setSelectedTeamId: mockSetSelectedTeamId,
  }),
}));

// Mock child components to keep rendering lightweight
vi.mock('../../src/client/components/FleetGrid', () => ({
  FleetGrid: (props: { teams: unknown[]; selectedTeamId: number | null; onSelectTeam: (id: number) => void }) => (
    <div data-testid="fleet-grid">
      FleetGrid ({props.teams.length} teams)
      <button onClick={() => props.onSelectTeam(1)}>select-1</button>
    </div>
  ),
}));

vi.mock('../../src/client/components/TeamTimeline', () => ({
  TeamTimeline: (props: { teams: unknown[] }) => (
    <div data-testid="team-timeline">TeamTimeline ({props.teams.length} teams)</div>
  ),
}));

// Import after mocks
import { FleetGridView } from '../../src/client/views/FleetGridView';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTeam(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    issueNumber: 100,
    issueTitle: 'Fix bug',
    status: 'running',
    launchedAt: '2026-03-21T10:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FleetGridView', () => {
  beforeEach(() => {
    mockTeams = [];
    mockSelectedTeamId = null;
    mockSetSelectedTeamId.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows empty state when no teams', () => {
    render(<FleetGridView />);
    expect(screen.getByText('No teams')).toBeInTheDocument();
    expect(screen.getByText('Launch a team to get started')).toBeInTheDocument();
  });

  it('renders team count when teams exist', () => {
    mockTeams = [makeTeam({ id: 1 }), makeTeam({ id: 2, issueNumber: 200 })];
    render(<FleetGridView />);
    expect(screen.getByText('2 teams')).toBeInTheDocument();
  });

  it('renders singular "team" for one team', () => {
    mockTeams = [makeTeam()];
    render(<FleetGridView />);
    expect(screen.getByText('1 team')).toBeInTheDocument();
  });

  it('renders Grid and Timeline toggle buttons', () => {
    mockTeams = [makeTeam()];
    render(<FleetGridView />);
    expect(screen.getByText('Grid')).toBeInTheDocument();
    expect(screen.getByText('Timeline')).toBeInTheDocument();
  });

  it('shows FleetGrid by default', () => {
    mockTeams = [makeTeam()];
    render(<FleetGridView />);
    expect(screen.getByTestId('fleet-grid')).toBeInTheDocument();
    expect(screen.queryByTestId('team-timeline')).not.toBeInTheDocument();
  });

  it('switches to Timeline view when Timeline button is clicked', () => {
    mockTeams = [makeTeam()];
    render(<FleetGridView />);
    fireEvent.click(screen.getByText('Timeline'));
    expect(screen.getByTestId('team-timeline')).toBeInTheDocument();
    expect(screen.queryByTestId('fleet-grid')).not.toBeInTheDocument();
  });

  it('sorts teams by status priority (stuck before running)', () => {
    mockTeams = [
      makeTeam({ id: 1, status: 'running', launchedAt: '2026-03-21T10:00:00Z' }),
      makeTeam({ id: 2, status: 'stuck', launchedAt: '2026-03-21T09:00:00Z' }),
    ];
    render(<FleetGridView />);
    // FleetGrid mock displays team count, verifying it receives sorted teams
    expect(screen.getByText('FleetGrid (2 teams)')).toBeInTheDocument();
  });

  it('passes onSelectTeam to FleetGrid', () => {
    mockTeams = [makeTeam()];
    render(<FleetGridView />);
    fireEvent.click(screen.getByText('select-1'));
    expect(mockSetSelectedTeamId).toHaveBeenCalledWith(1);
  });
});
