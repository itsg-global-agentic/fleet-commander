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
// Mocks — must be declared before import. vi.mock calls are hoisted.
// vi.hoisted() ensures variables are available in hoisted vi.mock factories.
// ---------------------------------------------------------------------------

const {
  mockFetchRawIssueHierarchy,
  mockFetchMissingParents,
  mockFetchSingleIssueDeps,
  mockResolveIssueStates,
  mockDb,
} = vi.hoisted(() => ({
  mockFetchRawIssueHierarchy: vi.fn(),
  mockFetchMissingParents: vi.fn(),
  mockFetchSingleIssueDeps: vi.fn(),
  mockResolveIssueStates: vi.fn(),
  mockDb: {
    getProject: vi.fn().mockReturnValue({
      id: 1,
      name: 'test-repo',
      githubRepo: 'owner/repo',
      issueProvider: null,
      projectKey: null,
      providerConfig: null,
    }),
    getProjects: vi.fn().mockReturnValue([]),
    getIssueSources: vi.fn().mockReturnValue([]),
    getActiveTeams: vi.fn().mockReturnValue([]),
    getActiveTeamsByProject: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('../../src/server/db.js', () => ({
  getDatabase: () => mockDb,
}));

vi.mock('../../src/server/config.js', () => ({
  default: {
    issuePollIntervalMs: 60000,
  },
}));

// We mock the entire providers/index module and providers/github-issue-provider module.
// The key trick: since the IssueFetcher does `instanceof GitHubIssueProvider` check,
// we need the mock provider to pass that check. We accomplish this by mocking
// GitHubIssueProvider class and making getIssueProvider return instances of it.

vi.mock('../../src/server/providers/github-issue-provider.js', () => {
  // Create a real class so instanceof works
  class GitHubIssueProvider {
    name = 'github';
    capabilities = {
      dependencies: true,
      subIssues: true,
      labels: true,
      boardStatuses: false,
      priorities: false,
      assignees: true,
      linkedPRs: true,
    };
    fetchRawIssueHierarchy = mockFetchRawIssueHierarchy;
    fetchMissingParents = mockFetchMissingParents;
    fetchSingleIssueDeps = mockFetchSingleIssueDeps;
    resolveIssueStates = mockResolveIssueStates;
    isBlockedBySupported = true;
    resetBlockedBySupport = vi.fn();
    getIssue = vi.fn().mockResolvedValue(null);
    queryIssues = vi.fn().mockResolvedValue({ issues: [], cursor: null, hasMore: false });
    getDependencies = vi.fn().mockResolvedValue([]);
    getLinkedPRs = vi.fn().mockResolvedValue([]);
    mapToGenericIssue = vi.fn();
  }

  return {
    GitHubIssueProvider,
    parseDependenciesFromBody: vi.fn().mockReturnValue([]),
    runWithConcurrency: async <T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> => {
      const results: T[] = new Array(tasks.length);
      let nextIndex = 0;
      async function worker(): Promise<void> {
        while (nextIndex < tasks.length) {
          const idx = nextIndex++;
          results[idx] = await tasks[idx]();
        }
      }
      const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
      await Promise.all(workers);
      return results;
    },
    parseRepo: (githubRepo: string): [string, string] => {
      const parts = githubRepo.split('/');
      return [parts[0] || 'unknown', parts[1] || 'unknown'];
    },
    GITHUB_STATUS_MAP: { OPEN: 'open', CLOSED: 'closed' },
    MAX_CONCURRENT_RESOLVE: 5,
    ISSUES_QUERY_FULL: '',
    ISSUES_QUERY_BASIC: '',
    SINGLE_ISSUE_DEPS_QUERY_FULL: '',
    SINGLE_ISSUE_DEPS_QUERY_BASIC: '',
  };
});

// The provider singleton instance -- created fresh per getIssueProvider call
vi.mock('../../src/server/providers/index.js', async () => {
  const { GitHubIssueProvider } = await import('../../src/server/providers/github-issue-provider.js');
  const instance = new GitHubIssueProvider();
  return {
    getIssueProvider: () => instance,
    resetProviders: vi.fn(),
  };
});

// Import after mocks
import IssueFetcher from '../../src/server/services/issue-fetcher.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockNode {
  number: number;
  title: string;
  state?: string;
  url?: string;
  parent?: { number: number; title: string } | null;
  labels?: { nodes?: Array<{ name: string }> };
  body?: string | null;
}

/** Helper to create a mock fetchRawIssueHierarchy return value */
function makeRawHierarchyResult(nodes: MockNode[], fetchComplete = true) {
  return {
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
      body: n.body ?? null,
    })),
    fetchComplete,
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
    mockFetchRawIssueHierarchy.mockResolvedValue(
      makeRawHierarchyResult([
        { number: 10, title: 'Open child', parent: { number: 5, title: 'Closed parent' } },
        { number: 20, title: 'Root issue' },
      ])
    );

    mockFetchMissingParents.mockResolvedValue([]);

    const result = await fetcher.fetchIssueHierarchy(1);

    // fetchMissingParents was called with [5]
    expect(mockFetchMissingParents).toHaveBeenCalledWith('owner', 'repo', [5]);

    // Since fetchMissingParents returned empty (failed), orphan #10 becomes root
    const rootNumbers = result.map((n) => n.number).sort((a, b) => a - b);
    expect(rootNumbers).toEqual([10, 20]);

    // Both should be at root level, not nested
    expect(result.find((n) => n.number === 10)!.children).toHaveLength(0);
    expect(result.find((n) => n.number === 20)!.children).toHaveLength(0);
  });

  it('injects closed parent and links children when parent fetch succeeds', async () => {
    mockFetchRawIssueHierarchy.mockResolvedValue(
      makeRawHierarchyResult([
        { number: 10, title: 'Sub-issue A', parent: { number: 5, title: 'Epic (closed)' } },
        { number: 11, title: 'Sub-issue B', parent: { number: 5, title: 'Epic (closed)' } },
        { number: 20, title: 'Standalone issue' },
      ])
    );

    const closedParentNode = {
      number: 5,
      title: 'Epic (closed)',
      state: 'CLOSED',
      url: 'https://github.com/owner/repo/issues/5',
      labels: { nodes: [] as Array<{ name: string }> },
    };

    mockFetchMissingParents.mockResolvedValue([closedParentNode]);

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
  });

  it('does not call fetchMissingParents when all parents are present', async () => {
    mockFetchRawIssueHierarchy.mockResolvedValue(
      makeRawHierarchyResult([
        { number: 5, title: 'Parent issue' },
        { number: 10, title: 'Child issue', parent: { number: 5, title: 'Parent issue' } },
      ])
    );

    const result = await fetcher.fetchIssueHierarchy(1);

    // fetchMissingParents should NOT be called
    expect(mockFetchMissingParents).not.toHaveBeenCalled();

    // #5 is root with #10 as child
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(5);
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].number).toBe(10);
  });

  it('handles multiple orphan parents — some fetched, some failed', async () => {
    mockFetchRawIssueHierarchy.mockResolvedValue(
      makeRawHierarchyResult([
        { number: 10, title: 'Child of 5', parent: { number: 5, title: 'Parent A' } },
        { number: 20, title: 'Child of 15', parent: { number: 15, title: 'Parent B' } },
        { number: 30, title: 'Standalone' },
      ])
    );

    const closedParent5 = {
      number: 5,
      title: 'Parent A (closed)',
      state: 'CLOSED',
      url: 'https://github.com/owner/repo/issues/5',
      labels: { nodes: [] as Array<{ name: string }> },
    };

    // Only parent #5 is returned; #15 fetch failed
    mockFetchMissingParents.mockResolvedValue([closedParent5]);

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
  });

  it('does not duplicate children when re-linking orphans', async () => {
    mockFetchRawIssueHierarchy.mockResolvedValue(
      makeRawHierarchyResult([
        { number: 10, title: 'Only child', parent: { number: 5, title: 'Closed parent' } },
      ])
    );

    const closedParent = {
      number: 5,
      title: 'Closed parent',
      state: 'CLOSED',
      url: 'https://github.com/owner/repo/issues/5',
      labels: { nodes: [] as Array<{ name: string }> },
    };

    mockFetchMissingParents.mockResolvedValue([closedParent]);

    const result = await fetcher.fetchIssueHierarchy(1);

    const parentNode = result.find((n) => n.number === 5)!;
    // Should have exactly 1 child, not duplicated
    expect(parentNode.children).toHaveLength(1);
    expect(parentNode.children[0].number).toBe(10);
  });

  it('handles empty GraphQL response gracefully', async () => {
    mockFetchRawIssueHierarchy.mockResolvedValue(
      makeRawHierarchyResult([])
    );

    const result = await fetcher.fetchIssueHierarchy(1);

    expect(result).toHaveLength(0);
    expect(mockFetchMissingParents).not.toHaveBeenCalled();
  });

  it('preserves normal tree structure when no orphans exist', async () => {
    mockFetchRawIssueHierarchy.mockResolvedValue(
      makeRawHierarchyResult([
        { number: 1, title: 'Root A' },
        { number: 2, title: 'Root B' },
        { number: 10, title: 'Child of A', parent: { number: 1, title: 'Root A' } },
        { number: 11, title: 'Child of A', parent: { number: 1, title: 'Root A' } },
        { number: 20, title: 'Child of B', parent: { number: 2, title: 'Root B' } },
      ])
    );

    const result = await fetcher.fetchIssueHierarchy(1);

    expect(mockFetchMissingParents).not.toHaveBeenCalled();

    expect(result).toHaveLength(2);

    const rootA = result.find((n) => n.number === 1)!;
    const rootB = result.find((n) => n.number === 2)!;

    expect(rootA.children.map((c) => c.number).sort((a, b) => a - b)).toEqual([10, 11]);
    expect(rootB.children.map((c) => c.number)).toEqual([20]);
  });
});

// ---------------------------------------------------------------------------
// Partial fetch failure caching tests
// ---------------------------------------------------------------------------

describe('IssueFetcher partial fetch failure caching', () => {
  let fetcher: IssueFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new IssueFetcher();
  });

  it('should not cache empty results with valid cachedAt when GraphQL fetch fails on first page', async () => {
    // Simulate gh CLI error on the very first page (fetchComplete = false, empty nodes)
    mockFetchRawIssueHierarchy.mockResolvedValue({
      nodes: [],
      fetchComplete: false,
    });

    const result = await fetcher.fetchIssueHierarchy(1);

    // Should return empty array
    expect(result).toHaveLength(0);

    // The cache entry should exist but with cachedAt: null (not a valid timestamp)
    const cache = (fetcher as any).cacheByProject.get(1);
    expect(cache).toBeDefined();
    expect(cache.cachedAt).toBeNull();
    expect(cache.issues).toHaveLength(0);
  });

  it('should preserve previous good cache when GraphQL fetch fails mid-pagination', async () => {
    // First, successfully populate the cache with valid data
    mockFetchRawIssueHierarchy.mockResolvedValue(
      makeRawHierarchyResult([
        { number: 1, title: 'Issue 1' },
        { number: 2, title: 'Issue 2' },
      ])
    );

    const firstResult = await fetcher.fetchIssueHierarchy(1);
    expect(firstResult).toHaveLength(2);

    // Capture the original cachedAt timestamp
    const cacheAfterSuccess = (fetcher as any).cacheByProject.get(1);
    const originalCachedAt = cacheAfterSuccess.cachedAt;
    expect(originalCachedAt).not.toBeNull();

    // Now simulate a failure on the next fetch (fetchComplete: false)
    mockFetchRawIssueHierarchy.mockResolvedValue({
      nodes: [],
      fetchComplete: false,
    });

    const secondResult = await fetcher.fetchIssueHierarchy(1);
    // The function still returns whatever it collected (empty in this case)
    expect(secondResult).toHaveLength(0);

    // But the cache should still hold the previous good data
    const cacheAfterFailure = (fetcher as any).cacheByProject.get(1);
    expect(cacheAfterFailure.issues).toHaveLength(2);
    expect(cacheAfterFailure.cachedAt).toBe(originalCachedAt);
  });

  it('should set cachedAt to null on first fetch failure so getIssues triggers refetch', async () => {
    // No prior cache — simulate gh CLI error
    mockFetchRawIssueHierarchy.mockResolvedValue({
      nodes: [],
      fetchComplete: false,
    });

    await fetcher.fetchIssueHierarchy(1);

    // cachedAt should be null
    const cache = (fetcher as any).cacheByProject.get(1);
    expect(cache.cachedAt).toBeNull();

    // Now spy on fetchIssueHierarchy to verify getIssues triggers a refetch
    const fetchSpy = vi.spyOn(fetcher, 'fetchIssueHierarchy').mockResolvedValue([]);

    const issues = await fetcher.getIssues(1);

    // getIssues should return empty (from cache) and trigger a background refetch
    expect(issues).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledWith(1);

    fetchSpy.mockRestore();
  });

  it('should cache with valid cachedAt when fetch completes successfully', async () => {
    mockFetchRawIssueHierarchy.mockResolvedValue(
      makeRawHierarchyResult([
        { number: 1, title: 'Issue 1' },
      ])
    );

    await fetcher.fetchIssueHierarchy(1);

    const cache = (fetcher as any).cacheByProject.get(1);
    expect(cache).toBeDefined();
    expect(cache.cachedAt).not.toBeNull();
    expect(typeof cache.cachedAt).toBe('string');
    expect(cache.issues).toHaveLength(1);
  });

  it('should cache empty repository correctly with valid cachedAt', async () => {
    // Empty repo — zero issues but fetch completes successfully
    mockFetchRawIssueHierarchy.mockResolvedValue(
      makeRawHierarchyResult([])
    );

    await fetcher.fetchIssueHierarchy(1);

    const cache = (fetcher as any).cacheByProject.get(1);
    expect(cache).toBeDefined();
    expect(cache.cachedAt).not.toBeNull();
    expect(typeof cache.cachedAt).toBe('string');
    expect(cache.issues).toHaveLength(0);
  });

  it('should not cache when fetchComplete is false on first page with no prior cache', async () => {
    // Simulate a response where fetchComplete is false (partial failure)
    mockFetchRawIssueHierarchy.mockResolvedValue({
      nodes: [],
      fetchComplete: false,
    });

    await fetcher.fetchIssueHierarchy(1);

    // Should set cachedAt to null since this is a partial failure with no prior cache
    const cache = (fetcher as any).cacheByProject.get(1);
    expect(cache).toBeDefined();
    expect(cache.cachedAt).toBeNull();
  });
});
