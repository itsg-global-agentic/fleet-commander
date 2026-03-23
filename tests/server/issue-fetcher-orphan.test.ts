// =============================================================================
// Fleet Commander -- Issue Fetcher Orphan Detection Tests
// =============================================================================
// Tests that open sub-issues whose parent is closed are not hidden from the
// tree. When the main GraphQL query returns only OPEN issues, closed parents
// are missing. The orphan detection logic should:
//   1. Detect children whose parent is not in the fetched set
//   2. Fetch those missing parents via a batched GraphQL query (aliases)
//   3. Inject them as closed nodes in the tree
//   4. Fall back to promoting orphans to root if the parent fetch fails
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IssueNode } from '../../src/server/services/issue-fetcher.js';

// ---------------------------------------------------------------------------
// Mocks — must be declared before import
// ---------------------------------------------------------------------------

const mockDb = {
  getProject: vi.fn().mockReturnValue({
    id: 1,
    name: 'test-repo',
    githubRepo: 'owner/repo',
  }),
  getProjects: vi.fn().mockReturnValue([]),
  getActiveTeams: vi.fn().mockReturnValue([]),
  getActiveTeamsByProject: vi.fn().mockReturnValue([]),
};

vi.mock('../../src/server/db.js', () => ({
  getDatabase: () => mockDb,
}));

vi.mock('../../src/server/config.js', () => ({
  default: {
    issuePollIntervalMs: 60000,
  },
}));

// Mock child_process.exec (used by fetchMissingParents / resolveIssueStates)
const mockExec = vi.fn();
vi.mock('child_process', () => ({
  exec: (...args: unknown[]) => mockExec(...args),
  spawn: vi.fn(),
}));

// Mock util.promisify so that execAsync uses our mockExec
vi.mock('util', () => ({
  promisify: (fn: unknown) => {
    // Return a function that wraps mockExec into a Promise
    return (...args: unknown[]) => {
      return new Promise((resolve, reject) => {
        // Call the mock with a callback pattern
        (fn as Function)(...args, (err: Error | null, result: unknown) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
    };
  },
}));

// Import after mocks
import IssueFetcher from '../../src/server/services/issue-fetcher.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Helper to create a minimal GraphQL response for the executeGraphQL mock */
function makeGraphQLResponse(nodes: Array<{
  number: number;
  title: string;
  state?: string;
  url?: string;
  parent?: { number: number; title: string } | null;
  labels?: { nodes?: Array<{ name: string }> };
}>) {
  return {
    data: {
      repository: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: nodes.map((n) => ({
            number: n.number,
            title: n.title,
            state: n.state ?? 'OPEN',
            url: n.url ?? `https://github.com/owner/repo/issues/${n.number}`,
            labels: n.labels ?? { nodes: [] },
            parent: n.parent ?? null,
            subIssuesSummary: undefined,
            closedByPullRequestsReferences: undefined,
            blockedBy: undefined,
            issueDependenciesSummary: undefined,
          })),
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IssueFetcher orphan detection', () => {
  let fetcher: IssueFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new IssueFetcher();
  });

  it('promotes orphaned children to root when parent fetch fails completely', async () => {
    // Scenario: issue #10 (open) has parent #5 (closed, not in OPEN query).
    // The fetchMissingParents call fails for #5 -> child #10 should become root.
    const graphqlSpy = vi.spyOn(fetcher as any, 'executeGraphQL').mockResolvedValue(
      makeGraphQLResponse([
        { number: 10, title: 'Open child', parent: { number: 5, title: 'Closed parent' } },
        { number: 20, title: 'Root issue' },
      ])
    );

    const fetchParentsSpy = vi.spyOn(fetcher as any, 'fetchMissingParents').mockResolvedValue([]);

    const result = await fetcher.fetchIssueHierarchy(1);

    // fetchMissingParents was called with [5]
    expect(fetchParentsSpy).toHaveBeenCalledWith('owner', 'repo', [5]);

    // Since fetchMissingParents returned empty (failed), orphan #10 becomes root
    const rootNumbers = result.map((n) => n.number).sort((a, b) => a - b);
    expect(rootNumbers).toEqual([10, 20]);

    // Both should be at root level, not nested
    expect(result.find((n) => n.number === 10)!.children).toHaveLength(0);
    expect(result.find((n) => n.number === 20)!.children).toHaveLength(0);

    graphqlSpy.mockRestore();
    fetchParentsSpy.mockRestore();
  });

  it('injects closed parent and links children when parent fetch succeeds', async () => {
    // Scenario: issues #10, #11 (open) have parent #5 (closed).
    // fetchMissingParents returns #5 as a closed node.
    const graphqlSpy = vi.spyOn(fetcher as any, 'executeGraphQL').mockResolvedValue(
      makeGraphQLResponse([
        { number: 10, title: 'Sub-issue A', parent: { number: 5, title: 'Epic (closed)' } },
        { number: 11, title: 'Sub-issue B', parent: { number: 5, title: 'Epic (closed)' } },
        { number: 20, title: 'Standalone issue' },
      ])
    );

    const closedParent: IssueNode = {
      number: 5,
      title: 'Epic (closed)',
      state: 'closed',
      labels: [],
      url: 'https://github.com/owner/repo/issues/5',
      children: [],
      activeTeam: null,
    };

    const fetchParentsSpy = vi.spyOn(fetcher as any, 'fetchMissingParents').mockResolvedValue([closedParent]);

    const result = await fetcher.fetchIssueHierarchy(1);

    // Root should contain #5 (closed parent) and #20 (standalone)
    const rootNumbers = result.map((n) => n.number).sort((a, b) => a - b);
    expect(rootNumbers).toEqual([5, 20]);

    // #5 should have children #10 and #11
    const parentNode = result.find((n) => n.number === 5)!;
    expect(parentNode.state).toBe('closed');
    const childNumbers = parentNode.children.map((c) => c.number).sort((a, b) => a - b);
    expect(childNumbers).toEqual([10, 11]);

    // #10 and #11 should NOT be at root
    expect(result.find((n) => n.number === 10)).toBeUndefined();
    expect(result.find((n) => n.number === 11)).toBeUndefined();

    graphqlSpy.mockRestore();
    fetchParentsSpy.mockRestore();
  });

  it('does not call fetchMissingParents when all parents are present', async () => {
    // Scenario: all parents are open and present in the fetched set.
    const graphqlSpy = vi.spyOn(fetcher as any, 'executeGraphQL').mockResolvedValue(
      makeGraphQLResponse([
        { number: 5, title: 'Parent issue' },
        { number: 10, title: 'Child issue', parent: { number: 5, title: 'Parent issue' } },
      ])
    );

    const fetchParentsSpy = vi.spyOn(fetcher as any, 'fetchMissingParents');

    const result = await fetcher.fetchIssueHierarchy(1);

    // fetchMissingParents should NOT be called
    expect(fetchParentsSpy).not.toHaveBeenCalled();

    // #5 is root with #10 as child
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(5);
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].number).toBe(10);

    graphqlSpy.mockRestore();
    fetchParentsSpy.mockRestore();
  });

  it('handles multiple orphan parents — some fetched, some failed', async () => {
    // #10 has closed parent #5, #20 has closed parent #15.
    // Only #5 is successfully fetched; #15 fails -> #20 becomes root.
    const graphqlSpy = vi.spyOn(fetcher as any, 'executeGraphQL').mockResolvedValue(
      makeGraphQLResponse([
        { number: 10, title: 'Child of 5', parent: { number: 5, title: 'Parent A' } },
        { number: 20, title: 'Child of 15', parent: { number: 15, title: 'Parent B' } },
        { number: 30, title: 'Standalone' },
      ])
    );

    const closedParent5: IssueNode = {
      number: 5,
      title: 'Parent A (closed)',
      state: 'closed',
      labels: [],
      url: 'https://github.com/owner/repo/issues/5',
      children: [],
      activeTeam: null,
    };

    // Only parent #5 is returned; #15 fetch failed
    const fetchParentsSpy = vi.spyOn(fetcher as any, 'fetchMissingParents').mockResolvedValue([closedParent5]);

    const result = await fetcher.fetchIssueHierarchy(1);

    // Root should have: #5 (fetched closed parent), #20 (promoted orphan), #30 (standalone)
    const rootNumbers = result.map((n) => n.number).sort((a, b) => a - b);
    expect(rootNumbers).toEqual([5, 20, 30]);

    // #5 should have child #10
    const parent5 = result.find((n) => n.number === 5)!;
    expect(parent5.children).toHaveLength(1);
    expect(parent5.children[0].number).toBe(10);

    // #20 should be promoted to root (its parent #15 was not fetched)
    const child20 = result.find((n) => n.number === 20)!;
    expect(child20.children).toHaveLength(0);

    graphqlSpy.mockRestore();
    fetchParentsSpy.mockRestore();
  });

  it('does not duplicate children when re-linking orphans', async () => {
    // Regression check: ensure children are not double-linked
    const graphqlSpy = vi.spyOn(fetcher as any, 'executeGraphQL').mockResolvedValue(
      makeGraphQLResponse([
        { number: 10, title: 'Only child', parent: { number: 5, title: 'Closed parent' } },
      ])
    );

    const closedParent: IssueNode = {
      number: 5,
      title: 'Closed parent',
      state: 'closed',
      labels: [],
      url: 'https://github.com/owner/repo/issues/5',
      children: [],
      activeTeam: null,
    };

    const fetchParentsSpy = vi.spyOn(fetcher as any, 'fetchMissingParents').mockResolvedValue([closedParent]);

    const result = await fetcher.fetchIssueHierarchy(1);

    const parentNode = result.find((n) => n.number === 5)!;
    // Should have exactly 1 child, not duplicated
    expect(parentNode.children).toHaveLength(1);
    expect(parentNode.children[0].number).toBe(10);

    graphqlSpy.mockRestore();
    fetchParentsSpy.mockRestore();
  });

  it('handles empty GraphQL response gracefully', async () => {
    const graphqlSpy = vi.spyOn(fetcher as any, 'executeGraphQL').mockResolvedValue(
      makeGraphQLResponse([])
    );

    const fetchParentsSpy = vi.spyOn(fetcher as any, 'fetchMissingParents');

    const result = await fetcher.fetchIssueHierarchy(1);

    expect(result).toHaveLength(0);
    expect(fetchParentsSpy).not.toHaveBeenCalled();

    graphqlSpy.mockRestore();
    fetchParentsSpy.mockRestore();
  });

  it('preserves normal tree structure when no orphans exist', async () => {
    // Two-level hierarchy, all open
    const graphqlSpy = vi.spyOn(fetcher as any, 'executeGraphQL').mockResolvedValue(
      makeGraphQLResponse([
        { number: 1, title: 'Root A' },
        { number: 2, title: 'Root B' },
        { number: 10, title: 'Child of A', parent: { number: 1, title: 'Root A' } },
        { number: 11, title: 'Child of A', parent: { number: 1, title: 'Root A' } },
        { number: 20, title: 'Child of B', parent: { number: 2, title: 'Root B' } },
      ])
    );

    const fetchParentsSpy = vi.spyOn(fetcher as any, 'fetchMissingParents');

    const result = await fetcher.fetchIssueHierarchy(1);

    expect(fetchParentsSpy).not.toHaveBeenCalled();

    expect(result).toHaveLength(2);

    const rootA = result.find((n) => n.number === 1)!;
    const rootB = result.find((n) => n.number === 2)!;

    expect(rootA.children.map((c) => c.number).sort((a, b) => a - b)).toEqual([10, 11]);
    expect(rootB.children.map((c) => c.number)).toEqual([20]);

    graphqlSpy.mockRestore();
    fetchParentsSpy.mockRestore();
  });
});
