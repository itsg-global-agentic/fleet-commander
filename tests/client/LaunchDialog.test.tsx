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
