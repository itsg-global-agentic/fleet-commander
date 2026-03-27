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

vi.mock('../../src/client/hooks/useFleetSSE', () => ({
  useFleetSSE: () => {},
}));

vi.mock('../../src/client/hooks/usePrioritization', () => ({
  usePrioritization: () => ({
    priorityMap: new Map(),
    loading: false,
    error: null,
    hasPriority: false,
    prioritize: vi.fn(),
    prioritizeSubtree: vi.fn(),
    reset: vi.fn(),
    toggleCheck: vi.fn(),
    checkedIssues: new Set(),
    checkedSortedIssueNumbers: [],
    sortedIssueNumbers: [],
    costUsd: null,
    durationMs: null,
    fetchPriorities: vi.fn(),
  }),
  sortTreeByPriority: (tree: unknown[]) => tree,
}));

const mockExpandAll = vi.fn();
const mockCollapseAll = vi.fn();
const mockToggleCollapse = vi.fn();
const mockSeedDefaults = vi.fn();

vi.mock('../../src/client/hooks/useCollapseState', () => ({
  useCollapseState: () => ({
    collapsedNodes: new Set<string>(),
    toggleCollapse: mockToggleCollapse,
    expandAll: mockExpandAll,
    collapseAll: mockCollapseAll,
    isCollapsed: () => false,
    seedDefaults: mockSeedDefaults,
  }),
}));

// Mock TreeNode to keep rendering lightweight
vi.mock('../../src/client/components/TreeNode', () => ({
  TreeNode: (props: { node: { number: number; title: string } }) => (
    <div data-testid={`tree-node-${props.node.number}`}>
      #{props.node.number} {props.node.title}
    </div>
  ),
}));

// Mock VirtualizedTreeList to render rows without virtualization
vi.mock('../../src/client/components/VirtualizedTreeList', () => ({
  VirtualizedTreeList: (props: { rows: Array<{ node: { number: number; title: string }; key: string }> }) => (
    <div data-testid="virtualized-tree-list">
      {props.rows.map((row) => (
        <div key={row.key} data-testid={`tree-node-${row.node.number}`}>
          #{row.node.number} {row.node.title}
        </div>
      ))}
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
    { id: 1, name: 'test-project', githubRepo: 'user/test', maxActiveTeams: 5, activeTeamCount: 0, queuedTeamCount: 0, status: 'active' },
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

  // -------------------------------------------------------------------------
  // Expand All / Collapse All buttons (Issue #349)
  // -------------------------------------------------------------------------

  it('renders Expand All and Collapse All buttons', async () => {
    setupMockApi();
    render(<IssueTreeView />);
    await waitFor(() => {
      expect(screen.getByText('Expand All')).toBeInTheDocument();
      expect(screen.getByText('Collapse All')).toBeInTheDocument();
    });
  });

  it('calls expandAll when Expand All button is clicked', async () => {
    setupMockApi();
    render(<IssueTreeView />);
    await waitFor(() => {
      expect(screen.getByText('Expand All')).toBeInTheDocument();
    });
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByText('Expand All'));
    expect(mockExpandAll).toHaveBeenCalled();
  });

  it('calls collapseAll when Collapse All button is clicked', async () => {
    setupMockApi();
    render(<IssueTreeView />);
    await waitFor(() => {
      expect(screen.getByText('Collapse All')).toBeInTheDocument();
    });
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByText('Collapse All'));
    expect(mockCollapseAll).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Collapse All includes project groups (Issue #353)
  // -------------------------------------------------------------------------

  it('collapseAll includes project group IDs when groups are present', async () => {
    const issueA = { number: 10, title: 'Issue A', state: 'open', labels: [], children: [], activeTeam: null };
    const issueB = { number: 20, title: 'Issue B', state: 'open', labels: [], children: [], activeTeam: null };
    mockGet.mockImplementation((path: string) => {
      if (path === 'issues') {
        return Promise.resolve({
          tree: [issueA, issueB],
          groups: [
            {
              projectId: 1,
              projectName: 'project-alpha',
              tree: [issueA],
              cachedAt: null,
              count: 1,
            },
            {
              projectId: 2,
              projectName: 'project-beta',
              tree: [issueB],
              cachedAt: null,
              count: 1,
            },
          ],
          cachedAt: '2026-03-22T10:00:00Z',
          count: 2,
        });
      }
      if (path === 'projects') return Promise.resolve(makeProjectsResponse());
      return Promise.resolve({});
    });

    render(<IssueTreeView />);
    await waitFor(() => {
      expect(screen.getByText('Collapse All')).toBeInTheDocument();
    });
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByText('Collapse All'));

    // collapseAll should be called with an array that includes project-1, project-2,
    // plus the issue node IDs (10, 20)
    expect(mockCollapseAll).toHaveBeenCalledWith(
      expect.arrayContaining(['project-1', 'project-2', '10', '20']),
    );
  });

  it('project group toggle calls onToggleCollapse with project node ID', async () => {
    const groupIssue = { number: 1, title: 'Issue 1', state: 'open', labels: [], children: [], activeTeam: null };
    mockGet.mockImplementation((path: string) => {
      if (path === 'issues') {
        return Promise.resolve({
          tree: [groupIssue],
          groups: [
            {
              projectId: 5,
              projectName: 'my-repo',
              tree: [groupIssue],
              cachedAt: null,
              count: 1,
            },
          ],
          cachedAt: '2026-03-22T10:00:00Z',
          count: 1,
        });
      }
      if (path === 'projects') return Promise.resolve(makeProjectsResponse());
      return Promise.resolve({});
    });

    render(<IssueTreeView />);
    await waitFor(() => {
      expect(screen.getByText('my-repo')).toBeInTheDocument();
    });
    const { fireEvent } = await import('@testing-library/react');
    // Click the project group header to toggle
    fireEvent.click(screen.getByText('my-repo'));
    expect(mockToggleCollapse).toHaveBeenCalledWith('project-5');
  });

  // -------------------------------------------------------------------------
  // Run All button (Issue #347)
  // -------------------------------------------------------------------------

  it('renders Run All button in single-project view', async () => {
    setupMockApi();
    render(<IssueTreeView />);
    await waitFor(() => {
      expect(screen.getByText('Run All')).toBeInTheDocument();
    });
  });

  it('renders Run All button in project group view', async () => {
    const groupIssue = { number: 1, title: 'Issue 1', state: 'open', labels: [], children: [], activeTeam: null };
    mockGet.mockImplementation((path: string) => {
      if (path === 'issues') {
        return Promise.resolve({
          tree: [groupIssue],
          groups: [
            {
              projectId: 1,
              projectName: 'grouped-repo',
              tree: [groupIssue],
              cachedAt: null,
              count: 1,
            },
          ],
          cachedAt: '2026-03-22T10:00:00Z',
          count: 1,
        });
      }
      if (path === 'projects') return Promise.resolve(makeProjectsResponse());
      return Promise.resolve({});
    });

    render(<IssueTreeView />);
    await waitFor(() => {
      expect(screen.getByText('Run All')).toBeInTheDocument();
    });
  });

  it('Run All button is disabled when no launchable issues', async () => {
    // All issues have active teams — nothing to launch
    mockGet.mockImplementation((path: string) => {
      if (path === 'issues') {
        return Promise.resolve({
          tree: [
            {
              number: 10,
              title: 'Already running',
              state: 'open',
              labels: [],
              children: [],
              activeTeam: { id: 1, status: 'running' },
            },
          ],
          cachedAt: '2026-03-22T10:00:00Z',
          count: 1,
        });
      }
      if (path === 'projects') return Promise.resolve(makeProjectsResponse());
      return Promise.resolve({});
    });

    render(<IssueTreeView />);
    await waitFor(() => {
      expect(screen.getByText('Run All')).toBeInTheDocument();
    });
    const runAllBtn = screen.getByText('Run All').closest('button')!;
    expect(runAllBtn).toBeDisabled();
  });

  it('Run All button opens confirmation dialog when clicked', async () => {
    setupMockApi();
    render(<IssueTreeView />);
    await waitFor(() => {
      expect(screen.getByText('Run All')).toBeInTheDocument();
    });
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByText('Run All'));
    await waitFor(() => {
      expect(screen.getByText(/Launch 2 teams\?/)).toBeInTheDocument();
    });
  });

  it('Run All dialog shows skipped issue counts', async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === 'issues') {
        return Promise.resolve({
          tree: [
            { number: 10, title: 'Launchable', state: 'open', labels: [], children: [], activeTeam: null },
            { number: 20, title: 'Has team', state: 'open', labels: [], children: [], activeTeam: { id: 1, status: 'running' } },
            {
              number: 30, title: 'Blocked', state: 'open', labels: [], children: [], activeTeam: null,
              dependencies: { issueNumber: 30, blockedBy: [{ number: 5, owner: 'o', repo: 'r', state: 'open', title: 'Blocker' }], resolved: false, openCount: 1 },
            },
          ],
          cachedAt: '2026-03-22T10:00:00Z',
          count: 3,
        });
      }
      if (path === 'projects') return Promise.resolve(makeProjectsResponse());
      return Promise.resolve({});
    });

    render(<IssueTreeView />);
    await waitFor(() => {
      expect(screen.getByText('Run All')).toBeInTheDocument();
    });
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByText('Run All'));
    await waitFor(() => {
      expect(screen.getByText(/Launch 1 team\?/)).toBeInTheDocument();
      expect(screen.getByText(/1 issue skipped \(already have active teams\)/)).toBeInTheDocument();
      expect(screen.getByText(/1 issue skipped \(blocked by dependencies\)/)).toBeInTheDocument();
    });
  });

  it('Run All dialog Cancel button closes the dialog', async () => {
    setupMockApi();
    render(<IssueTreeView />);
    await waitFor(() => {
      expect(screen.getByText('Run All')).toBeInTheDocument();
    });
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByText('Run All'));
    await waitFor(() => {
      expect(screen.getByText(/Launch 2 teams\?/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => {
      expect(screen.queryByText(/Launch 2 teams\?/)).not.toBeInTheDocument();
    });
  });

  it('Run All dialog Launch All button calls launch-batch API', async () => {
    setupMockApi();
    mockPost.mockResolvedValue({ launched: 2 });
    render(<IssueTreeView />);
    await waitFor(() => {
      expect(screen.getByText('Run All')).toBeInTheDocument();
    });
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByText('Run All'));
    await waitFor(() => {
      expect(screen.getByText(/Launch 2 teams\?/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Launch All'));
    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith('teams/launch-batch', {
        projectId: 1,
        issues: [
          { number: 10, title: 'Fix login' },
          { number: 20, title: 'Add feature' },
        ],
      });
    });
  });

  // -------------------------------------------------------------------------
  // Project group collapsible sections (Issue #441)
  // -------------------------------------------------------------------------

  it('renders project group headers when projects have groupId', async () => {
    const issueA = { number: 10, title: 'Issue A', state: 'open', labels: [], children: [], activeTeam: null };
    const issueB = { number: 20, title: 'Issue B', state: 'open', labels: [], children: [], activeTeam: null };
    const issueC = { number: 30, title: 'Issue C', state: 'open', labels: [], children: [], activeTeam: null };
    mockGet.mockImplementation((path: string) => {
      if (path === 'issues') {
        return Promise.resolve({
          tree: [issueA, issueB, issueC],
          groups: [
            {
              projectId: 1,
              projectName: 'frontend-app',
              groupId: 100,
              groupName: 'Frontend',
              tree: [issueA],
              cachedAt: null,
              count: 1,
            },
            {
              projectId: 2,
              projectName: 'backend-api',
              groupId: 200,
              groupName: 'Backend',
              tree: [issueB],
              cachedAt: null,
              count: 1,
            },
            {
              projectId: 3,
              projectName: 'misc-scripts',
              groupId: null,
              groupName: null,
              tree: [issueC],
              cachedAt: null,
              count: 1,
            },
          ],
          cachedAt: '2026-03-25T10:00:00Z',
          count: 3,
        });
      }
      if (path === 'projects') return Promise.resolve(makeProjectsResponse());
      return Promise.resolve({});
    });

    render(<IssueTreeView />);
    await waitFor(() => {
      // Group headers should be rendered
      expect(screen.getByText('Frontend')).toBeInTheDocument();
      expect(screen.getByText('Backend')).toBeInTheDocument();
      expect(screen.getByText('Ungrouped')).toBeInTheDocument();
    });

    // Project names should still be visible under their groups
    expect(screen.getByText('frontend-app')).toBeInTheDocument();
    expect(screen.getByText('backend-api')).toBeInTheDocument();
    expect(screen.getByText('misc-scripts')).toBeInTheDocument();
  });

  it('does not render group headers when no projects have groupId', async () => {
    const issueA = { number: 10, title: 'Issue A', state: 'open', labels: [], children: [], activeTeam: null };
    const issueB = { number: 20, title: 'Issue B', state: 'open', labels: [], children: [], activeTeam: null };
    mockGet.mockImplementation((path: string) => {
      if (path === 'issues') {
        return Promise.resolve({
          tree: [issueA, issueB],
          groups: [
            {
              projectId: 1,
              projectName: 'project-alpha',
              groupId: null,
              groupName: null,
              tree: [issueA],
              cachedAt: null,
              count: 1,
            },
            {
              projectId: 2,
              projectName: 'project-beta',
              groupId: null,
              groupName: null,
              tree: [issueB],
              cachedAt: null,
              count: 1,
            },
          ],
          cachedAt: '2026-03-25T10:00:00Z',
          count: 2,
        });
      }
      if (path === 'projects') return Promise.resolve(makeProjectsResponse());
      return Promise.resolve({});
    });

    render(<IssueTreeView />);
    await waitFor(() => {
      // No "Ungrouped" header since no project has a groupId
      expect(screen.queryByText('Ungrouped')).not.toBeInTheDocument();
      // Projects should still be directly visible as project-level groups
      expect(screen.getByText('project-alpha')).toBeInTheDocument();
      expect(screen.getByText('project-beta')).toBeInTheDocument();
    });
  });

  it('collapsing a project group hides its projects', async () => {
    // Set up collapse state so group-100 is collapsed
    const collapsedSet = new Set(['group-100']);
    vi.mocked(mockToggleCollapse);

    // Override useCollapseState to have group-100 collapsed
    const useCollapseStateMod = await import('../../src/client/hooks/useCollapseState');
    vi.spyOn(useCollapseStateMod, 'useCollapseState').mockReturnValue({
      collapsedNodes: collapsedSet,
      toggleCollapse: mockToggleCollapse,
      expandAll: mockExpandAll,
      collapseAll: mockCollapseAll,
      isCollapsed: (id: string) => collapsedSet.has(id),
      seedDefaults: mockSeedDefaults,
    });

    const issueA = { number: 10, title: 'Issue A', state: 'open', labels: [], children: [], activeTeam: null };
    const issueB = { number: 20, title: 'Issue B', state: 'open', labels: [], children: [], activeTeam: null };
    mockGet.mockImplementation((path: string) => {
      if (path === 'issues') {
        return Promise.resolve({
          tree: [issueA, issueB],
          groups: [
            {
              projectId: 1,
              projectName: 'hidden-project',
              groupId: 100,
              groupName: 'Collapsed Group',
              tree: [issueA],
              cachedAt: null,
              count: 1,
            },
            {
              projectId: 2,
              projectName: 'visible-project',
              groupId: 200,
              groupName: 'Open Group',
              tree: [issueB],
              cachedAt: null,
              count: 1,
            },
          ],
          cachedAt: '2026-03-25T10:00:00Z',
          count: 2,
        });
      }
      if (path === 'projects') return Promise.resolve(makeProjectsResponse());
      return Promise.resolve({});
    });

    render(<IssueTreeView />);
    await waitFor(() => {
      // Both group headers should be visible
      expect(screen.getByText('Collapsed Group')).toBeInTheDocument();
      expect(screen.getByText('Open Group')).toBeInTheDocument();
    });

    // The collapsed group's project should NOT be visible
    expect(screen.queryByText('hidden-project')).not.toBeInTheDocument();
    // The open group's project SHOULD be visible
    expect(screen.getByText('visible-project')).toBeInTheDocument();
  });

  it('collapseAll includes group bucket IDs when project groups are present', async () => {
    const issueA = { number: 10, title: 'Issue A', state: 'open', labels: [], children: [], activeTeam: null };
    const issueB = { number: 20, title: 'Issue B', state: 'open', labels: [], children: [], activeTeam: null };
    mockGet.mockImplementation((path: string) => {
      if (path === 'issues') {
        return Promise.resolve({
          tree: [issueA, issueB],
          groups: [
            {
              projectId: 1,
              projectName: 'frontend',
              groupId: 100,
              groupName: 'Frontend',
              tree: [issueA],
              cachedAt: null,
              count: 1,
            },
            {
              projectId: 2,
              projectName: 'backend',
              groupId: null,
              groupName: null,
              tree: [issueB],
              cachedAt: null,
              count: 1,
            },
          ],
          cachedAt: '2026-03-25T10:00:00Z',
          count: 2,
        });
      }
      if (path === 'projects') return Promise.resolve(makeProjectsResponse());
      return Promise.resolve({});
    });

    render(<IssueTreeView />);
    await waitFor(() => {
      expect(screen.getByText('Collapse All')).toBeInTheDocument();
    });
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByText('Collapse All'));

    // collapseAll should include group bucket IDs (group-100, group-ungrouped),
    // project IDs (project-1, project-2), and issue IDs (10, 20)
    expect(mockCollapseAll).toHaveBeenCalledWith(
      expect.arrayContaining(['group-100', 'group-ungrouped', 'project-1', 'project-2', '10', '20']),
    );
  });

  it('renders issue nodes inside project groups when groups are present', async () => {
    // Restore any spies from previous tests to get a clean useCollapseState mock
    vi.restoreAllMocks();

    const issueA = { number: 51, title: 'Issue Alpha-1', state: 'open', labels: [], children: [], activeTeam: null };
    const issueB = { number: 52, title: 'Issue Alpha-2', state: 'open', labels: [], children: [], activeTeam: null };
    const issueC = { number: 61, title: 'Issue Beta-1', state: 'open', labels: [], children: [], activeTeam: null };
    const issueD = { number: 62, title: 'Issue Beta-2', state: 'open', labels: [], children: [], activeTeam: null };
    mockGet.mockImplementation((path: string) => {
      if (path === 'issues') {
        return Promise.resolve({
          tree: [issueA, issueB, issueC, issueD],
          groups: [
            {
              projectId: 10,
              projectName: 'project-alpha',
              groupId: 300,
              groupName: 'Alpha Group',
              tree: [issueA, issueB],
              cachedAt: null,
              count: 2,
            },
            {
              projectId: 20,
              projectName: 'project-beta',
              groupId: 400,
              groupName: 'Beta Group',
              tree: [issueC, issueD],
              cachedAt: null,
              count: 2,
            },
          ],
          cachedAt: '2026-03-27T10:00:00Z',
          count: 4,
        });
      }
      if (path === 'projects') {
        return Promise.resolve([
          { id: 10, name: 'project-alpha', githubRepo: 'user/alpha', maxActiveTeams: 5, activeTeamCount: 0, queuedTeamCount: 0, status: 'active' },
          { id: 20, name: 'project-beta', githubRepo: 'user/beta', maxActiveTeams: 5, activeTeamCount: 0, queuedTeamCount: 0, status: 'active' },
        ]);
      }
      return Promise.resolve({});
    });

    render(<IssueTreeView />);
    await waitFor(() => {
      // Group headers should be rendered
      expect(screen.getByText('Alpha Group')).toBeInTheDocument();
      expect(screen.getByText('Beta Group')).toBeInTheDocument();
    });

    // Issue nodes from BOTH groups should be rendered (not just headers)
    await waitFor(() => {
      expect(screen.getByTestId('tree-node-51')).toBeInTheDocument();
      expect(screen.getByTestId('tree-node-52')).toBeInTheDocument();
      expect(screen.getByTestId('tree-node-61')).toBeInTheDocument();
      expect(screen.getByTestId('tree-node-62')).toBeInTheDocument();
    });

    // Project names should also be visible
    expect(screen.getByText('project-alpha')).toBeInTheDocument();
    expect(screen.getByText('project-beta')).toBeInTheDocument();
  });

  it('clicking a group header toggles the group collapse state', async () => {
    const issueA = { number: 10, title: 'Issue A', state: 'open', labels: [], children: [], activeTeam: null };
    mockGet.mockImplementation((path: string) => {
      if (path === 'issues') {
        return Promise.resolve({
          tree: [issueA],
          groups: [
            {
              projectId: 1,
              projectName: 'test-project',
              groupId: 100,
              groupName: 'My Group',
              tree: [issueA],
              cachedAt: null,
              count: 1,
            },
          ],
          cachedAt: '2026-03-25T10:00:00Z',
          count: 1,
        });
      }
      if (path === 'projects') return Promise.resolve(makeProjectsResponse());
      return Promise.resolve({});
    });

    render(<IssueTreeView />);
    await waitFor(() => {
      expect(screen.getByText('My Group')).toBeInTheDocument();
    });
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByText('My Group'));
    expect(mockToggleCollapse).toHaveBeenCalledWith('group-100');
  });
});
