// =============================================================================
// Fleet Commander -- Issue Fetcher blockedBy Recovery Tests
// =============================================================================
// Tests for:
//   - runSingleIssueDepsQuery: non-field GraphQL errors do not discard data
//   - runSingleIssueDepsQuery: field-not-found errors correctly trigger fallback
//   - runGraphQLQuery: non-field errors do not discard batch query data
//   - blockedBySupported recovery after retry countdown expires
//   - mapGraphQLNode: null repository in blockedBy nodes is safely skipped
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks -- must be declared before import
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

// Mock child_process (exec used by resolveIssueStates, spawn used by runGHGraphQL)
const mockExec = vi.fn();
vi.mock('child_process', () => ({
  exec: (...args: unknown[]) => mockExec(...args),
  spawn: vi.fn(),
}));

// Mock util.promisify so that execAsync uses our mockExec
vi.mock('util', () => ({
  promisify: (fn: unknown) => {
    return (...args: unknown[]) => {
      return new Promise((resolve, reject) => {
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

/** Helper to create a minimal batch GraphQL response */
function makeGraphQLResponse(nodes: Array<{
  number: number;
  title: string;
  state?: string;
  url?: string;
  blockedBy?: { nodes?: Array<{
    number: number;
    title: string;
    state: string;
    repository: { owner: { login: string }; name: string } | null;
  }> };
}>, errors?: Array<{ message: string }>) {
  const response: Record<string, unknown> = {
    data: {
      repository: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: nodes.map((n) => ({
            number: n.number,
            title: n.title,
            state: n.state ?? 'OPEN',
            url: n.url ?? `https://github.com/owner/repo/issues/${n.number}`,
            labels: { nodes: [] },
            parent: null,
            subIssuesSummary: undefined,
            closedByPullRequestsReferences: undefined,
            blockedBy: n.blockedBy ?? undefined,
            issueDependenciesSummary: undefined,
          })),
        },
      },
    },
  };
  if (errors) {
    response.errors = errors;
  }
  return response;
}

/** Helper to create a single-issue deps GraphQL response */
function makeSingleIssueDepsResponse(
  issue: {
    body: string | null;
    blockedBy?: { nodes: Array<{
      number: number;
      title: string;
      state: string;
      repository: { owner: { login: string }; name: string };
    }> };
    trackedInIssues?: { nodes: Array<{
      number: number;
      title: string;
      state: string;
      repository: { owner: { login: string }; name: string };
    }> };
  } | null,
  errors?: Array<{ message: string }>,
) {
  const response: Record<string, unknown> = {
    data: {
      repository: {
        issue,
      },
    },
  };
  if (errors) {
    response.errors = errors;
  }
  return response;
}

// ---------------------------------------------------------------------------
// Tests: runSingleIssueDepsQuery error handling
// ---------------------------------------------------------------------------

describe('runSingleIssueDepsQuery error handling', () => {
  let fetcher: IssueFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new IssueFetcher();
  });

  it('should not reject data when response has non-field GraphQL errors', async () => {
    // Simulate a GraphQL response with data AND a non-field error (e.g. rate limit warning)
    const mockResponse = makeSingleIssueDepsResponse(
      {
        body: null,
        blockedBy: {
          nodes: [{
            number: 10,
            title: 'Blocker',
            state: 'OPEN',
            repository: { owner: { login: 'owner' }, name: 'repo' },
          }],
        },
        trackedInIssues: { nodes: [] },
      },
      [{ message: 'API rate limit exceeded' }],
    );

    // Mock runGHGraphQL to return our response
    const ghSpy = vi.spyOn(fetcher as any, 'runGHGraphQL')
      .mockResolvedValue(JSON.stringify(mockResponse));

    // Call the private method directly
    const result = await (fetcher as any).runSingleIssueDepsQuery(
      'query { ... }', 'owner', 'repo', 42,
    );

    // Data should be returned despite the non-field error
    expect(result).not.toBeNull();
    expect(result.blockedBy.nodes).toHaveLength(1);
    expect(result.blockedBy.nodes[0].number).toBe(10);

    ghSpy.mockRestore();
  });

  it('should reject data when response has field-not-found errors', async () => {
    const mockResponse = makeSingleIssueDepsResponse(
      null,
      [{ message: "Field 'blockedBy' doesn't exist on type 'Issue'" }],
    );

    const ghSpy = vi.spyOn(fetcher as any, 'runGHGraphQL')
      .mockResolvedValue(JSON.stringify(mockResponse));

    const result = await (fetcher as any).runSingleIssueDepsQuery(
      'query { ... }', 'owner', 'repo', 42,
    );

    // Should return null on field-not-found error
    expect(result).toBeNull();

    ghSpy.mockRestore();
  });

  it('should reject data when response has issueDependenciesSummary field error', async () => {
    const mockResponse = makeSingleIssueDepsResponse(
      null,
      [{ message: "Field 'issueDependenciesSummary' doesn't exist on type 'Issue'" }],
    );

    const ghSpy = vi.spyOn(fetcher as any, 'runGHGraphQL')
      .mockResolvedValue(JSON.stringify(mockResponse));

    const result = await (fetcher as any).runSingleIssueDepsQuery(
      'query { ... }', 'owner', 'repo', 42,
    );

    expect(result).toBeNull();

    ghSpy.mockRestore();
  });

  it('should not reject data when error message contains "blockedBy" but is not a field error', async () => {
    // An error message that mentions "blockedBy" but is NOT a field-not-found error
    const mockResponse = makeSingleIssueDepsResponse(
      {
        body: null,
        blockedBy: { nodes: [] },
        trackedInIssues: { nodes: [] },
      },
      [{ message: 'The blockedBy connection is temporarily unavailable' }],
    );

    const ghSpy = vi.spyOn(fetcher as any, 'runGHGraphQL')
      .mockResolvedValue(JSON.stringify(mockResponse));

    const result = await (fetcher as any).runSingleIssueDepsQuery(
      'query { ... }', 'owner', 'repo', 42,
    );

    // Should still return data because this is not a field-not-found error
    expect(result).not.toBeNull();

    ghSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Tests: runGraphQLQuery (batch) error handling
// ---------------------------------------------------------------------------

describe('runGraphQLQuery batch error handling', () => {
  let fetcher: IssueFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new IssueFetcher();
  });

  it('should not reject data when batch response has non-field GraphQL errors', async () => {
    const mockResponse = makeGraphQLResponse(
      [{ number: 1, title: 'Issue 1' }],
      [{ message: 'API rate limit warning: approaching limit' }],
    );

    const ghSpy = vi.spyOn(fetcher as any, 'runGHGraphQL')
      .mockResolvedValue(JSON.stringify(mockResponse));

    const result = await (fetcher as any).runGraphQLQuery(
      'query { ... }', 'owner', 'repo', null,
    );

    // Data should be returned despite the non-field error
    expect(result).not.toBeNull();
    expect(result.data.repository.issues.nodes).toHaveLength(1);

    ghSpy.mockRestore();
  });

  it('should reject data when batch response has field-not-found errors', async () => {
    const mockResponse = {
      data: null,
      errors: [{ message: "Field 'blockedBy' doesn't exist on type 'Issue'" }],
    };

    const ghSpy = vi.spyOn(fetcher as any, 'runGHGraphQL')
      .mockResolvedValue(JSON.stringify(mockResponse));

    const result = await (fetcher as any).runGraphQLQuery(
      'query { ... }', 'owner', 'repo', null,
    );

    expect(result).toBeNull();

    ghSpy.mockRestore();
  });

  it('should not reject batch data when error mentions blockedBy without field error pattern', async () => {
    // This verifies the narrowed regex: a message containing "blockedBy" that is
    // NOT a field-not-found error should not cause data to be discarded
    const mockResponse = makeGraphQLResponse(
      [{ number: 1, title: 'Issue 1' }],
      [{ message: 'Deprecation warning: blockedBy will be renamed in v2' }],
    );

    const ghSpy = vi.spyOn(fetcher as any, 'runGHGraphQL')
      .mockResolvedValue(JSON.stringify(mockResponse));

    const result = await (fetcher as any).runGraphQLQuery(
      'query { ... }', 'owner', 'repo', null,
    );

    // Data should be returned because this is NOT a field-not-found error
    expect(result).not.toBeNull();

    ghSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Tests: blockedBySupported recovery mechanism
// ---------------------------------------------------------------------------

describe('blockedBySupported recovery mechanism', () => {
  let fetcher: IssueFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new IssueFetcher();
    mockDb.getProjects.mockReturnValue([]);
  });

  it('should set blockedByRetryCountdown to 5 when blockedBySupported is disabled', async () => {
    // Start with blockedBySupported = true, then trigger a field error
    const ghSpy = vi.spyOn(fetcher as any, 'runGHGraphQL')
      .mockResolvedValue(JSON.stringify({
        data: null,
        errors: [{ message: "Field 'blockedBy' doesn't exist on type 'Issue'" }],
      }));

    // Call executeGraphQL to trigger the downgrade
    await (fetcher as any).executeGraphQL('owner', 'repo', null);

    expect((fetcher as any).blockedBySupported).toBe(false);
    expect((fetcher as any).blockedByRetryCountdown).toBe(5);

    ghSpy.mockRestore();
  });

  it('should recover blockedBySupported after retry countdown expires', async () => {
    // Manually set the state to "disabled with countdown"
    (fetcher as any).blockedBySupported = false;
    (fetcher as any).blockedByRetryCountdown = 1; // will decrement to 0 on next call

    // fetchAllProjects with empty project list
    mockDb.getProjects.mockReturnValue([]);
    await fetcher.fetchAllProjects();

    // After the countdown reaches 0, blockedBySupported should be re-enabled
    expect((fetcher as any).blockedBySupported).toBe(true);
  });

  it('should not recover blockedBySupported before countdown expires', async () => {
    (fetcher as any).blockedBySupported = false;
    (fetcher as any).blockedByRetryCountdown = 3;

    mockDb.getProjects.mockReturnValue([]);
    await fetcher.fetchAllProjects();

    // countdown: 3 -> 2, not yet 0
    expect((fetcher as any).blockedBySupported).toBe(false);
    expect((fetcher as any).blockedByRetryCountdown).toBe(2);
  });

  it('should count down across multiple fetchAllProjects calls', async () => {
    (fetcher as any).blockedBySupported = false;
    (fetcher as any).blockedByRetryCountdown = 3;

    mockDb.getProjects.mockReturnValue([]);

    // Call 1: 3 -> 2
    await fetcher.fetchAllProjects();
    expect((fetcher as any).blockedBySupported).toBe(false);
    expect((fetcher as any).blockedByRetryCountdown).toBe(2);

    // Call 2: 2 -> 1
    await fetcher.fetchAllProjects();
    expect((fetcher as any).blockedBySupported).toBe(false);
    expect((fetcher as any).blockedByRetryCountdown).toBe(1);

    // Call 3: 1 -> 0, recovery
    await fetcher.fetchAllProjects();
    expect((fetcher as any).blockedBySupported).toBe(true);
  });

  it('should reset blockedByRetryCountdown on reset()', () => {
    (fetcher as any).blockedBySupported = false;
    (fetcher as any).blockedByRetryCountdown = 3;

    fetcher.reset();

    expect((fetcher as any).blockedBySupported).toBe(true);
    expect((fetcher as any).blockedByRetryCountdown).toBe(0);
  });

  it('should not attempt recovery when blockedBySupported is already true', async () => {
    (fetcher as any).blockedBySupported = true;
    (fetcher as any).blockedByRetryCountdown = 0;

    mockDb.getProjects.mockReturnValue([]);
    await fetcher.fetchAllProjects();

    // Should remain true, countdown unchanged
    expect((fetcher as any).blockedBySupported).toBe(true);
    expect((fetcher as any).blockedByRetryCountdown).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: mapGraphQLNode null repository handling
// ---------------------------------------------------------------------------

describe('mapGraphQLNode null repository handling', () => {
  let fetcher: IssueFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new IssueFetcher();
  });

  it('should skip blockedBy nodes where repository is null', () => {
    const node = {
      number: 42,
      title: 'Test issue',
      state: 'OPEN',
      url: 'https://github.com/owner/repo/issues/42',
      labels: { nodes: [] },
      blockedBy: {
        nodes: [
          {
            number: 10,
            title: 'Valid dep',
            state: 'OPEN',
            repository: { owner: { login: 'owner' }, name: 'repo' },
          },
          {
            number: 20,
            title: 'Null repo dep',
            state: 'OPEN',
            repository: null as unknown as { owner: { login: string }; name: string },
          },
        ],
      },
    };

    const result = (fetcher as any).mapGraphQLNode(node);

    // Should only have 1 dependency (the one with valid repository)
    expect(result.dependencies).toBeDefined();
    expect(result.dependencies.blockedBy).toHaveLength(1);
    expect(result.dependencies.blockedBy[0].number).toBe(10);
  });

  it('should handle all blockedBy nodes having null repository', () => {
    const node = {
      number: 42,
      title: 'Test issue',
      state: 'OPEN',
      url: 'https://github.com/owner/repo/issues/42',
      labels: { nodes: [] },
      blockedBy: {
        nodes: [
          {
            number: 20,
            title: 'Null repo dep',
            state: 'OPEN',
            repository: null as unknown as { owner: { login: string }; name: string },
          },
        ],
      },
    };

    const result = (fetcher as any).mapGraphQLNode(node);

    // No valid dependencies -> dependencies should not be set
    expect(result.dependencies).toBeUndefined();
  });
});
