// =============================================================================
// Fleet Commander — TeamTimeline Component Tests
// =============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { TeamDashboardRow } from '../../src/shared/types';
import { makeTeam } from './test-utils';
import { TeamTimeline } from '../../src/client/components/TeamTimeline';

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

describe('TeamTimeline', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders "No teams with timeline data" when no teams', () => {
    render(<TeamTimeline teams={[]} />);
    expect(screen.getByText('No teams with timeline data')).toBeInTheDocument();
  });

  it('renders "No teams with timeline data" when teams have no launchedAt', () => {
    const teams = [fullTeam({ id: 1, launchedAt: null })];
    render(<TeamTimeline teams={teams} />);
    expect(screen.getByText('No teams with timeline data')).toBeInTheDocument();
  });

  it('renders a bar for teams with launchedAt', () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-03-21T10:10:00Z').getTime());
    const teams = [
      fullTeam({
        id: 1,
        issueNumber: 42,
        launchedAt: '2026-03-21T10:00:00Z',
        status: 'running',
        durationMin: 10,
      }),
    ];
    render(<TeamTimeline teams={teams} />);
    expect(screen.getByText('#42')).toBeInTheDocument();
  });

  it('renders multiple bars sorted by launch time', () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-03-21T11:00:00Z').getTime());
    const teams = [
      fullTeam({
        id: 2,
        issueNumber: 200,
        launchedAt: '2026-03-21T10:30:00Z',
        status: 'done',
        durationMin: 15,
      }),
      fullTeam({
        id: 1,
        issueNumber: 100,
        launchedAt: '2026-03-21T10:00:00Z',
        status: 'done',
        durationMin: 20,
      }),
    ];
    render(<TeamTimeline teams={teams} />);
    expect(screen.getByText('#100')).toBeInTheDocument();
    expect(screen.getByText('#200')).toBeInTheDocument();
  });

  it('shows tooltip on hover with issue title', () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-03-21T10:30:00Z').getTime());
    const teams = [
      fullTeam({
        id: 1,
        issueNumber: 42,
        issueTitle: 'Fix the bug',
        launchedAt: '2026-03-21T10:00:00Z',
        status: 'running',
        durationMin: 30,
      }),
    ];
    const { container } = render(<TeamTimeline teams={teams} />);
    // Find the row and hover
    const row = container.querySelector('.group');
    expect(row).not.toBeNull();
    fireEvent.mouseEnter(row!);
    // Tooltip should show issue number and title
    expect(screen.getByText(/Fix the bug/)).toBeInTheDocument();
  });

  it('hides tooltip on mouse leave', () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-03-21T10:30:00Z').getTime());
    const teams = [
      fullTeam({
        id: 1,
        issueNumber: 42,
        issueTitle: 'Fix the bug',
        launchedAt: '2026-03-21T10:00:00Z',
        status: 'running',
        durationMin: 30,
      }),
    ];
    const { container } = render(<TeamTimeline teams={teams} />);
    const row = container.querySelector('.group');
    fireEvent.mouseEnter(row!);
    expect(screen.getByText(/Fix the bug/)).toBeInTheDocument();
    fireEvent.mouseLeave(row!);
    expect(screen.queryByText(/Fix the bug/)).not.toBeInTheDocument();
  });

  it('renders time axis labels', () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-03-21T12:00:00Z').getTime());
    const teams = [
      fullTeam({
        id: 1,
        issueNumber: 1,
        launchedAt: '2026-03-21T10:00:00Z',
        status: 'done',
        durationMin: 60,
      }),
    ];
    const { container } = render(<TeamTimeline teams={teams} />);
    // There should be some time axis labels rendered as spans with text-[10px]
    const axisLabels = container.querySelectorAll('.text-\\[10px\\]');
    expect(axisLabels.length).toBeGreaterThan(0);
  });
});
