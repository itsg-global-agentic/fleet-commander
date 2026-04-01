// =============================================================================
// Fleet Commander -- Issue Fetcher Cache Update Tests (Issue #646)
// =============================================================================
// Tests for the two new IssueFetcher methods:
//   - markIssueClosed: surgically mark an issue as closed in the cache and
//     update any blockedBy references across the tree
//   - getDependenciesFromCache: look up dependencies from the in-memory cache
//     without making API calls
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IssueNode } from '../../src/server/services/issue-fetcher.js';

// ---------------------------------------------------------------------------
// Mocks — must be declared before import. vi.mock calls are hoisted.
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
    issuePollIntervalMs: 300000,
  },
}));

vi.mock('../../src/server/providers/github-issue-provider.js', () => {
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
    SINGLE_ISSUE_DEPS_QUERY_FULL: '',
  };
});

vi.mock('../../src/server/providers/index.js', async () => {
  const { GitHubIssueProvider } = await import('../../src/server/providers/github-issue-provider.js');
  const instance = new GitHubIssueProvider();
  return {
    getIssueProvider: () => instance,
    resetProviders: vi.fn(),
  };
});

vi.mock('../../src/server/providers/jira-issue-provider.js', () => ({
  JiraIssueProvider: class JiraIssueProvider {},
}));

// Import after mocks
const { IssueFetcher } = await import('../../src/server/services/issue-fetcher.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssueNode(overrides: Partial<IssueNode> & { number: number }): IssueNode {
  return {
    title: `Issue #${overrides.number}`,
    state: 'open',
    labels: [],
    url: `https://github.com/owner/repo/issues/${overrides.number}`,
    children: [],
    activeTeam: null,
    issueKey: String(overrides.number),
    issueProvider: 'github',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let fetcher: InstanceType<typeof IssueFetcher>;

beforeEach(() => {
  vi.clearAllMocks();
  fetcher = new IssueFetcher();
});

// =============================================================================
// markIssueClosed
// =============================================================================

describe('markIssueClosed', () => {
  it('marks a root issue as closed', () => {
    // Populate cache directly via the internal cacheByProject map
    const cache = {
      issues: [
        makeIssueNode({ number: 10, state: 'open' }),
        makeIssueNode({ number: 20, state: 'open' }),
      ],
      cachedAt: new Date().toISOString(),
    };
    (fetcher as unknown as { cacheByProject: Map<number, unknown> }).cacheByProject.set(1, cache);

    fetcher.markIssueClosed(1, 10);

    expect(cache.issues[0].state).toBe('closed');
    expect(cache.issues[1].state).toBe('open'); // unchanged
  });

  it('marks a nested child issue as closed', () => {
    const cache = {
      issues: [
        makeIssueNode({
          number: 1,
          state: 'open',
          children: [
            makeIssueNode({ number: 10, state: 'open' }),
          ],
        }),
      ],
      cachedAt: new Date().toISOString(),
    };
    (fetcher as unknown as { cacheByProject: Map<number, unknown> }).cacheByProject.set(1, cache);

    fetcher.markIssueClosed(1, 10);

    expect(cache.issues[0].children[0].state).toBe('closed');
    expect(cache.issues[0].state).toBe('open'); // parent unchanged
  });

  it('updates blockedBy references to the closed issue', () => {
    const cache = {
      issues: [
        makeIssueNode({ number: 10, state: 'open' }),
        makeIssueNode({
          number: 20,
          state: 'open',
          dependencies: {
            issueNumber: 20,
            blockedBy: [
              { number: 10, owner: 'owner', repo: 'repo', state: 'open' as const, title: 'Blocker' },
              { number: 30, owner: 'owner', repo: 'repo', state: 'open' as const, title: 'Other blocker' },
            ],
            resolved: false,
            openCount: 2,
          },
        }),
      ],
      cachedAt: new Date().toISOString(),
    };
    (fetcher as unknown as { cacheByProject: Map<number, unknown> }).cacheByProject.set(1, cache);

    fetcher.markIssueClosed(1, 10);

    const deps = cache.issues[1].dependencies!;
    expect(deps.blockedBy[0].state).toBe('closed');
    expect(deps.blockedBy[1].state).toBe('open'); // unchanged
    expect(deps.openCount).toBe(1);
    expect(deps.resolved).toBe(false);
  });

  it('sets resolved to true when the last blocker is closed', () => {
    const cache = {
      issues: [
        makeIssueNode({ number: 10, state: 'open' }),
        makeIssueNode({
          number: 20,
          state: 'open',
          dependencies: {
            issueNumber: 20,
            blockedBy: [
              { number: 10, owner: 'owner', repo: 'repo', state: 'open' as const, title: 'Blocker' },
            ],
            resolved: false,
            openCount: 1,
          },
        }),
      ],
      cachedAt: new Date().toISOString(),
    };
    (fetcher as unknown as { cacheByProject: Map<number, unknown> }).cacheByProject.set(1, cache);

    fetcher.markIssueClosed(1, 10);

    const deps = cache.issues[1].dependencies!;
    expect(deps.blockedBy[0].state).toBe('closed');
    expect(deps.openCount).toBe(0);
    expect(deps.resolved).toBe(true);
  });

  it('does not update cross-repo blockers with different owner/repo', () => {
    const cache = {
      issues: [
        makeIssueNode({
          number: 20,
          state: 'open',
          dependencies: {
            issueNumber: 20,
            blockedBy: [
              { number: 10, owner: 'other-owner', repo: 'other-repo', state: 'open' as const, title: 'Cross-repo blocker' },
            ],
            resolved: false,
            openCount: 1,
          },
        }),
      ],
      cachedAt: new Date().toISOString(),
    };
    (fetcher as unknown as { cacheByProject: Map<number, unknown> }).cacheByProject.set(1, cache);

    fetcher.markIssueClosed(1, 10);

    // Cross-repo blocker should not be updated
    const deps = cache.issues[0].dependencies!;
    expect(deps.blockedBy[0].state).toBe('open');
    expect(deps.openCount).toBe(1);
    expect(deps.resolved).toBe(false);
  });

  it('updates blockers without owner/repo (body-parsed same-repo)', () => {
    const cache = {
      issues: [
        makeIssueNode({
          number: 20,
          state: 'open',
          dependencies: {
            issueNumber: 20,
            blockedBy: [
              { number: 10, owner: '', repo: '', state: 'open' as const, title: 'Body-parsed blocker' },
            ],
            resolved: false,
            openCount: 1,
          },
        }),
      ],
      cachedAt: new Date().toISOString(),
    };
    (fetcher as unknown as { cacheByProject: Map<number, unknown> }).cacheByProject.set(1, cache);

    fetcher.markIssueClosed(1, 10);

    const deps = cache.issues[0].dependencies!;
    expect(deps.blockedBy[0].state).toBe('closed');
    expect(deps.openCount).toBe(0);
    expect(deps.resolved).toBe(true);
  });

  it('is a no-op if the project has no cache', () => {
    // No cache set for project 999 — should not throw
    expect(() => fetcher.markIssueClosed(999, 10)).not.toThrow();
  });

  it('is a no-op if the issue is not in the cache', () => {
    const cache = {
      issues: [
        makeIssueNode({ number: 10, state: 'open' }),
      ],
      cachedAt: new Date().toISOString(),
    };
    (fetcher as unknown as { cacheByProject: Map<number, unknown> }).cacheByProject.set(1, cache);

    // Issue 999 does not exist — should not throw, and issue 10 stays unchanged
    fetcher.markIssueClosed(1, 999);
    expect(cache.issues[0].state).toBe('open');
  });
});

// =============================================================================
// getDependenciesFromCache
// =============================================================================

describe('getDependenciesFromCache', () => {
  it('returns cached dependencies when issue has them', () => {
    const expectedDeps = {
      issueNumber: 10,
      blockedBy: [
        { number: 5, owner: 'owner', repo: 'repo', state: 'open' as const, title: 'Blocker' },
      ],
      resolved: false,
      openCount: 1,
    };

    const cache = {
      issues: [
        makeIssueNode({
          number: 10,
          state: 'open',
          dependencies: expectedDeps,
        }),
      ],
      cachedAt: new Date().toISOString(),
    };
    (fetcher as unknown as { cacheByProject: Map<number, unknown> }).cacheByProject.set(1, cache);

    const result = fetcher.getDependenciesFromCache(1, 10);
    expect(result).toEqual(expectedDeps);
  });

  it('returns empty dependency info when issue exists but has no dependencies', () => {
    const cache = {
      issues: [
        makeIssueNode({ number: 10, state: 'open' }),
      ],
      cachedAt: new Date().toISOString(),
    };
    (fetcher as unknown as { cacheByProject: Map<number, unknown> }).cacheByProject.set(1, cache);

    const result = fetcher.getDependenciesFromCache(1, 10);
    expect(result).toEqual({
      issueNumber: 10,
      blockedBy: [],
      resolved: true,
      openCount: 0,
    });
  });

  it('returns null when no cache exists for the project', () => {
    const result = fetcher.getDependenciesFromCache(999, 10);
    expect(result).toBeNull();
  });

  it('returns null when cache has no cachedAt (stale/partial)', () => {
    const cache = {
      issues: [
        makeIssueNode({ number: 10, state: 'open' }),
      ],
      cachedAt: null,
    };
    (fetcher as unknown as { cacheByProject: Map<number, unknown> }).cacheByProject.set(1, cache);

    const result = fetcher.getDependenciesFromCache(1, 10);
    expect(result).toBeNull();
  });

  it('returns null when the issue is not in the cache', () => {
    const cache = {
      issues: [
        makeIssueNode({ number: 10, state: 'open' }),
      ],
      cachedAt: new Date().toISOString(),
    };
    (fetcher as unknown as { cacheByProject: Map<number, unknown> }).cacheByProject.set(1, cache);

    const result = fetcher.getDependenciesFromCache(1, 999);
    expect(result).toBeNull();
  });

  it('finds issue in nested children', () => {
    const expectedDeps = {
      issueNumber: 20,
      blockedBy: [
        { number: 5, owner: 'owner', repo: 'repo', state: 'closed' as const, title: 'Resolved blocker' },
      ],
      resolved: true,
      openCount: 0,
    };

    const cache = {
      issues: [
        makeIssueNode({
          number: 1,
          state: 'open',
          children: [
            makeIssueNode({
              number: 20,
              state: 'open',
              dependencies: expectedDeps,
            }),
          ],
        }),
      ],
      cachedAt: new Date().toISOString(),
    };
    (fetcher as unknown as { cacheByProject: Map<number, unknown> }).cacheByProject.set(1, cache);

    const result = fetcher.getDependenciesFromCache(1, 20);
    expect(result).toEqual(expectedDeps);
  });
});
