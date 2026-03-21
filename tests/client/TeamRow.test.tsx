// =============================================================================
// Fleet Commander — TeamRow Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { TeamDashboardRow } from '../../src/shared/types';
import { makeTeam } from './test-utils';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const mockPost = vi.fn().mockResolvedValue({});

vi.mock('../../src/client/hooks/useApi', () => ({
  useApi: () => ({
    get: vi.fn(),
    post: mockPost,
    put: vi.fn(),
    del: vi.fn(),
  }),
}));

vi.mock('../../src/client/context/FleetContext', () => ({
  useFleet: () => ({
    teams: [],
    selectedTeamId: null,
    setSelectedTeamId: () => {},
    connected: true,
    lastEvent: null,
    lastEventTeamId: null,
    isThinking: () => false,
  }),
}));

// Import after mocks
import { TeamRow } from '../../src/client/components/TeamRow';

// ---------------------------------------------------------------------------
// Helper — TeamRow must be rendered inside a table
// ---------------------------------------------------------------------------

function renderRow(team: TeamDashboardRow, selected = false, onClick = vi.fn()) {
  return render(
    <table>
      <tbody>
        <TeamRow team={team} selected={selected} onClick={onClick} />
      </tbody>
    </table>,
  );
}

// ---------------------------------------------------------------------------
// Full team factory with all required fields
// ---------------------------------------------------------------------------

function fullTeam(overrides: Partial<TeamDashboardRow> = {}): TeamDashboardRow {
  return {
    ...makeTeam(),
    projectId: 1,
    projectName: 'test-project',
    model: 'claude-sonnet',
    branchName: 'feat/test-100',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalCostUsd: 0,
    githubRepo: 'user/test',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TeamRow', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPost.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the issue number and title', () => {
    renderRow(fullTeam({ issueNumber: 42, issueTitle: 'Fix rendering bug' }));
    expect(screen.getByText('#42')).toBeInTheDocument();
    expect(screen.getByText('Fix rendering bug')).toBeInTheDocument();
  });

  it('renders project name', () => {
    renderRow(fullTeam({ projectName: 'fleet-commander' }));
    expect(screen.getByText('fleet-commander')).toBeInTheDocument();
  });

  it('renders model name', () => {
    renderRow(fullTeam({ model: 'claude-opus' }));
    expect(screen.getByText('claude-opus')).toBeInTheDocument();
  });

  it('renders duration in minutes', () => {
    renderRow(fullTeam({ durationMin: 45 }));
    expect(screen.getByText('45m')).toBeInTheDocument();
  });

  it('renders duration with hours and minutes', () => {
    renderRow(fullTeam({ durationMin: 90 }));
    expect(screen.getByText('1h 30m')).toBeInTheDocument();
  });

  it('renders "Untitled" when issueTitle is null', () => {
    renderRow(fullTeam({ issueTitle: null }));
    expect(screen.getByText('Untitled')).toBeInTheDocument();
  });

  it('calls onClick when the row is clicked', () => {
    const onClick = vi.fn();
    renderRow(fullTeam(), false, onClick);
    const row = screen.getByRole('row');
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('applies selected styling when selected=true', () => {
    renderRow(fullTeam(), true);
    const row = screen.getByRole('row');
    expect(row.className).toContain('bg-dark-accent/10');
  });

  it('shows Stop button for running teams', () => {
    renderRow(fullTeam({ status: 'running' }));
    expect(screen.getByTitle('Stop team')).toBeInTheDocument();
  });

  it('shows Stop button for idle teams', () => {
    renderRow(fullTeam({ status: 'idle' }));
    expect(screen.getByTitle('Stop team')).toBeInTheDocument();
  });

  it('shows Stop button for stuck teams', () => {
    renderRow(fullTeam({ status: 'stuck' }));
    expect(screen.getByTitle('Stop team')).toBeInTheDocument();
  });

  it('does not show Stop button for done teams', () => {
    renderRow(fullTeam({ status: 'done' }));
    expect(screen.queryByTitle('Stop team')).not.toBeInTheDocument();
  });

  it('does not show Stop button for failed teams', () => {
    renderRow(fullTeam({ status: 'failed' }));
    expect(screen.queryByTitle('Stop team')).not.toBeInTheDocument();
  });

  it('shows Force Launch button for queued teams', () => {
    renderRow(fullTeam({ status: 'queued' }));
    expect(screen.getByTitle('Launch immediately despite usage limit')).toBeInTheDocument();
  });

  it('does not show Force Launch button for running teams', () => {
    renderRow(fullTeam({ status: 'running' }));
    expect(screen.queryByTitle('Launch immediately despite usage limit')).not.toBeInTheDocument();
  });

  it('renders em-dash for activity when team is done', () => {
    const { container } = renderRow(fullTeam({ status: 'done', lastEventAt: '2026-03-21T10:00:00Z' }));
    // For terminal teams, activity should show em-dash
    const cells = container.querySelectorAll('td');
    // Activity is the 6th column (index 5)
    expect(cells[5].textContent).toContain('\u2014');
  });

  it('shows token count when tokens are present', () => {
    renderRow(fullTeam({ totalInputTokens: 50000, totalOutputTokens: 25000 }));
    expect(screen.getByText('75K')).toBeInTheDocument();
  });

  it('shows em-dash for tokens when total is 0', () => {
    renderRow(fullTeam({ totalInputTokens: 0, totalOutputTokens: 0 }));
    // The tokens cell should contain an em-dash
    const tokenCells = screen.getAllByText('\u2014');
    expect(tokenCells.length).toBeGreaterThan(0);
  });
});
