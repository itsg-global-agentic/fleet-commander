// =============================================================================
// Fleet Commander -- Archived Project Dependency Fetch Tests (Bug #621)
// =============================================================================
// Tests that fetchDependenciesForIssue works correctly when the project has
// a non-active status (e.g. 'archived'). Previously, fetchDependenciesFromProvider
// called db.getProjects({ status: 'active' }) which would miss archived projects,
// causing a perpetual fail-closed for dependencies. The fix passes the project
// directly through the call chain from fetchDependenciesForIssue.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks -- must be declared before import
// ---------------------------------------------------------------------------

const archivedProject = {
  id: 1,
  name: 'test-repo',
  repoPath: '/path/to/repo',
  githubRepo: 'owner/repo',
  status: 'archived',
  hooksInstalled: false,
  maxActiveTeams: 5,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

const mockDb = {
  getProject: vi.fn().mockReturnValue(archivedProject),
  getProjects: vi.fn().mockReturnValue([]),  // Empty: archived project not in active list
  getIssueSources: vi.fn().mockReturnValue([]),
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

// Mock child_process — exec callback must be invoked for resolveIssueStates to resolve
const mockExec = vi.fn((_cmd: string, _opts: unknown, cb: Function) => {
  // Return a plausible gh CLI response for resolveIssueStates
  cb(null, { stdout: 'open\nBlocker issue', stderr: '' });
});
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
import { GitHubIssueProvider } from '../../src/server/providers/github-issue-provider.js';
import { IssueFetcher } from '../../src/server/services/issue-fetcher.js';
import * as providerRegistry from '../../src/server/providers/index.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fetchDependenciesForIssue with archived project (Bug #621)', () => {
  let fetcher: IssueFetcher;
  let provider: GitHubIssueProvider;
  let getProviderSpy: ReturnType<typeof vi.spyOn>;
  let fetchSingleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockDb.getProject.mockReturnValue(archivedProject);
    mockDb.getProjects.mockReturnValue([]);
    mockDb.getIssueSources.mockReturnValue([]);

    provider = new GitHubIssueProvider();
    getProviderSpy = vi.spyOn(providerRegistry, 'getIssueProvider').mockReturnValue(provider);

    // Mock the provider's fetchSingleIssueDeps to return dependency data
    // Use body: null to avoid triggering resolveIssueStates for the simple cases
    fetchSingleSpy = vi.spyOn(provider, 'fetchSingleIssueDeps').mockResolvedValue({
      body: null,
      blockedBy: {
        nodes: [{
          number: 10,
          title: 'Blocker issue',
          state: 'OPEN',
          repository: { owner: { login: 'owner' }, name: 'repo' },
        }],
      },
      trackedInIssues: { nodes: [] },
    });

    fetcher = new IssueFetcher();
  });

  it('should successfully fetch dependencies for an archived project', async () => {
    const result = await fetcher.fetchDependenciesForIssue(1, 42);

    // Critical: result should NOT be null. Before the fix, this returned null
    // because fetchDependenciesFromProvider called getProjects({ status: 'active' })
    // which returned an empty array (archived project not included).
    expect(result).not.toBeNull();
    expect(result!.blockedBy).toHaveLength(1);
    expect(result!.blockedBy[0].number).toBe(10);
    expect(result!.resolved).toBe(false);
    expect(result!.openCount).toBe(1);

    // Verify the project was looked up by ID (no status filter)
    expect(mockDb.getProject).toHaveBeenCalledWith(1);
    // Verify fetchSingleIssueDeps was called
    expect(fetchSingleSpy).toHaveBeenCalledWith('owner', 'repo', 42);
  });

  it('should pass project with status archived to the provider', async () => {
    await fetcher.fetchDependenciesForIssue(1, 42);

    // getIssueProvider should have been called with the archived project
    expect(getProviderSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, status: 'archived' })
    );
  });

  it('should handle body-based dependencies with resolveIssueStates for archived project', async () => {
    // Use body text that triggers parseDependenciesFromBody + resolveIssueStates
    fetchSingleSpy.mockResolvedValue({
      body: 'blocked by #20',
      blockedBy: { nodes: [] },
      trackedInIssues: { nodes: [] },
    });

    const result = await fetcher.fetchDependenciesForIssue(1, 42);

    // Should succeed even with body parsing + resolveIssueStates
    expect(result).not.toBeNull();
    expect(result!.blockedBy).toHaveLength(1);
    expect(result!.blockedBy[0].number).toBe(20);
  });

  it('should return null when project does not exist at all', async () => {
    mockDb.getProject.mockReturnValue(undefined);

    const result = await fetcher.fetchDependenciesForIssue(999, 42);

    expect(result).toBeNull();
    expect(fetchSingleSpy).not.toHaveBeenCalled();
  });

  it('should return null when archived project has no githubRepo and no issue sources', async () => {
    mockDb.getProject.mockReturnValue({
      ...archivedProject,
      githubRepo: null,
    });

    const result = await fetcher.fetchDependenciesForIssue(1, 42);

    expect(result).toBeNull();
  });
});
