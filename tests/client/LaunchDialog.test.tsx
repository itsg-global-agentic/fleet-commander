// =============================================================================
// Fleet Commander — LaunchDialog Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// ---------------------------------------------------------------------------
// Mock useApi
// ---------------------------------------------------------------------------

const mockGet = vi.fn();
const mockPost = vi.fn();

// Stable API object reference — LaunchDialog uses `api` as a useEffect dependency,
// so returning a new object each render would cause an infinite re-render loop.
const mockApi = {
  get: mockGet,
  post: mockPost,
  put: vi.fn(),
  del: vi.fn(),
};

vi.mock('../../src/client/hooks/useApi', () => ({
  useApi: () => mockApi,
}));

// Import after mocks
import { LaunchDialog } from '../../src/client/components/LaunchDialog';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProjects() {
  return [
    {
      id: 1,
      name: 'test-project',
      githubRepo: 'user/test',
      maxActiveTeams: 5,
      activeTeamCount: 1,
      queuedTeamCount: 0,
    },
  ];
}

function makeIssuesResponse() {
  return {
    tree: [
      {
        number: 10,
        title: 'Fix login',
        state: 'open',
        labels: ['bug'],
        children: [],
        activeTeam: null,
      },
      {
        number: 20,
        title: 'Add feature',
        state: 'open',
        labels: ['feature'],
        children: [],
        activeTeam: null,
      },
      {
        number: 30,
        title: 'Done task',
        state: 'closed',
        labels: [],
        children: [],
        activeTeam: null,
      },
    ],
  };
}

function makeUsage() {
  return { dailyPercent: 10, weeklyPercent: 20, sonnetPercent: 5, extraPercent: 0 };
}

/** Standard mock implementation for LaunchDialog API calls */
function setupMockApi() {
  mockGet.mockImplementation((path: string) => {
    if (path === 'projects') return Promise.resolve(makeProjects());
    if (path.match(/^projects\/\d+\/issues/)) return Promise.resolve(makeIssuesResponse());
    if (path === 'usage') return Promise.resolve(makeUsage());
    return Promise.resolve([]);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LaunchDialog', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not render when open is false', () => {
    const { container } = render(<LaunchDialog open={false} onClose={vi.fn()} />);
    expect(container.querySelector('[role="dialog"]')).not.toBeInTheDocument();
  });

  it('renders dialog title when open', async () => {
    setupMockApi();
    render(<LaunchDialog open onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Launch Team' })).toBeInTheDocument();
  });

  it('shows project selector', async () => {
    setupMockApi();
    render(<LaunchDialog open onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('test-project')).toBeInTheDocument();
    });
  });

  it('shows issue list after project loads', async () => {
    setupMockApi();
    render(<LaunchDialog open onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Fix login')).toBeInTheDocument();
      expect(screen.getByText('Add feature')).toBeInTheDocument();
    });
  });

  it('renders a search input for filtering issues', async () => {
    setupMockApi();
    render(<LaunchDialog open onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/filter issues/i)).toBeInTheDocument();
    });
  });

  it('calls onClose when dialog is closed', async () => {
    setupMockApi();
    const onClose = vi.fn();
    render(<LaunchDialog open onClose={onClose} />);
    // Press Escape
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders Cancel button', async () => {
    setupMockApi();
    render(<LaunchDialog open onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });
  });

  it('shows loading state while issues are fetching', async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === 'projects') return Promise.resolve(makeProjects());
      if (path.match(/^projects\/\d+\/issues/)) return new Promise(() => {}); // never resolves
      if (path === 'usage') return Promise.resolve(makeUsage());
      return Promise.resolve([]);
    });
    render(<LaunchDialog open onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/loading/i)).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// LaunchLog polling behavior tests
//
// The LaunchLog is an internal component rendered after a team is launched.
// We simulate the launch flow, then verify polling stops on terminal status.
// We use real timers and a short wait to verify polling ceases.
// ---------------------------------------------------------------------------

describe('LaunchDialog — LaunchLog polling', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /** Simulate a launch to get into the LaunchLog view, returns team poll count getter */
  async function launchAndGetToLog(terminalStatus: 'done' | 'failed') {
    let teamGetCount = 0;
    mockGet.mockImplementation((path: string) => {
      if (path === 'projects') return Promise.resolve(makeProjects());
      if (path.match(/^projects\/\d+\/issues/)) return Promise.resolve(makeIssuesResponse());
      if (path === 'usage') return Promise.resolve(makeUsage());
      if (path === 'teams/42') {
        teamGetCount++;
        return Promise.resolve({
          id: 42, issueNumber: 10, status: terminalStatus,
          stoppedAt: '2026-03-20T10:00:00.000Z',
        });
      }
      if (path === 'teams/42/output?lines=50') return Promise.resolve({ lines: [] });
      if (path === 'teams/42/stream-events') return Promise.resolve([]);
      return Promise.resolve([]);
    });

    mockPost.mockResolvedValue({ id: 42, issueNumber: 10, status: 'queued' });

    render(<LaunchDialog open onClose={vi.fn()} />);

    // Wait for issues to load
    await waitFor(() => {
      expect(screen.getByText('Fix login')).toBeInTheDocument();
    });

    // Select issue and launch
    fireEvent.click(screen.getByText('Fix login'));
    const launchBtn = screen.getByRole('button', { name: /launch/i });
    fireEvent.click(launchBtn);

    // Wait for LaunchLog to appear
    await waitFor(() => {
      expect(screen.getByText(/Team #42/)).toBeInTheDocument();
    });

    return () => teamGetCount;
  }

  it('stops polling when team status becomes done', async () => {
    const getTeamGetCount = await launchAndGetToLog('done');

    // Wait for the initial poll cycle to complete
    await waitFor(() => {
      expect(getTeamGetCount()).toBeGreaterThanOrEqual(1);
    });

    const countAfterInitial = getTeamGetCount();

    // Wait long enough for a second poll cycle to have fired if polling continued (>2s)
    await new Promise((r) => setTimeout(r, 3000));

    // Polling should have stopped — no additional team polls
    expect(getTeamGetCount()).toBe(countAfterInitial);
  }, 10000);

  it('stops polling when team status becomes failed', async () => {
    const getTeamGetCount = await launchAndGetToLog('failed');

    // Wait for the initial poll cycle to complete
    await waitFor(() => {
      expect(getTeamGetCount()).toBeGreaterThanOrEqual(1);
    });

    const countAfterInitial = getTeamGetCount();

    // Wait long enough for a second poll cycle to have fired if polling continued (>2s)
    await new Promise((r) => setTimeout(r, 3000));

    // Polling should have stopped — no additional team polls
    expect(getTeamGetCount()).toBe(countAfterInitial);
  }, 10000);
});
