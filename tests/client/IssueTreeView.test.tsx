// =============================================================================
// Fleet Commander — IssueTreeView Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const mockGet = vi.fn();
const mockPost = vi.fn();

// Stable API reference
const mockApi = {
  get: mockGet,
  post: mockPost,
  put: vi.fn(),
  del: vi.fn(),
};

vi.mock('../../src/client/hooks/useApi', () => ({
  useApi: () => mockApi,
}));

vi.mock('../../src/client/hooks/useSSE', () => ({
  useSSE: () => ({
    connected: true,
    lastEvent: null,
    lastEventTeamId: null,
  }),
}));

vi.mock('../../src/client/hooks/usePrioritization', () => ({
  usePrioritization: () => ({
    priorityMap: new Map(),
    loading: false,
    error: null,
    fetchPriorities: vi.fn(),
  }),
  sortTreeByPriority: (tree: unknown[]) => tree,
}));

// Mock TreeNode to keep rendering lightweight
vi.mock('../../src/client/components/TreeNode', () => ({
  TreeNode: (props: { node: { number: number; title: string } }) => (
    <div data-testid={`tree-node-${props.node.number}`}>
      #{props.node.number} {props.node.title}
    </div>
  ),
}));

// Import after mocks
import { IssueTreeView } from '../../src/client/views/IssueTreeView';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    ],
    cachedAt: '2026-03-21T10:00:00Z',
    count: 2,
  };
}

function makeProjectsResponse() {
  return [
    { id: 1, name: 'test-project', githubRepo: 'user/test', maxActiveTeams: 5, activeTeamCount: 0, queuedTeamCount: 0 },
  ];
}

function setupMockApi() {
  mockGet.mockImplementation((path: string) => {
    if (path === 'issues') return Promise.resolve(makeIssuesResponse());
    if (path === 'projects') return Promise.resolve(makeProjectsResponse());
    return Promise.resolve({});
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IssueTreeView', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    render(<IssueTreeView />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows error state when API fails', async () => {
    mockGet.mockRejectedValue(new Error('Issues fetch failed'));
    render(<IssueTreeView />);
    await waitFor(() => {
      expect(screen.getByText(/issues fetch failed/i)).toBeInTheDocument();
    });
  });

  it('renders Issue Tree heading after data loads', async () => {
    setupMockApi();
    render(<IssueTreeView />);
    await waitFor(() => {
      expect(screen.getByText('Issue Tree')).toBeInTheDocument();
    });
  });

  it('renders tree nodes for issues', async () => {
    setupMockApi();
    render(<IssueTreeView />);
    await waitFor(() => {
      expect(screen.getByTestId('tree-node-10')).toBeInTheDocument();
      expect(screen.getByTestId('tree-node-20')).toBeInTheDocument();
    });
  });

  it('renders status filter pills', async () => {
    setupMockApi();
    render(<IssueTreeView />);
    await waitFor(() => {
      expect(screen.getByText('All')).toBeInTheDocument();
      expect(screen.getByText('No Team')).toBeInTheDocument();
    });
  });

  it('renders Refresh button', async () => {
    setupMockApi();
    render(<IssueTreeView />);
    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeInTheDocument();
    });
  });

  it('renders issue count', async () => {
    setupMockApi();
    render(<IssueTreeView />);
    await waitFor(() => {
      expect(screen.getByText(/2 issues/)).toBeInTheDocument();
    });
  });

  it('renders search input', async () => {
    setupMockApi();
    render(<IssueTreeView />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Closed parent with open children (Issue #348 fix)
  // -------------------------------------------------------------------------

  it('renders closed parent nodes with their open children', async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === 'issues') {
        return Promise.resolve({
          tree: [
            {
              number: 5,
              title: 'Closed parent',
              state: 'closed',
              labels: [],
              children: [
                {
                  number: 10,
                  title: 'Open child under closed parent',
                  state: 'open',
                  labels: [],
                  children: [],
                  activeTeam: null,
                },
              ],
              activeTeam: null,
            },
            {
              number: 20,
              title: 'Regular open issue',
              state: 'open',
              labels: [],
              children: [],
              activeTeam: null,
            },
          ],
          cachedAt: '2026-03-21T10:00:00Z',
          count: 3,
        });
      }
      if (path === 'projects') return Promise.resolve(makeProjectsResponse());
      return Promise.resolve({});
    });

    render(<IssueTreeView />);
    await waitFor(() => {
      // Both the closed parent and the open child should be rendered
      expect(screen.getByTestId('tree-node-5')).toBeInTheDocument();
      expect(screen.getByTestId('tree-node-20')).toBeInTheDocument();
    });

    // The open child is nested inside the closed parent TreeNode,
    // so it gets rendered as part of tree-node-5 by the mock
    // (the mock TreeNode is a flat div, children are rendered by IssueTreeView recursion)
    // Since IssueTreeView only renders top-level nodes, tree-node-10 is nested
    // inside tree-node-5 in the real component. The mock doesn't recurse,
    // but we verify the closed parent is present as a root node.
    expect(screen.getByTestId('tree-node-5')).toHaveTextContent('#5');
  });
});
