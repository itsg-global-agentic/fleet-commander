// =============================================================================
// Fleet Commander — GitHub Poller Tests
// =============================================================================
// Tests for the GitHubPoller service: PR state transitions, CI status
// derivation, CI failure counting, merge detection, poll lifecycle, and
// dependency resolution tracking.
//
// After issue #385, all gh/git CLI calls are async (via exec-gh.ts).
// Tests mock the shared async utilities instead of child_process.execSync.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Team, Project } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Mocks — must be declared before import
// ---------------------------------------------------------------------------

const mockDb = {
  getProjects: vi.fn().mockReturnValue([]),
  getActiveTeams: vi.fn().mockReturnValue([]),
  getTeam: vi.fn(),
  getTeams: vi.fn().mockReturnValue([]),
  getPullRequest: vi.fn(),
  updateTeam: vi.fn(),
  updateTeamSilent: vi.fn(),
  updatePullRequest: vi.fn(),
  insertPullRequest: vi.fn(),
  insertTransition: vi.fn(),
  getQueuedBlockedTeams: vi.fn().mockReturnValue([]),
};

vi.mock('../../src/server/db.js', () => ({
  getDatabase: () => mockDb,
}));

vi.mock('../../src/server/config.js', () => ({
  default: {
    githubPollIntervalMs: 30000,
    maxUniqueCiFailures: 3,
    mergeShutdownGraceMs: 120000,
    worktreeDir: '.claude/worktrees',
  },
}));

const mockSseBroker = {
  broadcast: vi.fn(),
};
vi.mock('../../src/server/services/sse-broker.js', () => ({
  sseBroker: mockSseBroker,
}));

vi.mock('../../src/server/utils/resolve-message.js', () => ({
  resolveMessage: vi.fn().mockReturnValue(null),
}));

const mockManager = {
  sendMessage: vi.fn(),
  gracefulShutdown: vi.fn(),
  processQueue: vi.fn().mockResolvedValue(undefined),
};
vi.mock('../../src/server/services/team-manager.js', () => ({
  getTeamManager: () => mockManager,
}));

const mockFetcher = {
  fetchDependenciesForIssue: vi.fn().mockResolvedValue(null),
  getDependenciesFromCache: vi.fn().mockReturnValue(null),
  markIssueClosed: vi.fn(),
};
vi.mock('../../src/server/services/issue-fetcher.js', () => ({
  getIssueFetcher: () => mockFetcher,
}));

// Mock the shared async exec utilities (replaces the old child_process mock)
const mockExecGHAsync = vi.fn().mockResolvedValue(null);
const mockExecGitAsync = vi.fn().mockResolvedValue(null);

// Import the real validators — they are pure functions with no side effects
const { isValidGithubRepo, isValidBranchName } = await import(
  '../../src/server/utils/exec-gh.js'
);

vi.mock('../../src/server/utils/exec-gh.js', () => ({
  execGHAsync: (...args: unknown[]) => mockExecGHAsync(...args),
  execGitAsync: (...args: unknown[]) => mockExecGitAsync(...args),
  isValidGithubRepo: (repo: string) => /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo),
  isValidBranchName: (branch: string) => /^[a-zA-Z0-9._/\-]+$/.test(branch),
}));

// Import after mocks
const { githubPoller } = await import(
  '../../src/server/services/github-poller.js'
);
const { resolveMessage: mockResolveMessage } = await import(
  '../../src/server/utils/resolve-message.js'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTeam(overrides?: Partial<Team>): Partial<Team> {
  return {
    id: 1,
    issueNumber: 10,
    issueTitle: 'Test issue',
    projectId: 1,
    status: 'running',
    phase: 'implementing',
    pid: 12345,
    sessionId: 'sess-1',
    worktreeName: 'proj-10',
    branchName: 'feat/10-test',
    prNumber: 42,
    customPrompt: null,
    launchedAt: new Date().toISOString(),
    stoppedAt: null,
    lastEventAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeProject(overrides?: Partial<Project>): Partial<Project> {
  return {
    id: 1,
    name: 'my-project',
    repoPath: '/tmp/repo',
    githubRepo: 'owner/repo',
    status: 'active',
    hooksInstalled: true,
    maxActiveTeams: 2,
    promptFile: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeGHPRViewResult(overrides?: Record<string, unknown>) {
  return JSON.stringify({
    number: 42,
    title: 'Test PR',
    state: 'OPEN',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [],
    autoMergeRequest: null,
    headRefName: 'feat/10-test',
    baseRefName: 'main',
    mergedAt: null,
    reviewDecision: null,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mockDb.getProjects.mockReturnValue([]);
  mockDb.getActiveTeams.mockReturnValue([]);
});

afterEach(() => {
  githubPoller.stop();
  vi.useRealTimers();
});

// =============================================================================
// PR state transitions
// =============================================================================

describe('PR state transitions', () => {
  it('detects open -> merged transition and marks team done', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42, status: 'running' });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'passing',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });
    mockDb.getTeam.mockReturnValue({ ...team, status: 'running' });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        state: 'CLOSED',
        mergedAt: '2025-01-01T00:00:00Z',
      }),
    );

    await githubPoller.poll();

    // Team should be marked done
    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        toStatus: 'done',
        trigger: 'poller',
        reason: expect.stringContaining('merged'),
      }),
    );
    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        status: 'done',
        phase: 'done',
      }),
    );

    // Graceful shutdown should be initiated
    expect(mockManager.gracefulShutdown).toHaveBeenCalledWith(1, 42, 120000);

    // Queue should be processed immediately to advance queued teams
    expect(mockManager.processQueue).toHaveBeenCalledWith(1);
  });

  it('does not call gracefulShutdown again when team is already done', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42, status: 'done' });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'merged',
      ciStatus: 'passing',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });
    // Team is already done
    mockDb.getTeam.mockReturnValue({ ...team, status: 'done' });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        state: 'CLOSED',
        mergedAt: '2025-01-01T00:00:00Z',
      }),
    );

    await githubPoller.poll();

    // gracefulShutdown should NOT be called since team is already done
    expect(mockManager.gracefulShutdown).not.toHaveBeenCalled();
    // processQueue should NOT be called since team is already done
    expect(mockManager.processQueue).not.toHaveBeenCalled();
    // mergedAt should NOT be written again either
    expect(mockDb.updatePullRequest).not.toHaveBeenCalledWith(
      42,
      expect.objectContaining({ mergedAt: expect.any(String) }),
    );
  });

  it('calls processQueue immediately on PR merge to advance queued teams', async () => {
    const project = makeProject({ id: 7 });
    const team = makeTeam({ id: 5, prNumber: 99, status: 'running', projectId: 7 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 99,
      state: 'open',
      ciStatus: 'passing',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });
    mockDb.getTeam.mockReturnValue({ ...team, status: 'running' });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        state: 'CLOSED',
        mergedAt: '2025-06-15T12:00:00Z',
      }),
    );

    await githubPoller.poll();

    // processQueue should be called with the team's projectId immediately
    expect(mockManager.processQueue).toHaveBeenCalledWith(7);
    // And it should be called exactly once (not duplicated)
    expect(mockManager.processQueue).toHaveBeenCalledTimes(1);
  });

  it('detects new PR state (no existing PR record) and inserts it', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue(undefined);

    mockExecGHAsync.mockResolvedValue(makeGHPRViewResult());

    await githubPoller.poll();

    expect(mockDb.insertPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        prNumber: 42,
        teamId: 1,
        state: 'open',
      }),
    );
    expect(mockSseBroker.broadcast).toHaveBeenCalledWith(
      'pr_updated',
      expect.objectContaining({ pr_number: 42 }),
      1,
    );
  });

  it('does not update when nothing changed', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'none',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });

    mockExecGHAsync.mockResolvedValue(makeGHPRViewResult());

    await githubPoller.poll();

    expect(mockDb.updatePullRequest).not.toHaveBeenCalled();
    expect(mockSseBroker.broadcast).not.toHaveBeenCalled();
  });
});

// =============================================================================
// CI status derivation
// =============================================================================

describe('CI status derivation', () => {
  it('derives passing when all checks succeed', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'pending',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        statusCheckRollup: [
          { name: 'build', conclusion: 'SUCCESS', status: 'COMPLETED' },
          { name: 'lint', conclusion: 'SUCCESS', status: 'COMPLETED' },
        ],
      }),
    );

    await githubPoller.poll();

    expect(mockDb.updatePullRequest).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ ciStatus: 'passing' }),
    );
  });

  it('derives failing when any check has FAILURE conclusion', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'pending',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        statusCheckRollup: [
          { name: 'build', conclusion: 'SUCCESS', status: 'COMPLETED' },
          { name: 'test', conclusion: 'FAILURE', status: 'COMPLETED' },
        ],
      }),
    );

    await githubPoller.poll();

    expect(mockDb.updatePullRequest).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ ciStatus: 'failing' }),
    );
  });

  it('derives failing for CANCELLED conclusion', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'pending',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        statusCheckRollup: [
          { name: 'deploy', conclusion: 'CANCELLED', status: 'COMPLETED' },
        ],
      }),
    );

    await githubPoller.poll();

    expect(mockDb.updatePullRequest).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ ciStatus: 'failing' }),
    );
  });

  it('derives pending when checks are in progress', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'none',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        statusCheckRollup: [
          { name: 'build', conclusion: null, status: 'IN_PROGRESS' },
        ],
      }),
    );

    await githubPoller.poll();

    expect(mockDb.updatePullRequest).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ ciStatus: 'pending' }),
    );
  });

  it('derives none when no checks exist', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'passing',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({ statusCheckRollup: [] }),
    );

    await githubPoller.poll();

    expect(mockDb.updatePullRequest).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ ciStatus: 'none' }),
    );
  });

  it('counts NEUTRAL and SKIPPED as passing', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'pending',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        statusCheckRollup: [
          { name: 'optional', conclusion: 'NEUTRAL' },
          { name: 'skipped', conclusion: 'SKIPPED' },
        ],
      }),
    );

    await githubPoller.poll();

    expect(mockDb.updatePullRequest).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ ciStatus: 'passing' }),
    );
  });
});

// =============================================================================
// CI failure counting
// =============================================================================

describe('CI failure counting', () => {
  it('counts unique CI failures and tracks cumulative max', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'pending',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 1,
    });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        statusCheckRollup: [
          { name: 'build', conclusion: 'FAILURE' },
          { name: 'test', conclusion: 'FAILURE' },
          { name: 'lint', conclusion: 'SUCCESS' },
        ],
      }),
    );

    await githubPoller.poll();

    expect(mockDb.updatePullRequest).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ ciFailCount: 2 }),
    );
  });

  it('resets ciFailCount to 0 when CI is green', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'failing',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 2,
    });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        statusCheckRollup: [
          { name: 'build', conclusion: 'SUCCESS' },
          { name: 'test', conclusion: 'SUCCESS' },
        ],
      }),
    );

    await githubPoller.poll();

    expect(mockDb.updatePullRequest).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ ciFailCount: 0 }),
    );
  });

  it('marks team stuck+blocked when CI failures exceed threshold', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42, status: 'running' });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'pending',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 2,
    });
    mockDb.getTeam.mockReturnValue({ ...team, phase: 'implementing' });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        statusCheckRollup: [
          { name: 'build', conclusion: 'FAILURE' },
          { name: 'test', conclusion: 'FAILURE' },
          { name: 'lint', conclusion: 'FAILURE' },
        ],
      }),
    );

    await githubPoller.poll();

    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        toStatus: 'stuck',
        trigger: 'poller',
        reason: expect.stringContaining('CI blocked'),
      }),
    );
    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ phase: 'blocked', status: 'stuck' }),
    );
  });
});

// =============================================================================
// PR detection by branch
// =============================================================================

describe('PR detection by branch', () => {
  it('detects PR for a team without prNumber', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: null, branchName: 'feat/10-test', phase: 'implementing' });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getTeam.mockReturnValue(team);

    // detectWorktreeBranch uses execGitAsync
    mockExecGitAsync.mockResolvedValue('feat/10-test');
    // detectPR uses execGHAsync
    mockExecGHAsync.mockResolvedValue(JSON.stringify([{ number: 55 }]));

    await githubPoller.poll();

    // detectPR now also advances phase to 'pr' when the current phase allows it
    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(1, { prNumber: 55, phase: 'pr' });
    expect(mockSseBroker.broadcast).toHaveBeenCalledWith(
      'team_status_changed',
      expect.objectContaining({ team_id: 1, phase: 'pr', previous_phase: 'implementing' }),
      1,
    );
  });

  it('does nothing when no PR found for branch', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: null, branchName: 'feat/10-test' });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);

    mockExecGitAsync.mockResolvedValue('feat/10-test');
    mockExecGHAsync.mockResolvedValue(JSON.stringify([]));

    await githubPoller.poll();

    expect(mockDb.updateTeamSilent).not.toHaveBeenCalledWith(
      1,
      expect.objectContaining({ prNumber: expect.anything() }),
    );
  });
});

// =============================================================================
// Error handling
// =============================================================================

describe('Error handling', () => {
  it('continues polling other teams when one team fails', async () => {
    const project = makeProject();
    const team1 = makeTeam({ id: 1, prNumber: 42 });
    const team2 = makeTeam({ id: 2, prNumber: 43, issueNumber: 11 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team1, team2]);

    let callCount = 0;
    mockExecGHAsync.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return null; // simulate gh CLI failure (returns null)
      }
      return makeGHPRViewResult({ number: 43 });
    });
    mockDb.getPullRequest.mockReturnValue(undefined);

    await githubPoller.poll();

    expect(mockDb.insertPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 43 }),
    );
  });

  it('handles malformed JSON from gh CLI gracefully', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);

    mockExecGHAsync.mockResolvedValue('not valid json {{{');

    await expect(githubPoller.poll()).resolves.not.toThrow();
  });

  it('handles gh CLI returning null gracefully', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);

    mockExecGHAsync.mockResolvedValue(null);

    await expect(githubPoller.poll()).resolves.not.toThrow();
  });
});

// =============================================================================
// Auto-merge detection
// =============================================================================

describe('Auto-merge detection', () => {
  it('detects auto-merge enabled', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'none',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        autoMergeRequest: { enabledAt: '2025-01-01T00:00:00Z' },
      }),
    );

    await githubPoller.poll();

    expect(mockDb.updatePullRequest).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ autoMerge: true }),
    );
  });
});

// =============================================================================
// Poll lifecycle (start/stop)
// =============================================================================

describe('Poll lifecycle', () => {
  it('start() is idempotent', () => {
    githubPoller.start();
    githubPoller.start();
    githubPoller.stop();
  });

  it('stop() is safe when not started', () => {
    expect(() => githubPoller.stop()).not.toThrow();
  });

  it('stop() clears the timer after start()', () => {
    githubPoller.start();
    githubPoller.stop();
  });
});

// =============================================================================
// Dependency tracking
// =============================================================================

describe('Dependency tracking', () => {
  it('trackBlockedIssue and untrackBlockedIssue do not throw', () => {
    githubPoller.trackBlockedIssue(1, 42, [5, 8]);
    githubPoller.untrackBlockedIssue(1, 42);
  });

  it('broadcasts dependency_resolved when all blockers close', async () => {
    githubPoller.trackBlockedIssue(1, 42, [5]);

    mockFetcher.fetchDependenciesForIssue.mockResolvedValue({
      issueNumber: 42,
      blockedBy: [{ number: 5, owner: 'o', repo: 'r', state: 'closed', title: 'Done' }],
      resolved: true,
      openCount: 0,
    });

    mockDb.getProjects.mockReturnValue([makeProject()]);
    mockDb.getActiveTeams.mockReturnValue([]);

    await githubPoller.poll();

    expect(mockSseBroker.broadcast).toHaveBeenCalledWith(
      'dependency_resolved',
      expect.objectContaining({
        issue_number: 42,
        project_id: 1,
        previously_blocked_by: [5],
      }),
    );
  });

  it('triggers processQueue after dependency resolution', async () => {
    githubPoller.trackBlockedIssue(1, 42, [5]);

    mockFetcher.fetchDependenciesForIssue.mockResolvedValue({
      issueNumber: 42,
      blockedBy: [],
      resolved: true,
      openCount: 0,
    });

    mockDb.getProjects.mockReturnValue([makeProject()]);
    mockDb.getActiveTeams.mockReturnValue([]);

    await githubPoller.poll();

    expect(mockManager.processQueue).toHaveBeenCalledWith(1);
  });

  it('reseedBlockedFromDb populates previouslyBlocked from queued teams', async () => {
    // Set up queued teams with blocked_by_json in the DB
    mockDb.getTeams.mockReturnValue([
      {
        id: 10,
        issueNumber: 100,
        projectId: 1,
        status: 'queued',
        blockedByJson: JSON.stringify([50, 60]),
        worktreeName: 'test-100',
        branchName: null,
        phase: 'init',
        pid: null,
        sessionId: null,
        prNumber: null,
        customPrompt: null,
        headless: true,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
        totalCostUsd: 0,
        launchedAt: null,
        stoppedAt: null,
        lastEventAt: null,
        issueTitle: null,
        createdAt: '',
        updatedAt: '',
      },
    ]);

    // Reseed from DB
    githubPoller.reseedBlockedFromDb();

    // Now when dependency resolves, it should broadcast
    mockFetcher.fetchDependenciesForIssue.mockResolvedValue({
      issueNumber: 100,
      blockedBy: [],
      resolved: true,
      openCount: 0,
    });

    mockDb.getProjects.mockReturnValue([makeProject()]);
    mockDb.getActiveTeams.mockReturnValue([]);

    await githubPoller.poll();

    expect(mockSseBroker.broadcast).toHaveBeenCalledWith(
      'dependency_resolved',
      expect.objectContaining({
        issue_number: 100,
        project_id: 1,
        previously_blocked_by: [50, 60],
      }),
    );
  });

  it('reseedBlockedFromDb skips teams without blockedByJson', () => {
    mockDb.getTeams.mockReturnValue([
      {
        id: 11,
        issueNumber: 200,
        projectId: 1,
        status: 'queued',
        blockedByJson: null,
        worktreeName: 'test-200',
        branchName: null,
        phase: 'init',
        pid: null,
        sessionId: null,
        prNumber: null,
        customPrompt: null,
        headless: true,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
        totalCostUsd: 0,
        launchedAt: null,
        stoppedAt: null,
        lastEventAt: null,
        issueTitle: null,
        createdAt: '',
        updatedAt: '',
      },
    ]);

    // Should not throw
    githubPoller.reseedBlockedFromDb();
  });
});

// =============================================================================
// Team skipping
// =============================================================================

describe('Team skipping', () => {
  it('skips teams whose project has no githubRepo', async () => {
    const project = makeProject({ githubRepo: null });
    const team = makeTeam({ prNumber: 42, projectId: 1 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);

    await githubPoller.poll();

    expect(mockDb.getPullRequest).not.toHaveBeenCalled();
  });

  it('does nothing when no active projects exist', async () => {
    mockDb.getProjects.mockReturnValue([]);
    mockDb.getActiveTeams.mockReturnValue([makeTeam()]);

    await githubPoller.poll();

    expect(mockDb.getPullRequest).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Merge state SSE broadcast
// =============================================================================

describe('Merge detection SSE', () => {
  it('broadcasts team_status_changed when PR is merged', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42, status: 'running' });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'passing',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });
    mockDb.getTeam.mockReturnValue({ ...team, status: 'running' });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        state: 'CLOSED',
        mergedAt: '2024-01-01T00:00:00Z',
      }),
    );

    await githubPoller.poll();

    expect(mockSseBroker.broadcast).toHaveBeenCalledWith(
      'team_status_changed',
      expect.objectContaining({
        team_id: 1,
        status: 'done',
        previous_status: 'running',
      }),
      1,
    );
  });
});

// =============================================================================
// Branch detection (async)
// =============================================================================

describe('Branch detection', () => {
  it('updates branch name when worktree branch differs from stored', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: null, branchName: 'old-branch', worktreeName: 'proj-10' });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);

    // detectWorktreeBranch returns a different branch
    mockExecGitAsync.mockResolvedValue('new-branch');
    // detectPR returns empty
    mockExecGHAsync.mockResolvedValue(JSON.stringify([]));

    await githubPoller.poll();

    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(1, { branchName: 'new-branch' });
  });
});

// =============================================================================
// Branch behind notifications
// =============================================================================

describe('Branch behind notifications', () => {
  it('sends branch_behind message when merge status changes to behind', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42, status: 'running' });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'passing',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });

    (mockResolveMessage as ReturnType<typeof vi.fn>).mockImplementation(
      (id: string) => (id === 'branch_behind' ? 'Rebase needed' : null),
    );

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({ mergeStateStatus: 'BEHIND' }),
    );

    await githubPoller.poll();

    expect(mockResolveMessage).toHaveBeenCalledWith('branch_behind', {
      PR_NUMBER: '42',
      BASE_BRANCH: 'main',
    });
    expect(mockManager.sendMessage).toHaveBeenCalledWith(
      1,
      'Rebase needed',
      'fc',
      'branch_behind',
    );
  });

  it('sends branch_behind message with non-main base branch', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42, status: 'running' });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'passing',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });

    (mockResolveMessage as ReturnType<typeof vi.fn>).mockImplementation(
      (id: string) => (id === 'branch_behind' ? 'Rebase onto develop' : null),
    );

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({ mergeStateStatus: 'BEHIND', baseRefName: 'develop' }),
    );

    await githubPoller.poll();

    expect(mockResolveMessage).toHaveBeenCalledWith('branch_behind', {
      PR_NUMBER: '42',
      BASE_BRANCH: 'develop',
    });
    expect(mockManager.sendMessage).toHaveBeenCalledWith(
      1,
      'Rebase onto develop',
      'fc',
      'branch_behind',
    );
  });

  it('falls back to main when baseRefName is null', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42, status: 'running' });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'passing',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
      baseRefName: null,
    });

    (mockResolveMessage as ReturnType<typeof vi.fn>).mockImplementation(
      (id: string) => (id === 'branch_behind' ? 'Rebase needed' : null),
    );

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({ mergeStateStatus: 'BEHIND', baseRefName: undefined }),
    );

    await githubPoller.poll();

    expect(mockResolveMessage).toHaveBeenCalledWith('branch_behind', {
      PR_NUMBER: '42',
      BASE_BRANCH: 'main',
    });
  });

  it('sends branch_behind_resolved message when merge status changes from behind to clean', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42, status: 'running' });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'passing',
      mergeStatus: 'behind',
      autoMerge: false,
      ciFailCount: 0,
    });

    (mockResolveMessage as ReturnType<typeof vi.fn>).mockImplementation(
      (id: string) => (id === 'branch_behind_resolved' ? 'Up-to-date now' : null),
    );

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({ mergeStateStatus: 'CLEAN' }),
    );

    await githubPoller.poll();

    expect(mockResolveMessage).toHaveBeenCalledWith('branch_behind_resolved', {
      PR_NUMBER: '42',
      BASE_BRANCH: 'main',
    });
    expect(mockManager.sendMessage).toHaveBeenCalledWith(
      1,
      'Up-to-date now',
      'fc',
      'branch_behind_resolved',
    );
  });

  it('does not re-send branch_behind on repeated behind polls', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42, status: 'running' });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'passing',
      mergeStatus: 'behind',
      autoMerge: false,
      ciFailCount: 0,
    });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({ mergeStateStatus: 'BEHIND' }),
    );

    await githubPoller.poll();

    // No change detected (behind -> behind), so no message should be sent
    expect(mockManager.sendMessage).not.toHaveBeenCalled();
  });
});

// =============================================================================
// First PR detection — dirty merge state notification
// =============================================================================

describe('First PR detection — dirty merge state', () => {
  it('sends merge_conflict message when PR is first detected as dirty', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue(undefined);

    (mockResolveMessage as ReturnType<typeof vi.fn>).mockImplementation(
      (id: string) => (id === 'merge_conflict' ? 'PR has merge conflicts' : null),
    );

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({ mergeStateStatus: 'DIRTY' }),
    );

    await githubPoller.poll();

    expect(mockDb.insertPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        prNumber: 42,
        teamId: 1,
        mergeStatus: 'dirty',
      }),
    );
    expect(mockManager.sendMessage).toHaveBeenCalledWith(
      1,
      'PR has merge conflicts',
      'fc',
      'merge_conflict',
    );
  });

  it('does not send merge_conflict when PR is first detected as clean', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue(undefined);

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({ mergeStateStatus: 'CLEAN' }),
    );

    await githubPoller.poll();

    expect(mockDb.insertPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        prNumber: 42,
        teamId: 1,
        mergeStatus: 'clean',
      }),
    );
    expect(mockManager.sendMessage).not.toHaveBeenCalled();
  });
});

// =============================================================================
// CI green with dirty merge state
// =============================================================================

describe('CI green with dirty merge state', () => {
  it('sends ci_green_but_dirty when CI passes and PR is dirty', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'pending',
      mergeStatus: 'dirty',
      autoMerge: false,
      ciFailCount: 0,
    });

    (mockResolveMessage as ReturnType<typeof vi.fn>).mockImplementation(
      (id: string) => (id === 'ci_green_but_dirty' ? 'CI green but dirty' : null),
    );

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        mergeStateStatus: 'DIRTY',
        statusCheckRollup: [
          { name: 'build', conclusion: 'SUCCESS', status: 'COMPLETED' },
        ],
      }),
    );

    await githubPoller.poll();

    expect(mockManager.sendMessage).toHaveBeenCalledWith(
      1,
      'CI green but dirty',
      'fc',
      'ci_green_but_dirty',
    );
  });

  it('sends regular ci_green when CI passes and PR is clean', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'pending',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });

    (mockResolveMessage as ReturnType<typeof vi.fn>).mockImplementation(
      (id: string) => (id === 'ci_green' ? 'CI passed' : null),
    );

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [
          { name: 'build', conclusion: 'SUCCESS', status: 'COMPLETED' },
        ],
      }),
    );

    await githubPoller.poll();

    expect(mockManager.sendMessage).toHaveBeenCalledWith(
      1,
      'CI passed',
      'fc',
      'ci_green',
    );
  });
});

// =============================================================================
// Input validation guards (injection prevention)
// =============================================================================

describe('Adaptive polling interval', () => {
  it('sets fast poll when CI is pending', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'none',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        statusCheckRollup: [
          { name: 'build', conclusion: null, status: 'IN_PROGRESS' },
        ],
      }),
    );

    await githubPoller.poll();

    // needsFastPoll should be true (accessed via bracket notation)
    expect((githubPoller as unknown as Record<string, unknown>)['needsFastPoll']).toBe(true);
  });

  it('does not set fast poll for open PR with passing CI', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'passing',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        statusCheckRollup: [
          { name: 'build', conclusion: 'SUCCESS', status: 'COMPLETED' },
        ],
      }),
    );

    await githubPoller.poll();

    // needsFastPoll should be false — open PRs with passing CI do NOT trigger fast poll
    expect((githubPoller as unknown as Record<string, unknown>)['needsFastPoll']).toBe(false);
  });
});

describe('Input validation guards', () => {
  it('pollPR skips gh CLI call when githubRepo is invalid', async () => {
    const project = makeProject({ githubRepo: 'owner/repo; rm -rf /' });
    const team = makeTeam({ prNumber: 42, projectId: 1 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await githubPoller.poll();

    // gh CLI should never be called for an invalid repo slug
    expect(mockExecGHAsync).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('detectPR skips gh CLI call when branchName contains injection payload', async () => {
    const project = makeProject();
    const team = makeTeam({
      prNumber: null,
      branchName: "'; rm -rf /",
      worktreeName: 'proj-10',
    });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);

    // detectWorktreeBranch returns the same malicious branch name
    mockExecGitAsync.mockResolvedValue("'; rm -rf /");

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await githubPoller.poll();

    // execGHAsync should not be called for the detectPR step
    expect(mockExecGHAsync).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('detectPR skips gh CLI call when githubRepo is invalid', async () => {
    const project = makeProject({ githubRepo: '$(whoami)/repo' });
    const team = makeTeam({
      prNumber: null,
      branchName: 'feat/10-test',
      worktreeName: 'proj-10',
    });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);

    mockExecGitAsync.mockResolvedValue('feat/10-test');

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await githubPoller.poll();

    // gh CLI should never be called for an invalid repo slug
    expect(mockExecGHAsync).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// =============================================================================
// Surgical cache update on PR merge (Issue #646)
// =============================================================================

describe('Surgical cache update on PR merge', () => {
  it('calls markIssueClosed when issue is confirmed closed after merge', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42, status: 'running', projectId: 1, issueNumber: 10 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'passing',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });
    mockDb.getTeam.mockReturnValue({ ...team, status: 'running' });

    // First call: pollPR gh pr view -> merged
    // Second call: issue state check -> closed
    mockExecGHAsync
      .mockResolvedValueOnce(
        makeGHPRViewResult({
          state: 'CLOSED',
          mergedAt: '2025-01-01T00:00:00Z',
        }),
      )
      .mockResolvedValueOnce('closed\n');

    await githubPoller.poll();

    expect(mockFetcher.markIssueClosed).toHaveBeenCalledWith(1, 10);
    expect(mockSseBroker.broadcast).toHaveBeenCalledWith(
      'project_updated',
      expect.objectContaining({
        project_id: 1,
        reason: 'issue_closed',
        issue_number: 10,
      }),
    );
  });

  it('does NOT call markIssueClosed when issue is still open after merge', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42, status: 'running', projectId: 1, issueNumber: 10 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'passing',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });
    mockDb.getTeam.mockReturnValue({ ...team, status: 'running' });

    // First call: pollPR gh pr view -> merged
    // Second call: issue state check -> open (not auto-closed)
    mockExecGHAsync
      .mockResolvedValueOnce(
        makeGHPRViewResult({
          state: 'CLOSED',
          mergedAt: '2025-01-01T00:00:00Z',
        }),
      )
      .mockResolvedValueOnce('open\n');

    await githubPoller.poll();

    expect(mockFetcher.markIssueClosed).not.toHaveBeenCalled();
  });

  it('handles issue state check failure gracefully', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42, status: 'running', projectId: 1, issueNumber: 10 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'passing',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });
    mockDb.getTeam.mockReturnValue({ ...team, status: 'running' });

    // First call: pollPR gh pr view -> merged
    // Second call: issue state check -> failure
    mockExecGHAsync
      .mockResolvedValueOnce(
        makeGHPRViewResult({
          state: 'CLOSED',
          mergedAt: '2025-01-01T00:00:00Z',
        }),
      )
      .mockRejectedValueOnce(new Error('API rate limit exceeded'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Should not throw
    await githubPoller.poll();

    expect(mockFetcher.markIssueClosed).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});


// CI green + auto-merge early shutdown
// =============================================================================

describe('CI green + auto-merge early shutdown', () => {
  it('triggers early shutdown when CI turns green with auto-merge and clean merge state', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42, status: 'running', projectId: 1 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'pending',
      mergeStatus: 'clean',
      autoMerge: true,
      ciFailCount: 0,
    });
    mockDb.getTeam.mockReturnValue({ ...team, status: 'running' });

    // CI turns green, auto-merge enabled, merge state clean
    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        state: 'OPEN',
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS' }],
        autoMergeRequest: { enabledAt: '2025-01-01T00:00:00Z' },
      }),
    );

    // resolveMessage returns a non-null message so sendMessage fires
    (mockResolveMessage as ReturnType<typeof vi.fn>).mockReturnValue('CI green auto shutdown msg');

    await githubPoller.poll();

    // Team should be transitioned to done
    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        toStatus: 'done',
        trigger: 'poller',
        reason: expect.stringContaining('early shutdown'),
      }),
    );
    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        status: 'done',
        phase: 'done',
      }),
    );

    // Graceful shutdown should be initiated
    expect(mockManager.gracefulShutdown).toHaveBeenCalledWith(1, 42, 120000);

    // Queue should be processed immediately
    expect(mockManager.processQueue).toHaveBeenCalledWith(1);

    // ci_green_auto_shutdown message should be sent
    expect(mockManager.sendMessage).toHaveBeenCalledWith(
      1,
      'CI green auto shutdown msg',
      'fc',
      'ci_green_auto_shutdown',
    );
  });

  it('does NOT trigger early shutdown when merge state is dirty', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42, status: 'running', projectId: 1 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'pending',
      mergeStatus: 'dirty',
      autoMerge: true,
      ciFailCount: 0,
    });
    mockDb.getTeam.mockReturnValue({ ...team, status: 'running' });

    // CI turns green, auto-merge enabled, but merge state is dirty
    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        state: 'OPEN',
        mergeStateStatus: 'DIRTY',
        statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS' }],
        autoMergeRequest: { enabledAt: '2025-01-01T00:00:00Z' },
      }),
    );

    (mockResolveMessage as ReturnType<typeof vi.fn>).mockReturnValue('some msg');

    await githubPoller.poll();

    // Should NOT have transitioned to done via early shutdown
    const transitionCalls = mockDb.insertTransition.mock.calls;
    const earlyShutdownTransition = transitionCalls.find(
      (call: unknown[]) => {
        const arg = call[0] as { reason?: string };
        return arg.reason?.includes('early shutdown');
      },
    );
    expect(earlyShutdownTransition).toBeUndefined();
  });

  it('does NOT trigger early shutdown when merge state is behind (base branch advanced)', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42, status: 'running', projectId: 1 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'pending',
      mergeStatus: 'unknown',
      autoMerge: true,
      ciFailCount: 0,
    });
    mockDb.getTeam.mockReturnValue({ ...team, status: 'running' });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // CI turns green, auto-merge enabled, but branch is behind base
    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        state: 'OPEN',
        mergeStateStatus: 'BEHIND',
        statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS' }],
        autoMergeRequest: { enabledAt: '2025-01-01T00:00:00Z' },
      }),
    );

    (mockResolveMessage as ReturnType<typeof vi.fn>).mockReturnValue('some msg');

    await githubPoller.poll();

    // Should NOT have called gracefulShutdown
    expect(mockManager.gracefulShutdown).not.toHaveBeenCalled();

    // Should NOT have transitioned to done via early shutdown
    const earlyShutdownTransition = mockDb.insertTransition.mock.calls.find(
      (call: unknown[]) => {
        const arg = call[0] as { reason?: string };
        return arg.reason?.includes('early shutdown');
      },
    );
    expect(earlyShutdownTransition).toBeUndefined();

    // Skip log line should be emitted
    const skipLogged = logSpy.mock.calls.some((call) =>
      String(call[0] ?? '').includes('NOT early-shutting-down'),
    );
    expect(skipLogged).toBe(true);

    logSpy.mockRestore();
  });

  it('does NOT trigger early shutdown when merge state is blocked by conflict (dirty)', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42, status: 'running', projectId: 1 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'pending',
      mergeStatus: 'unknown',
      autoMerge: true,
      ciFailCount: 0,
    });
    mockDb.getTeam.mockReturnValue({ ...team, status: 'running' });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // CI turns green, auto-merge enabled, but PR has merge conflict
    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        state: 'OPEN',
        mergeStateStatus: 'DIRTY',
        statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS' }],
        autoMergeRequest: { enabledAt: '2025-01-01T00:00:00Z' },
      }),
    );

    (mockResolveMessage as ReturnType<typeof vi.fn>).mockReturnValue('some msg');

    await githubPoller.poll();

    expect(mockManager.gracefulShutdown).not.toHaveBeenCalled();

    const earlyShutdownTransition = mockDb.insertTransition.mock.calls.find(
      (call: unknown[]) => {
        const arg = call[0] as { reason?: string };
        return arg.reason?.includes('early shutdown');
      },
    );
    expect(earlyShutdownTransition).toBeUndefined();

    const skipLogged = logSpy.mock.calls.some((call) =>
      String(call[0] ?? '').includes('NOT early-shutting-down'),
    );
    expect(skipLogged).toBe(true);

    logSpy.mockRestore();
  });

  it('still triggers early shutdown when merge state is unknown (common first-poll case)', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42, status: 'running', projectId: 1 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'pending',
      mergeStatus: 'unknown',
      autoMerge: true,
      ciFailCount: 0,
    });
    mockDb.getTeam.mockReturnValue({ ...team, status: 'running' });

    // CI turns green, auto-merge enabled, GitHub hasn't computed mergeability
    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        state: 'OPEN',
        mergeStateStatus: 'UNKNOWN',
        statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS' }],
        autoMergeRequest: { enabledAt: '2025-01-01T00:00:00Z' },
      }),
    );

    (mockResolveMessage as ReturnType<typeof vi.fn>).mockReturnValue('msg');

    await githubPoller.poll();

    // Should have fired gracefulShutdown — we don't want to stall on
    // missing/unknown data from GitHub
    expect(mockManager.gracefulShutdown).toHaveBeenCalledWith(1, 42, 120000);
    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        toStatus: 'done',
        reason: expect.stringContaining('early shutdown'),
      }),
    );
  });

  it('does NOT trigger early shutdown when auto-merge is NOT enabled', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42, status: 'running', projectId: 1 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'pending',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });
    mockDb.getTeam.mockReturnValue({ ...team, status: 'running' });

    // CI turns green, merge state clean, but auto-merge NOT enabled
    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        state: 'OPEN',
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS' }],
        autoMergeRequest: null,
      }),
    );

    (mockResolveMessage as ReturnType<typeof vi.fn>).mockReturnValue('some msg');

    await githubPoller.poll();

    // Should NOT have transitioned to done via early shutdown
    const transitionCalls = mockDb.insertTransition.mock.calls;
    const earlyShutdownTransition = transitionCalls.find(
      (call: unknown[]) => {
        const arg = call[0] as { reason?: string };
        return arg.reason?.includes('early shutdown');
      },
    );
    expect(earlyShutdownTransition).toBeUndefined();
  });
});

// =============================================================================
// Merge status disambiguation (issue #686)
// =============================================================================

describe('Merge status disambiguation', () => {
  it('disambiguates blocked with pending CI as blocked_ci_pending', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'none',
      mergeStatus: 'unknown',
      autoMerge: false,
      ciFailCount: 0,
    });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        mergeStateStatus: 'BLOCKED',
        statusCheckRollup: [
          { name: 'build', conclusion: null, status: 'IN_PROGRESS' },
        ],
        reviewDecision: null,
      }),
    );

    await githubPoller.poll();

    expect(mockDb.updatePullRequest).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ mergeStatus: 'blocked_ci_pending' }),
    );
  });

  it('disambiguates blocked with failing CI as blocked_ci_failed', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'none',
      mergeStatus: 'unknown',
      autoMerge: false,
      ciFailCount: 0,
    });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        mergeStateStatus: 'BLOCKED',
        statusCheckRollup: [
          { name: 'build', conclusion: 'FAILURE', status: 'COMPLETED' },
        ],
        reviewDecision: null,
      }),
    );

    await githubPoller.poll();

    expect(mockDb.updatePullRequest).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ mergeStatus: 'blocked_ci_failed' }),
    );
  });

  it('disambiguates blocked with review required as blocked_review', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'none',
      mergeStatus: 'unknown',
      autoMerge: false,
      ciFailCount: 0,
    });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        mergeStateStatus: 'BLOCKED',
        statusCheckRollup: [
          { name: 'build', conclusion: 'SUCCESS', status: 'COMPLETED' },
        ],
        reviewDecision: 'REVIEW_REQUIRED',
      }),
    );

    await githubPoller.poll();

    expect(mockDb.updatePullRequest).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ mergeStatus: 'blocked_review' }),
    );
  });

  it('disambiguates blocked with CHANGES_REQUESTED as blocked_review', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'none',
      mergeStatus: 'unknown',
      autoMerge: false,
      ciFailCount: 0,
    });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        mergeStateStatus: 'BLOCKED',
        statusCheckRollup: [
          { name: 'build', conclusion: 'SUCCESS', status: 'COMPLETED' },
        ],
        reviewDecision: 'CHANGES_REQUESTED',
      }),
    );

    await githubPoller.poll();

    expect(mockDb.updatePullRequest).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ mergeStatus: 'blocked_review' }),
    );
  });

  it('disambiguates blocked with unknown reason as blocked_unknown', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42 });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'none',
      mergeStatus: 'unknown',
      autoMerge: false,
      ciFailCount: 0,
    });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        mergeStateStatus: 'BLOCKED',
        statusCheckRollup: [
          { name: 'build', conclusion: 'SUCCESS', status: 'COMPLETED' },
        ],
        reviewDecision: null,
      }),
    );

    await githubPoller.poll();

    expect(mockDb.updatePullRequest).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ mergeStatus: 'blocked_unknown' }),
    );
  });
});

// =============================================================================
// Post-merge CI filtering and cleanup (issue #686)
// =============================================================================

describe('Post-merge CI filtering and cleanup', () => {
  it('resets ciFailCount to 0 when PR is merged', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42, status: 'running' });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'failing',
      mergeStatus: 'blocked',
      autoMerge: false,
      ciFailCount: 2,
    });
    mockDb.getTeam.mockReturnValue({ ...team, status: 'running' });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        state: 'CLOSED',
        mergedAt: '2025-01-01T00:00:00Z',
        statusCheckRollup: [
          { name: 'build', conclusion: 'FAILURE', status: 'COMPLETED' },
        ],
      }),
    );

    await githubPoller.poll();

    expect(mockDb.updatePullRequest).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ ciFailCount: 0 }),
    );
  });

  it('sets mergeStatus to clean on merge', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42, status: 'running' });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'pending',
      mergeStatus: 'blocked',
      autoMerge: false,
      ciFailCount: 0,
    });
    mockDb.getTeam.mockReturnValue({ ...team, status: 'running' });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        state: 'CLOSED',
        mergedAt: '2025-01-01T00:00:00Z',
      }),
    );

    await githubPoller.poll();

    expect(mockDb.updatePullRequest).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ mergeStatus: 'clean' }),
    );
  });

  it('filters post-merge IN_PROGRESS checks from ciStatus derivation', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42, status: 'running' });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'passing',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });
    mockDb.getTeam.mockReturnValue({ ...team, status: 'running' });

    // Merged PR with one passing pre-merge check and one IN_PROGRESS post-merge check
    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        state: 'CLOSED',
        mergedAt: '2025-01-01T00:00:00Z',
        statusCheckRollup: [
          { name: 'build', conclusion: 'SUCCESS', status: 'COMPLETED' },
          { name: 'deploy', conclusion: null, status: 'IN_PROGRESS' },
        ],
      }),
    );

    await githubPoller.poll();

    // ciStatus should be 'passing' (post-merge IN_PROGRESS check filtered out)
    expect(mockDb.updatePullRequest).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ ciStatus: 'passing' }),
    );
  });

  it('reconcilePR triggers a single PR poll for a team', async () => {
    const project = makeProject();
    const team = makeTeam({ prNumber: 42, projectId: 1, status: 'done' });
    mockDb.getTeam.mockReturnValue(team);
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'pending',
      mergeStatus: 'blocked',
      autoMerge: false,
      ciFailCount: 0,
    });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        state: 'CLOSED',
        mergedAt: '2025-01-01T00:00:00Z',
      }),
    );

    await githubPoller.reconcilePR(1);

    // Should have called gh pr view for the team's PR
    expect(mockExecGHAsync).toHaveBeenCalledWith(
      expect.stringContaining('gh pr view 42'),
    );
    // ciFailCount should be 0 and mergeStatus should be clean
    expect(mockDb.updatePullRequest).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ ciFailCount: 0, mergeStatus: 'clean' }),
    );
  });
});

// =============================================================================
// Fix #692 (C) — branchName reconciliation against PR headRefName
// =============================================================================

describe('Fix #692 (C) — branchName reconciliation', () => {
  it('reconciles team.branchName to PR headRefName on poll when they differ', async () => {
    const project = makeProject();
    const team = makeTeam({
      id: 1,
      prNumber: 42,
      branchName: 'wrong-branch',
      status: 'running',
    });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'none',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });
    mockDb.getTeam.mockReturnValue(team);

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        headRefName: 'actual-branch',
      }),
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await githubPoller.poll();

    // Team should be updated with the correct branchName
    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ branchName: 'actual-branch' }),
    );

    // A system transition should be logged with the reconcile reason
    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        trigger: 'system',
        reason: expect.stringContaining('branchName reconciled from "wrong-branch" to "actual-branch"'),
      }),
    );

    // Warning should be logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('branchName drift'),
    );

    warnSpy.mockRestore();
  });

  it('does not reconcile or log when branchName already matches headRefName', async () => {
    const project = makeProject();
    const team = makeTeam({
      id: 1,
      prNumber: 42,
      branchName: 'feat/10-test',
      status: 'running',
    });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'none',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });
    mockDb.getTeam.mockReturnValue(team);

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        headRefName: 'feat/10-test',
      }),
    );

    await githubPoller.poll();

    // Should NOT insert a reconcile transition — branches already match.
    const reconcileCall = mockDb.insertTransition.mock.calls.find((call) =>
      String((call[0] as { reason?: string })?.reason ?? '').includes('branchName reconciled'),
    );
    expect(reconcileCall).toBeUndefined();
  });
});

// =============================================================================
// Fix #692 (A) — branch collision audit warning
// =============================================================================

describe('Fix #692 (A) — branch collision audit warning', () => {
  it('emits team_warning SSE event when two running teams claim the same branch', async () => {
    const project = makeProject({ id: 1 });
    const teamA = makeTeam({
      id: 1,
      prNumber: 42,
      branchName: 'shared-branch',
      projectId: 1,
      status: 'running',
    });
    const teamB = makeTeam({
      id: 2,
      prNumber: null,
      branchName: 'shared-branch',
      projectId: 1,
      status: 'running',
    });

    mockDb.getProjects.mockReturnValue([project]);
    // Only team A is polled via pollPR (has prNumber); team B is in active list
    mockDb.getActiveTeams.mockReturnValue([teamA, teamB]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'none',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });
    mockDb.getTeam.mockImplementation((id: number) => {
      if (id === 1) return teamA;
      if (id === 2) return teamB;
      return undefined;
    });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        headRefName: 'shared-branch',
      }),
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await githubPoller.poll();

    // A branch collision warning SSE event should have been broadcast
    const collisionCall = mockSseBroker.broadcast.mock.calls.find(
      (call) => call[0] === 'team_warning',
    );
    expect(collisionCall).toBeDefined();
    expect(collisionCall?.[1]).toEqual(
      expect.objectContaining({
        team_id: 1,
        warning_type: 'branch_collision',
        message: expect.stringContaining('branch collision detected'),
        details: expect.objectContaining({
          pr_number: 42,
          branch_name: 'shared-branch',
          other_team_id: 2,
        }),
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('branch collision detected'),
    );

    warnSpy.mockRestore();
  });

  it('does not emit team_warning when teams have different branches', async () => {
    const project = makeProject({ id: 1 });
    const teamA = makeTeam({
      id: 1,
      prNumber: 42,
      branchName: 'branch-a',
      projectId: 1,
      status: 'running',
    });
    const teamB = makeTeam({
      id: 2,
      prNumber: null,
      branchName: 'branch-b',
      projectId: 1,
      status: 'running',
    });

    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getActiveTeams.mockReturnValue([teamA, teamB]);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      state: 'open',
      ciStatus: 'none',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
    });
    mockDb.getTeam.mockImplementation((id: number) => {
      if (id === 1) return teamA;
      if (id === 2) return teamB;
      return undefined;
    });

    mockExecGHAsync.mockResolvedValue(
      makeGHPRViewResult({
        headRefName: 'branch-a',
      }),
    );

    await githubPoller.poll();

    // No team_warning broadcast expected
    const collisionCall = mockSseBroker.broadcast.mock.calls.find(
      (call) => call[0] === 'team_warning',
    );
    expect(collisionCall).toBeUndefined();
  });
});
