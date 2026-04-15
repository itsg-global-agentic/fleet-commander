// =============================================================================
// Fleet Commander — Issue #691 Fix B: epic pre-flight check
// =============================================================================
// Verifies that launchTeam skips spawning a team when the target issue is a
// GitHub epic whose sub-issues are already all closed (auto-closes the epic
// and returns skipped: true). Also verifies epics with open sub-issues still
// launch normally.
// =============================================================================

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// ---------------------------------------------------------------------------
// Mock infrastructure — must be declared BEFORE importing TeamService
// ---------------------------------------------------------------------------

const mockLaunch = vi.fn().mockResolvedValue({ id: 1, status: 'launching' });
const mockQueueTeamWithBlockers = vi.fn().mockResolvedValue({ id: 1, status: 'queued' });

vi.mock('../../src/server/services/team-manager.js', () => ({
  getTeamManager: () => ({
    launch: mockLaunch,
    queueTeamWithBlockers: mockQueueTeamWithBlockers,
    sendMessage: vi.fn(),
    getOutput: vi.fn().mockReturnValue([]),
    getParsedEvents: vi.fn().mockReturnValue([]),
  }),
}));

// Dependency check: pretend all deps are resolved so we exercise the
// epic pre-flight path without deps getting in the way.
const mockFetchDependenciesForIssue = vi.fn().mockResolvedValue({
  issueNumber: 0, blockedBy: [], resolved: true, openCount: 0,
});

vi.mock('../../src/server/services/issue-fetcher.js', () => ({
  getIssueFetcher: () => ({
    fetchDependenciesForIssue: mockFetchDependenciesForIssue,
    fetch: vi.fn().mockResolvedValue([]),
    getIssues: vi.fn().mockResolvedValue([]),
    getIssuesByProject: vi.fn().mockReturnValue([]),
    getCachedAt: vi.fn().mockReturnValue(null),
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

vi.mock('../../src/server/services/github-poller.js', () => ({
  githubPoller: {
    getRecentPRs: vi.fn().mockReturnValue([]),
    trackBlockedIssue: vi.fn(),
  },
}));

vi.mock('../../src/server/services/project-service.js', () => ({
  getProjectService: () => ({
    getProjectReadiness: () => ({ ready: true, errors: [] }),
  }),
}));

// exec-gh is the key mock for the epic pre-flight itself.
const mockExecGHAsync = vi.fn();

vi.mock('../../src/server/utils/exec-gh.js', () => ({
  execGHAsync: (...args: unknown[]) => mockExecGHAsync(...args),
  isValidGithubRepo: (repo: string) => /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo),
  isValidBranchName: (branch: string) => /^[a-zA-Z0-9._/\-]+$/.test(branch),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

const { getDatabase, closeDatabase } = await import('../../src/server/db.js');
const { TeamService } = await import('../../src/server/services/team-service.js');
const { sseBroker } = await import('../../src/server/services/sse-broker.js');

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let dbPath: string;
let service: InstanceType<typeof TeamService>;
let projectId: number;

function freshDb(): void {
  closeDatabase();
  dbPath = path.join(
    os.tmpdir(),
    `fleet-691-epic-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  process.env['FLEET_DB_PATH'] = dbPath;
  getDatabase(dbPath);

  const db = getDatabase();
  const project = db.insertProject({
    name: 'test-project',
    repoPath: `/tmp/test-${Date.now()}`,
    githubRepo: 'owner/test-repo',
  });
  projectId = project.id;

  service = new TeamService();
}

beforeEach(() => {
  vi.clearAllMocks();
  freshDb();
});

afterAll(() => {
  sseBroker.stop();
  closeDatabase();
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    try {
      if (f && fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      // best effort
    }
  }
  delete process.env['FLEET_DB_PATH'];
});

// ---------------------------------------------------------------------------
// Helpers for building gh graphql responses
// ---------------------------------------------------------------------------

function ghIssueResponse(
  state: 'OPEN' | 'CLOSED',
  subs?: { total: number; completed: number },
): string {
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          state,
          subIssuesSummary: subs ?? { total: 0, completed: 0 },
        },
      },
    },
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('Fix B: epic pre-flight check', () => {
  it('skips launch and auto-closes epic when all sub-issues are already closed', async () => {
    // 1st call is the GraphQL pre-flight (returns all-subs-closed).
    // 2nd call is the `gh issue close` command.
    mockExecGHAsync
      .mockResolvedValueOnce(ghIssueResponse('OPEN', { total: 5, completed: 5 }))
      .mockResolvedValueOnce(''); // gh issue close success

    const result = await service.launchTeam({
      projectId,
      issueNumber: 999,
    }) as { skipped?: boolean; reason?: string; issueNumber?: number; subIssueCount?: number };

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('all_subs_closed');
    expect(result.issueNumber).toBe(999);
    expect(result.subIssueCount).toBe(5);

    // Team manager should NOT have been called.
    expect(mockLaunch).not.toHaveBeenCalled();

    // The second exec-gh call should be the auto-close.
    expect(mockExecGHAsync).toHaveBeenCalledTimes(2);
    const closeCommand = mockExecGHAsync.mock.calls[1][0] as string;
    expect(closeCommand).toContain('gh issue close 999');
    expect(closeCommand).toContain('--repo owner/test-repo');

    // No team row should have been inserted for the skipped launch.
    const teams = getDatabase().getTeams();
    expect(teams).toHaveLength(0);
  });

  it('skips launch idempotently when the issue is already closed', async () => {
    mockExecGHAsync.mockResolvedValueOnce(
      ghIssueResponse('CLOSED', { total: 3, completed: 3 }),
    );

    const result = await service.launchTeam({
      projectId,
      issueNumber: 888,
    }) as { skipped?: boolean; reason?: string };

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('already_closed');

    // No second call — we don't re-close an already-closed issue.
    expect(mockExecGHAsync).toHaveBeenCalledTimes(1);
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it('launches normally when the epic has at least one open sub-issue', async () => {
    mockExecGHAsync.mockResolvedValueOnce(
      ghIssueResponse('OPEN', { total: 5, completed: 4 }),
    );

    const result = await service.launchTeam({
      projectId,
      issueNumber: 777,
    });

    expect(result).toEqual({ id: 1, status: 'launching' });
    expect(mockLaunch).toHaveBeenCalled();
  });

  it('launches normally for a plain issue with no sub-issues', async () => {
    mockExecGHAsync.mockResolvedValueOnce(
      ghIssueResponse('OPEN', { total: 0, completed: 0 }),
    );

    const result = await service.launchTeam({
      projectId,
      issueNumber: 555,
    });

    expect(result).toEqual({ id: 1, status: 'launching' });
    expect(mockLaunch).toHaveBeenCalled();
  });

  it('falls through to launch when the gh pre-flight call fails', async () => {
    // Downgrade path: execGHAsync returns null on failure.
    mockExecGHAsync.mockResolvedValueOnce(null);

    const result = await service.launchTeam({
      projectId,
      issueNumber: 444,
    });

    expect(result).toEqual({ id: 1, status: 'launching' });
    expect(mockLaunch).toHaveBeenCalled();
  });

  it('bypasses pre-flight when force=true', async () => {
    // No gh call should happen at all.
    const result = await service.launchTeam({
      projectId,
      issueNumber: 333,
      force: true,
    });

    expect(result).toEqual({ id: 1, status: 'launching' });
    expect(mockExecGHAsync).not.toHaveBeenCalled();
    expect(mockLaunch).toHaveBeenCalled();
  });
});
