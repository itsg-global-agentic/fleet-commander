// =============================================================================
// Fleet Commander — QueueBlockReason Component Tests
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { TeamDashboardRow } from '../../src/shared/types';
import { makeTeam } from './test-utils';

// ---------------------------------------------------------------------------
// Mock FleetContext — provide controllable teams list
// ---------------------------------------------------------------------------

let mockTeamsList: TeamDashboardRow[] = [];

vi.mock('../../src/client/context/FleetContext', () => ({
  useTeams: () => ({ teams: mockTeamsList, fetchError: null }),
}));

// Import after mocks
import { QueueBlockReason } from '../../src/client/components/QueueBlockReason';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fullTeam(overrides: Partial<TeamDashboardRow> = {}): TeamDashboardRow {
  return {
    ...makeTeam(),
    projectId: 1,
    projectName: 'test-project',
    model: 'claude-sonnet',
    branchName: 'feat/test-100',
    githubRepo: 'user/test',
    status: 'queued',
    ...overrides,
  };
}

function renderReason(team: TeamDashboardRow) {
  return render(<QueueBlockReason team={team} />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QueueBlockReason', () => {
  beforeEach(() => {
    mockTeamsList = [];
  });

  // -------------------------------------------------------------------------
  // Dependency-blocked
  // -------------------------------------------------------------------------

  it('shows "Blocked by #49, #50" for dependency-blocked teams with GitHub issue numbers', () => {
    const team = fullTeam({ blockedByJson: '[49, 50]' });
    mockTeamsList = [team];

    renderReason(team);

    expect(screen.getByText(/Blocked by/)).toBeInTheDocument();
    expect(screen.getByText('#49')).toBeInTheDocument();
    expect(screen.getByText('#50')).toBeInTheDocument();
  });

  it('shows dependency-blocked with Jira-style keys', () => {
    const team = fullTeam({
      blockedByJson: '["PROJ-49", "PROJ-50"]',
      githubRepo: null,
    });
    mockTeamsList = [team];

    renderReason(team);

    expect(screen.getByText(/Blocked by/)).toBeInTheDocument();
    expect(screen.getByText('PROJ-49')).toBeInTheDocument();
    expect(screen.getByText('PROJ-50')).toBeInTheDocument();
  });

  it('renders blocker numbers as clickable links when githubRepo is set', () => {
    const team = fullTeam({ blockedByJson: '[49]', githubRepo: 'org/repo' });
    mockTeamsList = [team];

    renderReason(team);

    const link = screen.getByRole('link', { name: '#49' });
    expect(link).toHaveAttribute('href', 'https://github.com/org/repo/issues/49');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('does not render links when githubRepo is null', () => {
    const team = fullTeam({ blockedByJson: '[49]', githubRepo: null });
    mockTeamsList = [team];

    renderReason(team);

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('#49')).toBeInTheDocument();
  });

  it('does not render links for Jira-style keys even with githubRepo', () => {
    const team = fullTeam({ blockedByJson: '["PROJ-49"]', githubRepo: 'org/repo' });
    mockTeamsList = [team];

    renderReason(team);

    // Jira keys are not numeric, so no link
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('PROJ-49')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Failed blocker detection
  // -------------------------------------------------------------------------

  it('shows "FAILED #49" when blocker team has failed status', () => {
    const blockerTeam = fullTeam({
      id: 2,
      issueNumber: 49,
      issueKey: '49',
      status: 'failed',
      projectId: 1,
    });
    const team = fullTeam({ id: 1, blockedByJson: '[49]', projectId: 1 });
    mockTeamsList = [team, blockerTeam];

    renderReason(team);

    expect(screen.getByText(/FAILED/)).toBeInTheDocument();
    expect(screen.getByText(/FAILED #49/)).toBeInTheDocument();
  });

  it('uses warning color for normal dependency blockers', () => {
    const team = fullTeam({ blockedByJson: '[49]' });
    mockTeamsList = [team];

    const { container } = renderReason(team);

    const span = container.querySelector('.text-\\[\\#D29922\\]');
    expect(span).toBeInTheDocument();
  });

  it('uses red color for FAILED dependency blockers', () => {
    const blockerTeam = fullTeam({
      id: 2,
      issueNumber: 49,
      issueKey: '49',
      status: 'failed',
      projectId: 1,
    });
    const team = fullTeam({ id: 1, blockedByJson: '[49]', projectId: 1 });
    mockTeamsList = [team, blockerTeam];

    const { container } = renderReason(team);

    const span = container.querySelector('.text-\\[\\#F85149\\]');
    expect(span).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Slot-blocked
  // -------------------------------------------------------------------------

  it('shows "Waiting for slot" when all slots are full', () => {
    const runningTeam = fullTeam({
      id: 2,
      issueNumber: 99,
      status: 'running',
      projectId: 1,
    });
    const team = fullTeam({
      id: 1,
      blockedByJson: null,
      maxActiveTeams: 1,
      projectId: 1,
    });
    mockTeamsList = [team, runningTeam];

    renderReason(team);

    expect(screen.getByText('Waiting for slot')).toBeInTheDocument();
  });

  it('counts launching, running, idle, and stuck as active for slot check', () => {
    const launchingTeam = fullTeam({ id: 2, status: 'launching', projectId: 1, issueNumber: 98 });
    const idleTeam = fullTeam({ id: 3, status: 'idle', projectId: 1, issueNumber: 97 });
    const team = fullTeam({
      id: 1,
      blockedByJson: null,
      maxActiveTeams: 2,
      projectId: 1,
    });
    mockTeamsList = [team, launchingTeam, idleTeam];

    renderReason(team);

    expect(screen.getByText('Waiting for slot')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Generic fallback
  // -------------------------------------------------------------------------

  it('renders nothing for generic queued team with available slots', () => {
    const team = fullTeam({
      blockedByJson: null,
      maxActiveTeams: 5,
      projectId: 1,
    });
    mockTeamsList = [team];

    const { container } = renderReason(team);

    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when blockedByJson is an empty array', () => {
    const team = fullTeam({
      blockedByJson: '[]',
      maxActiveTeams: 5,
      projectId: 1,
    });
    mockTeamsList = [team];

    const { container } = renderReason(team);

    expect(container.innerHTML).toBe('');
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it('handles malformed JSON in blockedByJson gracefully', () => {
    const team = fullTeam({
      blockedByJson: 'not valid json',
      maxActiveTeams: 5,
      projectId: 1,
    });
    mockTeamsList = [team];

    const { container } = renderReason(team);

    // Falls through to slot check / generic — no crash
    expect(container.innerHTML).toBe('');
  });

  it('skips slot check when maxActiveTeams is null', () => {
    const runningTeam = fullTeam({ id: 2, status: 'running', projectId: 1, issueNumber: 99 });
    const team = fullTeam({
      id: 1,
      blockedByJson: null,
      maxActiveTeams: null,
      projectId: 1,
    });
    mockTeamsList = [team, runningTeam];

    const { container } = renderReason(team);

    // No slot check possible, renders nothing
    expect(container.innerHTML).toBe('');
  });

  it('shows dependency reason even when slots are also full', () => {
    const runningTeam = fullTeam({ id: 2, status: 'running', projectId: 1, issueNumber: 99 });
    const team = fullTeam({
      id: 1,
      blockedByJson: '[49]',
      maxActiveTeams: 1,
      projectId: 1,
    });
    mockTeamsList = [team, runningTeam];

    renderReason(team);

    // Dependency reason takes priority over slot
    expect(screen.getByText(/Blocked by/)).toBeInTheDocument();
    expect(screen.queryByText('Waiting for slot')).not.toBeInTheDocument();
  });

  it('does not flag blocker as FAILED when blocker team is not found', () => {
    // Blocker issue 49 has no corresponding team in the fleet
    const team = fullTeam({ id: 1, blockedByJson: '[49]', projectId: 1 });
    mockTeamsList = [team];

    renderReason(team);

    expect(screen.queryByText(/FAILED/)).not.toBeInTheDocument();
    expect(screen.getByText('#49')).toBeInTheDocument();
  });

  it('does not flag blocker as FAILED when blocker team is in a different project', () => {
    const blockerTeam = fullTeam({
      id: 2,
      issueNumber: 49,
      issueKey: '49',
      status: 'failed',
      projectId: 2, // Different project
    });
    const team = fullTeam({ id: 1, blockedByJson: '[49]', projectId: 1 });
    mockTeamsList = [team, blockerTeam];

    renderReason(team);

    expect(screen.queryByText(/FAILED/)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Strike-through for resolved blockers
  // -------------------------------------------------------------------------

  it('applies strike-through to resolved dependency blocker link', () => {
    const blockerTeam = fullTeam({
      id: 2,
      issueNumber: 49,
      issueKey: '49',
      status: 'done',
      projectId: 1,
    });
    const team = fullTeam({ id: 1, blockedByJson: '[49]', projectId: 1 });
    mockTeamsList = [team, blockerTeam];

    renderReason(team);

    const link = screen.getByRole('link', { name: '#49' });
    expect(link.className).toContain('line-through');
    expect(link.className).toContain('text-dark-muted/60');
  });

  it('does not show FAILED prefix for resolved dependency blocker', () => {
    const blockerTeam = fullTeam({
      id: 2,
      issueNumber: 49,
      issueKey: '49',
      status: 'done',
      projectId: 1,
    });
    const team = fullTeam({ id: 1, blockedByJson: '[49]', projectId: 1 });
    mockTeamsList = [team, blockerTeam];

    renderReason(team);

    expect(screen.queryByText(/FAILED/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '#49' })).toBeInTheDocument();
  });

  it('applies strike-through to resolved dependency blocker span (non-GitHub)', () => {
    const blockerTeam = fullTeam({
      id: 2,
      issueKey: 'PROJ-49',
      status: 'done',
      projectId: 1,
      githubRepo: null,
    });
    const team = fullTeam({
      id: 1,
      blockedByJson: '["PROJ-49"]',
      projectId: 1,
      githubRepo: null,
    });
    mockTeamsList = [team, blockerTeam];

    renderReason(team);

    const el = screen.getByText('PROJ-49');
    expect(el.className).toContain('line-through');
    expect(el.className).toContain('text-dark-muted/60');
  });

  it('does not apply strike-through when no matching team exists for blocker', () => {
    const team = fullTeam({ id: 1, blockedByJson: '[49]', projectId: 1 });
    mockTeamsList = [team];

    renderReason(team);

    const link = screen.getByRole('link', { name: '#49' });
    expect(link.className).not.toContain('line-through');
  });

  it('preserves FAILED prefix and red color for failed blocker (no strike-through)', () => {
    const blockerTeam = fullTeam({
      id: 2,
      issueNumber: 49,
      issueKey: '49',
      status: 'failed',
      projectId: 1,
    });
    const team = fullTeam({ id: 1, blockedByJson: '[49]', projectId: 1 });
    mockTeamsList = [team, blockerTeam];

    const { container } = renderReason(team);

    expect(screen.getByText(/FAILED #49/)).toBeInTheDocument();
    expect(container.querySelector('.text-\\[\\#F85149\\]')).toBeInTheDocument();

    const link = screen.getByRole('link', { name: 'FAILED #49' });
    expect(link.className).not.toContain('line-through');
  });

  // -------------------------------------------------------------------------
  // Strike-through for completed children
  // -------------------------------------------------------------------------

  it('applies strike-through to completed child in sub-issues list', () => {
    const childTeam = fullTeam({
      id: 2,
      issueNumber: 10,
      issueKey: '10',
      status: 'done',
      projectId: 1,
    });
    const team = fullTeam({
      id: 1,
      pendingChildrenJson: '[10, 11]',
      projectId: 1,
    });
    mockTeamsList = [team, childTeam];

    renderReason(team);

    const link10 = screen.getByRole('link', { name: '#10' });
    expect(link10.className).toContain('line-through');
    expect(link10.className).toContain('text-dark-muted/60');

    const link11 = screen.getByRole('link', { name: '#11' });
    expect(link11.className).not.toContain('line-through');
  });

  it('does not apply strike-through to child without matching team', () => {
    const team = fullTeam({
      id: 1,
      pendingChildrenJson: '[10]',
      projectId: 1,
    });
    mockTeamsList = [team];

    renderReason(team);

    const link = screen.getByRole('link', { name: '#10' });
    expect(link.className).not.toContain('line-through');
  });

  it('applies strike-through to completed child span (non-GitHub)', () => {
    const childTeam = fullTeam({
      id: 2,
      issueKey: 'PROJ-10',
      status: 'done',
      projectId: 1,
      githubRepo: null,
    });
    const team = fullTeam({
      id: 1,
      pendingChildrenJson: '["PROJ-10"]',
      projectId: 1,
      githubRepo: null,
    });
    mockTeamsList = [team, childTeam];

    renderReason(team);

    const el = screen.getByText('PROJ-10');
    expect(el.className).toContain('line-through');
    expect(el.className).toContain('text-dark-muted/60');
  });

  it('does not apply strike-through to child in a different project', () => {
    const childTeam = fullTeam({
      id: 2,
      issueNumber: 10,
      issueKey: '10',
      status: 'done',
      projectId: 2, // Different project
    });
    const team = fullTeam({
      id: 1,
      pendingChildrenJson: '[10]',
      projectId: 1,
    });
    mockTeamsList = [team, childTeam];

    renderReason(team);

    const link = screen.getByRole('link', { name: '#10' });
    expect(link.className).not.toContain('line-through');
  });
});
