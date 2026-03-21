// =============================================================================
// Fleet Commander — TeamDetail Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
  useFleet: () => ({
    teams: [],
    selectedTeamId: mockSelectedTeamId,
    setSelectedTeamId: mockSetSelectedTeamId,
    connected: true,
    lastEvent: null,
    lastEventTeamId: null,
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

  it('renders PR section when PR data is present', async () => {
    mockSelectedTeamId = 1;
    mockGet.mockResolvedValue(makeDetail({
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
    await waitFor(() => {
      expect(screen.getByText('Pull Request')).toBeInTheDocument();
      expect(screen.getByText('PR #42')).toBeInTheDocument();
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
});
