// =============================================================================
// Fleet Commander — TeamDetail Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const mockSetSelectedTeamId = vi.fn();
const mockGet = vi.fn();
const mockPost = vi.fn();
let mockSelectedTeamId: number | null = null;

// Stable API object reference — TeamDetail uses `api` as a useEffect dependency,
// so returning a new object each render would cause an infinite re-render loop.
const mockApi = {
  get: mockGet,
  post: mockPost,
  put: vi.fn(),
  del: vi.fn(),
};

vi.mock('../../src/client/context/FleetContext', () => ({
  useSelection: () => ({
    selectedTeamId: mockSelectedTeamId,
    setSelectedTeamId: mockSetSelectedTeamId,
  }),
  useConnection: () => ({
    connected: true,
    lastEvent: null,
    lastEventTeamId: null,
  }),
  useThinking: () => ({
    isThinking: () => false,
  }),
}));

vi.mock('../../src/client/hooks/useApi', () => ({
  useApi: () => mockApi,
}));

// Mock child components that have complex dependencies
vi.mock('../../src/client/components/UnifiedTimeline', () => ({
  UnifiedTimeline: () => <div data-testid="unified-timeline">UnifiedTimeline</div>,
}));

vi.mock('../../src/client/components/CommGraph', () => ({
  CommGraph: () => <div data-testid="comm-graph">CommGraph</div>,
}));

vi.mock('../../src/client/components/CIChecks', () => ({
  CIChecks: () => <div data-testid="ci-checks">CIChecks</div>,
}));

vi.mock('../../src/client/hooks/useFleetSSE', () => ({
  useFleetSSE: vi.fn(),
}));

// Import after mocks
import { TeamDetail } from '../../src/client/components/TeamDetail';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    issueNumber: 100,
    issueTitle: 'Fix rendering bug',
    status: 'running',
    phase: 'implementing',
    worktreeName: 'kea-100',
    branchName: 'feat/kea-100',
    model: 'claude-sonnet',
    prNumber: null,
    pr: null,
    launchedAt: '2026-03-21T10:00:00Z',
    lastEventAt: '2026-03-21T10:05:00Z',
    durationMin: 5,
    idleMin: 0,
    totalInputTokens: 10000,
    totalOutputTokens: 5000,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalCostUsd: 0.50,
    githubRepo: 'user/repo',
    slowestToolCalls: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TeamDetail', () => {
  beforeEach(() => {
    mockSelectedTeamId = null;
    mockGet.mockReset();
    mockPost.mockReset();
    mockSetSelectedTeamId.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders "Team Detail" heading', () => {
    render(<TeamDetail />);
    expect(screen.getByText('Team Detail')).toBeInTheDocument();
  });

  it('shows loading state when team is selected', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockReturnValue(new Promise(() => {})); // never resolves
    render(<TeamDetail />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows error state when API fails', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockRejectedValue(new Error('Network error'));
    render(<TeamDetail />);
    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('renders team detail when API returns data', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail());
    render(<TeamDetail />);
    await waitFor(() => {
      expect(screen.getByText('#100')).toBeInTheDocument();
      expect(screen.getByText('Fix rendering bug')).toBeInTheDocument();
    });
  });

  it('renders worktree and branch info', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail());
    render(<TeamDetail />);
    await waitFor(() => {
      // Use getAllByText since "kea-100" appears in both worktree and branch names
      const matches = screen.getAllByText(/kea-100/);
      expect(matches.length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText(/feat\/kea-100/)).toBeInTheDocument();
    });
  });

  it('renders model info', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail());
    render(<TeamDetail />);
    await waitFor(() => {
      expect(screen.getByText(/claude-sonnet/)).toBeInTheDocument();
    });
  });

  it('renders Session Log and Team tabs', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail());
    render(<TeamDetail />);
    await waitFor(() => {
      expect(screen.getByText('Session Log')).toBeInTheDocument();
      expect(screen.getByText('Team')).toBeInTheDocument();
    });
  });

  it('renders Stop button for running team', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail({ status: 'running' }));
    render(<TeamDetail />);
    await waitFor(() => {
      expect(screen.getByText('Stop')).toBeInTheDocument();
    });
  });

  it('renders Resume button for failed team', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail({ status: 'failed' }));
    render(<TeamDetail />);
    await waitFor(() => {
      expect(screen.getByText('Resume')).toBeInTheDocument();
    });
  });

  it('renders Restart button for non-done teams', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail({ status: 'running' }));
    render(<TeamDetail />);
    await waitFor(() => {
      expect(screen.getByText('Restart')).toBeInTheDocument();
    });
  });

  it('does not render Restart button for done teams', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail({ status: 'done' }));
    render(<TeamDetail />);
    await waitFor(() => {
      expect(screen.getByText('#100')).toBeInTheDocument();
    });
    expect(screen.queryByText('Restart')).not.toBeInTheDocument();
  });

  it('renders Export Log button', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail());
    render(<TeamDetail />);
    await waitFor(() => {
      expect(screen.getByText('Export Log')).toBeInTheDocument();
    });
  });

  it('renders token breakdown when tokens are present', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail({
      totalInputTokens: 10000,
      totalOutputTokens: 5000,
      totalCostUsd: 0.50,
    }));
    render(<TeamDetail />);
    await waitFor(() => {
      // Token values are formatted with toLocaleString (locale-specific separators).
      // Use getAllByText with custom matcher to handle locale-specific formatting.
      const inputMatches = screen.getAllByText((_content, element) =>
        element?.tagName === 'SPAN' && /10[\s,.\u00a0]?000/.test(element.textContent ?? ''),
      );
      expect(inputMatches.length).toBeGreaterThanOrEqual(1);
      const outputMatches = screen.getAllByText((_content, element) =>
        element?.tagName === 'SPAN' && element.textContent !== null
          && /^5[\s,.\u00a0]?000$/.test(element.textContent.trim()),
      );
      expect(outputMatches.length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('$0.5000')).toBeInTheDocument();
    });
  });

  it('renders PR link inside PR tab when PR data is present', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail({
      prNumber: 42,
      githubRepo: 'user/repo',
      pr: {
        number: 42,
        state: 'open',
        ciStatus: 'passing',
        mergeStatus: 'clean',
        autoMerge: false,
        ciFailCount: 0,
        checks: [],
      },
    }));
    render(<TeamDetail />);
    const prTab = await screen.findByRole('button', { name: /^PR\s*#42$/ });
    fireEvent.click(prTab);
    await waitFor(() => {
      const link = screen.getByRole('link', { name: 'PR #42' });
      expect(link).toHaveAttribute('href', 'https://github.com/user/repo/pull/42');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });
  });

  it('renders PR number as plain text inside PR tab when githubRepo is null', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail({
      prNumber: 42,
      githubRepo: null,
      pr: {
        number: 42,
        state: 'open',
        ciStatus: 'passing',
        mergeStatus: 'clean',
        autoMerge: false,
        ciFailCount: 0,
        checks: [],
      },
    }));
    render(<TeamDetail />);
    const prTab = await screen.findByRole('button', { name: /^PR\s*#42$/ });
    fireEvent.click(prTab);
    await waitFor(() => {
      // No link should be rendered when githubRepo is null
      expect(screen.queryByRole('link', { name: 'PR #42' })).not.toBeInTheDocument();
      // The PR number still renders as plain text inside the tab pane
      const prMatches = screen.getAllByText('PR #42');
      // One in the tab button, one in the tab content as a plain span
      expect(prMatches.some((el) => el.tagName === 'SPAN')).toBe(true);
    });
  });

  it('renders PR link loading fallback inside PR tab when prNumber is set but pr detail is null', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail({
      githubRepo: 'user/repo',
      prNumber: 99,
      pr: null,
    }));
    render(<TeamDetail />);
    const prTab = await screen.findByRole('button', { name: /^PR\s*#99$/ });
    fireEvent.click(prTab);
    await waitFor(() => {
      const link = screen.getByRole('link', { name: 'PR #99' });
      expect(link).toHaveAttribute('href', 'https://github.com/user/repo/pull/99');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(screen.getByText(/details loading/)).toBeInTheDocument();
    });
  });

  it('renders close button with correct title', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail());
    render(<TeamDetail />);
    await waitFor(() => {
      expect(screen.getByTitle('Close panel (Esc)')).toBeInTheDocument();
    });
  });

  it('renders Quick Actions section', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail({ status: 'running' }));
    render(<TeamDetail />);
    await waitFor(() => {
      expect(screen.getByText('Quick:')).toBeInTheDocument();
      expect(screen.getByText('Status?')).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Issue #762: Promoted tabs (Transitions / PR / Slowest tools)
  // ---------------------------------------------------------------------------

  it('renders Transitions tab and always shows it', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail());
    render(<TeamDetail />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Transitions/ })).toBeInTheDocument();
    });
  });

  it('hides PR tab when team has no PR', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail({ prNumber: null, pr: null }));
    render(<TeamDetail />);
    // Wait for the panel to render fully (Transitions tab is the marker that
    // the post-load tab bar is present).
    await screen.findByRole('button', { name: /^Transitions/ });
    expect(screen.queryByRole('button', { name: /^PR\s*#/ })).not.toBeInTheDocument();
  });

  it('shows PR tab when prNumber is set (even with pr detail null)', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail({ prNumber: 7, pr: null }));
    render(<TeamDetail />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^PR\s*#7$/ })).toBeInTheDocument();
    });
  });

  it('shows PR tab when prNumber is set and pr detail is loaded', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail({
      prNumber: 8,
      pr: {
        number: 8,
        state: 'open',
        ciStatus: 'passing',
        mergeStatus: 'clean',
        autoMerge: false,
        ciFailCount: 0,
        checks: [],
      },
    }));
    render(<TeamDetail />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^PR\s*#8$/ })).toBeInTheDocument();
    });
  });

  it('hides Slowest tools tab when slowestToolCalls is empty', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail({ slowestToolCalls: [] }));
    render(<TeamDetail />);
    await screen.findByRole('button', { name: /^Transitions/ });
    expect(screen.queryByRole('button', { name: 'Slowest tools' })).not.toBeInTheDocument();
  });

  it('shows Slowest tools tab when slowestToolCalls has data', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail({
      slowestToolCalls: [
        {
          id: 101,
          teamId: 1,
          type: 'tool_use',
          payload: null,
          toolName: 'Read',
          durationMs: 4200,
          agentName: 'team-lead',
          createdAt: '2026-03-21T10:05:00Z',
        },
      ],
    }));
    render(<TeamDetail />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Slowest tools' })).toBeInTheDocument();
    });
  });

  it('renders Slowest tools content after clicking the tab', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail({
      slowestToolCalls: [
        {
          id: 102,
          teamId: 1,
          type: 'tool_use',
          payload: null,
          toolName: 'Glob',
          durationMs: 1500,
          agentName: 'planner',
          createdAt: '2026-03-21T10:06:00Z',
        },
      ],
    }));
    render(<TeamDetail />);
    const tab = await screen.findByRole('button', { name: 'Slowest tools' });
    fireEvent.click(tab);
    await waitFor(() => {
      // 1500ms formats to "1.5s"
      expect(screen.getByText('1.5s')).toBeInTheDocument();
      expect(screen.getByText('Glob')).toBeInTheDocument();
    });
  });

  it('does not render inline State Transitions / Pull Request / Slowest Tool Calls headings', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail({
      prNumber: 42,
      pr: {
        number: 42,
        state: 'open',
        ciStatus: 'passing',
        mergeStatus: 'clean',
        autoMerge: false,
        ciFailCount: 0,
        checks: [],
      },
      slowestToolCalls: [
        {
          id: 1,
          teamId: 1,
          type: 'tool_use',
          payload: null,
          toolName: 'Read',
          durationMs: 200,
          agentName: 'team-lead',
          createdAt: '2026-03-21T10:05:00Z',
        },
      ],
    }));
    render(<TeamDetail />);
    await screen.findByRole('button', { name: /^Transitions/ });
    // Inline section headings should be gone — they were <h4> in the metadata
    // panel previously and have no replacement at the same DOM level.
    expect(screen.queryByText('State Transitions')).not.toBeInTheDocument();
    expect(screen.queryByText('Pull Request')).not.toBeInTheDocument();
    expect(screen.queryByText('Slowest Tool Calls')).not.toBeInTheDocument();
  });

  it('renders the tabs in the documented order after Team', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail({
      prNumber: 42,
      pr: null,
      slowestToolCalls: [
        {
          id: 1,
          teamId: 1,
          type: 'tool_use',
          payload: null,
          toolName: 'Read',
          durationMs: 200,
          agentName: 'team-lead',
          createdAt: '2026-03-21T10:05:00Z',
        },
      ],
    }));
    render(<TeamDetail />);
    await screen.findByRole('button', { name: /^Transitions/ });
    const buttons = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    const sessionLogIdx = buttons.findIndex((t) => t.startsWith('Session Log'));
    const tasksIdx = buttons.findIndex((t) => t.startsWith('Tasks'));
    const filesIdx = buttons.findIndex((t) => t.startsWith('Files'));
    const teamIdx = buttons.findIndex((t) => t === 'Team');
    const transitionsIdx = buttons.findIndex((t) => t.startsWith('Transitions'));
    const prIdx = buttons.findIndex((t) => /^PR\s*#/.test(t));
    const slowestIdx = buttons.findIndex((t) => t === 'Slowest tools');
    expect(sessionLogIdx).toBeGreaterThanOrEqual(0);
    expect(tasksIdx).toBeGreaterThan(sessionLogIdx);
    expect(filesIdx).toBeGreaterThan(tasksIdx);
    expect(teamIdx).toBeGreaterThan(filesIdx);
    expect(transitionsIdx).toBeGreaterThan(teamIdx);
    expect(prIdx).toBeGreaterThan(transitionsIdx);
    expect(slowestIdx).toBeGreaterThan(prIdx);
  });
});
