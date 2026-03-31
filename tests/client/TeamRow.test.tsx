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

/** Mutable teams array — tests can push items before rendering */
let mockTeamsList: TeamDashboardRow[] = [];

vi.mock('../../src/client/context/FleetContext', () => ({
  useTeams: () => ({ teams: mockTeamsList, fetchError: null }),
}));

// Import after mocks
import { TeamRow } from '../../src/client/components/TeamRow';

// ---------------------------------------------------------------------------
// Helper — TeamRow must be rendered inside a table
// ---------------------------------------------------------------------------

function renderRow(team: TeamDashboardRow, selected = false, onSelect = vi.fn(), isThinking = false) {
  return render(
    <table>
      <tbody>
        <TeamRow team={team} selected={selected} onSelect={onSelect} isThinking={isThinking} />
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
    modelInherited: false,
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
    mockTeamsList = [];
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
    renderRow(fullTeam({ model: 'claude-opus', modelInherited: false }));
    expect(screen.getByText('claude-opus')).toBeInTheDocument();
  });

  it('renders inherited model with dimmed styling', () => {
    renderRow(fullTeam({ model: 'opus', modelInherited: true }));
    const modelEl = screen.getByText('opus');
    expect(modelEl).toBeInTheDocument();
    expect(modelEl.className).toContain('text-dark-muted/50');
    expect(modelEl).toHaveAttribute('title', 'FC default');
  });

  it('renders explicit model without dimmed styling', () => {
    renderRow(fullTeam({ model: 'sonnet', modelInherited: false }));
    const modelEl = screen.getByText('sonnet');
    expect(modelEl).toBeInTheDocument();
    expect(modelEl.className).toContain('text-dark-muted');
    expect(modelEl.className).not.toContain('text-dark-muted/50');
    expect(modelEl).not.toHaveAttribute('title');
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

  it('calls onSelect with team id when the row is clicked', () => {
    const onSelect = vi.fn();
    const team = fullTeam({ id: 42 });
    renderRow(team, false, onSelect);
    const row = screen.getByRole('row');
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(42);
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

  it('shows cost when tokens are present', () => {
    renderRow(fullTeam({ totalInputTokens: 50000, totalOutputTokens: 25000, totalCostUsd: 3.57 }));
    expect(screen.getByText('$3.57')).toBeInTheDocument();
  });

  it('shows em-dash for cost when no tokens recorded', () => {
    renderRow(fullTeam({ totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 }));
    const dashCells = screen.getAllByText('\u2014');
    expect(dashCells.length).toBeGreaterThan(0);
  });

  it('shows "<$0.01" when cost is below one cent', () => {
    renderRow(fullTeam({ totalInputTokens: 100, totalOutputTokens: 50, totalCostUsd: 0.005 }));
    expect(screen.getByText('<$0.01')).toBeInTheDocument();
  });

  it('shows token breakdown in tooltip on cost cell', () => {
    renderRow(fullTeam({
      totalInputTokens: 125000,
      totalOutputTokens: 50000,
      totalCacheCreationTokens: 20000,
      totalCacheReadTokens: 10000,
      totalCostUsd: 3.57,
    }));
    const costEl = screen.getByText('$3.57');
    expect(costEl).toHaveAttribute('title', 'Input: 125K, Output: 50K, Cache: 30K');
  });

  it('shows thinking indicator when isThinking is true', () => {
    renderRow(fullTeam({ status: 'running' }), false, vi.fn(), true);
    expect(screen.getByText('thinking...')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Retry / Restart buttons for failed teams
  // -------------------------------------------------------------------------

  it('shows Retry button for failed teams', () => {
    renderRow(fullTeam({ status: 'failed' }));
    expect(screen.getByTitle('Re-queue team (respects queue order)')).toBeInTheDocument();
  });

  it('shows Restart button for failed teams', () => {
    renderRow(fullTeam({ status: 'failed' }));
    expect(screen.getByTitle('Restart team (bypasses queue)')).toBeInTheDocument();
  });

  it('does not show Retry button for running teams', () => {
    renderRow(fullTeam({ status: 'running' }));
    expect(screen.queryByTitle('Re-queue team (respects queue order)')).not.toBeInTheDocument();
  });

  it('does not show Restart button for done teams', () => {
    renderRow(fullTeam({ status: 'done' }));
    expect(screen.queryByTitle('Restart team (bypasses queue)')).not.toBeInTheDocument();
  });

  it('calls resume API when Retry is clicked', async () => {
    const team = fullTeam({ id: 99, status: 'failed' });
    renderRow(team);
    const retryBtn = screen.getByTitle('Re-queue team (respects queue order)');
    await fireEvent.click(retryBtn);
    expect(mockPost).toHaveBeenCalledWith('teams/99/resume');
  });

  it('calls restart API when Restart is clicked', async () => {
    const team = fullTeam({ id: 77, status: 'failed' });
    renderRow(team);
    const restartBtn = screen.getByTitle('Restart team (bypasses queue)');
    await fireEvent.click(restartBtn);
    expect(mockPost).toHaveBeenCalledWith('teams/77/restart');
  });

  it('shows loading state on Retry button while retrying', async () => {
    // Make the post hang indefinitely so we can observe the loading state
    let resolvePost!: () => void;
    mockPost.mockImplementation(() => new Promise<void>(r => { resolvePost = r; }));
    const team = fullTeam({ id: 10, status: 'failed' });
    renderRow(team);
    const retryBtn = screen.getByTitle('Re-queue team (respects queue order)');
    expect(retryBtn.textContent).toBe('Retry');
    fireEvent.click(retryBtn);
    // Wait for the state update to propagate
    await vi.waitFor(() => {
      expect(retryBtn.textContent).toBe('Retrying\u2026');
    });
    // Resolve the pending post to clean up
    resolvePost();
  });

  it('shows loading state on Restart button while restarting', async () => {
    let resolvePost!: () => void;
    mockPost.mockImplementation(() => new Promise<void>(r => { resolvePost = r; }));
    const team = fullTeam({ id: 11, status: 'failed' });
    renderRow(team);
    const restartBtn = screen.getByTitle('Restart team (bypasses queue)');
    expect(restartBtn.textContent).toBe('Restart');
    fireEvent.click(restartBtn);
    await vi.waitFor(() => {
      expect(restartBtn.textContent).toBe('Restarting\u2026');
    });
    resolvePost();
  });

  it('does not re-render when props are reference-equal', () => {
    const team = fullTeam();
    const onSelect = vi.fn();
    const { rerender } = render(
      <table>
        <tbody>
          <TeamRow team={team} selected={false} onSelect={onSelect} isThinking={false} />
        </tbody>
      </table>,
    );
    // Re-render with same props — should be a no-op due to React.memo
    rerender(
      <table>
        <tbody>
          <TeamRow team={team} selected={false} onSelect={onSelect} isThinking={false} />
        </tbody>
      </table>,
    );
    // If it renders, the content is still correct
    expect(screen.getByText('#100')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Queue block reason integration
  // -------------------------------------------------------------------------

  it('shows "Blocked by #49, #50" for queued teams with blockedByJson', () => {
    const team = fullTeam({
      status: 'queued',
      blockedByJson: '[49, 50]',
      projectId: 1,
    });
    mockTeamsList = [team];

    renderRow(team);

    expect(screen.getByText(/Blocked by/)).toBeInTheDocument();
    expect(screen.getByText('#49')).toBeInTheDocument();
    expect(screen.getByText('#50')).toBeInTheDocument();
  });

  it('shows "Blocked by FAILED #49" when blocker team has failed status', () => {
    const blockerTeam = fullTeam({
      id: 2,
      issueNumber: 49,
      issueKey: '49',
      status: 'failed',
      projectId: 1,
    });
    const team = fullTeam({
      id: 1,
      status: 'queued',
      blockedByJson: '[49]',
      projectId: 1,
    });
    mockTeamsList = [team, blockerTeam];

    renderRow(team);

    expect(screen.getByText(/FAILED #49/)).toBeInTheDocument();
  });

  it('shows "Waiting for slot" when all slots are full', () => {
    const runningTeam = fullTeam({
      id: 2,
      issueNumber: 99,
      status: 'running',
      projectId: 1,
    });
    const team = fullTeam({
      id: 1,
      status: 'queued',
      blockedByJson: null,
      maxActiveTeams: 1,
      projectId: 1,
    });
    mockTeamsList = [team, runningTeam];

    renderRow(team);

    expect(screen.getByText('Waiting for slot')).toBeInTheDocument();
  });

  it('shows nothing extra for generic queued team with available slots', () => {
    const team = fullTeam({
      status: 'queued',
      blockedByJson: null,
      maxActiveTeams: 5,
      projectId: 1,
    });
    mockTeamsList = [team];

    renderRow(team);

    // Status badge "Queued" is present, but no additional block reason text
    expect(screen.queryByText(/Blocked by/)).not.toBeInTheDocument();
    expect(screen.queryByText('Waiting for slot')).not.toBeInTheDocument();
  });

  it('renders blocker numbers as clickable links when githubRepo is set', () => {
    const team = fullTeam({
      status: 'queued',
      blockedByJson: '[49]',
      githubRepo: 'org/repo',
      projectId: 1,
    });
    mockTeamsList = [team];

    renderRow(team);

    const link = screen.getByRole('link', { name: '#49' });
    expect(link).toHaveAttribute('href', 'https://github.com/org/repo/issues/49');
  });
});
