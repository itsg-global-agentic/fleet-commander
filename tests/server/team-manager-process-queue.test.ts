// =============================================================================
// Fleet Commander — TeamManager.processQueue tests
// =============================================================================
// Tests for:
//   - Re-drain race condition handling
//   - Dependency filtering in processQueue (blocked issues skip launch)
//   - Circular dependency detection (cycles treated as unblocked)
//   - Auto-launch on dependency resolution
// =============================================================================

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Mock modules before importing TeamManager
// ---------------------------------------------------------------------------

const mockDb = {
  getProject: vi.fn(),
  getActiveTeamCountByProject: vi.fn(),
  getQueuedTeamsByProject: vi.fn(),
  getTeam: vi.fn(),
  updateTeam: vi.fn(),
  updateTeamSilent: vi.fn(),
  insertTransition: vi.fn(),
};

vi.mock('../../src/server/db.js', () => ({
  getDatabase: () => mockDb,
}));

vi.mock('../../src/server/config.js', () => ({
  default: {
    worktreeDir: '.claude/worktrees',
    outputBufferLines: 500,
    claudeCmd: 'claude',
    skipPermissions: true,
    terminal: 'auto',
  },
}));

vi.mock('../../src/server/services/sse-broker.js', () => ({
  sseBroker: {
    broadcast: vi.fn(),
    getSnapshot: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('../../src/server/utils/find-git-bash.js', () => ({
  findGitBash: vi.fn().mockReturnValue(null),
}));

// Mock issue-fetcher for dependency checks in processQueue
const mockFetchDependenciesForIssue = vi.fn();

vi.mock('../../src/server/services/issue-fetcher.js', () => ({
  getIssueFetcher: () => ({
    fetchDependenciesForIssue: mockFetchDependenciesForIssue,
  }),
  detectCircularDependencies: vi.fn().mockReturnValue(null),
}));

// Mock github-poller for blocked issue tracking
const mockTrackBlockedIssue = vi.fn();

vi.mock('../../src/server/services/github-poller.js', () => ({
  githubPoller: {
    trackBlockedIssue: mockTrackBlockedIssue,
  },
}));

import { TeamManager } from '../../src/server/services/team-manager.js';
import type { Team, Project } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProject(overrides?: Partial<Project>): Project {
  return {
    id: 1,
    name: 'test-project',
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

function makeTeam(overrides?: Partial<Team>): Team {
  return {
    id: 100,
    issueNumber: 10,
    issueTitle: 'Test issue',
    projectId: 1,
    status: 'queued',
    phase: 'queued',
    pid: null,
    sessionId: null,
    worktreeName: 'test-project-10',
    branchName: 'feat/10-test',
    prNumber: null,
    customPrompt: null,
    headless: true,
    launchedAt: null,
    stoppedAt: null,
    lastEventAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TeamManager.processQueue re-drain', () => {
  let tm: TeamManager;
  let launchQueuedSpy: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    tm = new TeamManager();

    // Stub the private launchQueued method to avoid spawning real processes
    launchQueuedSpy = vi.fn().mockResolvedValue(undefined);
    (tm as any).launchQueued = launchQueuedSpy;

    // Stub broadcastSnapshot to avoid SSE calls
    (tm as any).broadcastSnapshot = vi.fn();

    // Default: all dependencies resolved (unblocked) so existing re-drain tests pass
    mockFetchDependenciesForIssue.mockResolvedValue({
      issueNumber: 0,
      blockedBy: [],
      resolved: true,
      openCount: 0,
    });
  });

  it('re-drains queued teams when a concurrent call was dropped by the guard', async () => {
    const project = makeProject({ id: 1, maxActiveTeams: 2 });
    const team1 = makeTeam({ id: 101, issueNumber: 1, worktreeName: 'proj-1', status: 'queued' });
    const team2 = makeTeam({ id: 102, issueNumber: 2, worktreeName: 'proj-2', status: 'queued' });

    // First call: 1 active, max 2 => 1 available slot, 1 queued team
    // During launchQueued, a second team becomes queued (simulating concurrent exit)
    let launchCallCount = 0;

    mockDb.getProject.mockReturnValue(project);

    // Track call sequences for getActiveTeamCountByProject:
    // - First processQueue iteration: 1 active (1 slot available)
    // - Re-drain check in finally: 1 active (team1 now launching counts as active)
    // - Second processQueue (re-drain): 1 active (still 1 slot for team2)
    // - Second finally re-drain check: 2 active (both launched, no more slots)
    mockDb.getActiveTeamCountByProject
      .mockReturnValueOnce(1)  // first processQueue: check available slots
      .mockReturnValueOnce(1)  // first finally: re-drain check
      .mockReturnValueOnce(1)  // second processQueue (re-drain): check available slots
      .mockReturnValueOnce(2); // second finally: re-drain check (no more slots)

    // Track call sequences for getQueuedTeamsByProject:
    // - First processQueue: returns [team1]
    // - First finally re-drain check: returns [team2] (appeared during launchQueued)
    // - Second processQueue (re-drain): returns [team2]
    // - Second finally re-drain check: returns [] (all launched)
    mockDb.getQueuedTeamsByProject
      .mockReturnValueOnce([team1])  // first processQueue: find queued teams
      .mockReturnValueOnce([team2])  // first finally: re-drain check
      .mockReturnValueOnce([team2])  // second processQueue (re-drain): find queued teams
      .mockReturnValueOnce([]);      // second finally: re-drain check

    mockDb.updateTeamSilent.mockReturnValue(undefined);
    mockDb.insertTransition.mockReturnValue(undefined);

    // Run the first processQueue — it should launch team1, then re-drain and launch team2
    await tm.processQueue(1);

    // Allow setImmediate to fire for the re-drain
    await new Promise((resolve) => setImmediate(resolve));
    // Allow any further setImmediate to settle
    await new Promise((resolve) => setImmediate(resolve));

    // Both teams should have been launched
    expect(launchQueuedSpy).toHaveBeenCalledTimes(2);
    expect(launchQueuedSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 101 }));
    expect(launchQueuedSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 102 }));
  });

  it('does not re-drain when no queued teams remain', async () => {
    const project = makeProject({ id: 1, maxActiveTeams: 2 });
    const team1 = makeTeam({ id: 101, status: 'queued' });

    mockDb.getProject.mockReturnValue(project);
    mockDb.getActiveTeamCountByProject
      .mockReturnValueOnce(0)  // processQueue: 0 active
      .mockReturnValueOnce(1); // finally: re-drain check
    mockDb.getQueuedTeamsByProject
      .mockReturnValueOnce([team1])  // processQueue: 1 queued
      .mockReturnValueOnce([]);      // finally: no more queued
    mockDb.updateTeamSilent.mockReturnValue(undefined);
    mockDb.insertTransition.mockReturnValue(undefined);

    await tm.processQueue(1);

    // Allow setImmediate to fire (it shouldn't be scheduled)
    await new Promise((resolve) => setImmediate(resolve));

    // Only team1 should have been launched — no re-drain needed
    expect(launchQueuedSpy).toHaveBeenCalledTimes(1);
    expect(launchQueuedSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 101 }));
  });

  it('passes headless preference from queued team to launchQueued', async () => {
    const project = makeProject({ id: 1, maxActiveTeams: 5 });
    const interactiveTeam = makeTeam({ id: 301, issueNumber: 30, worktreeName: 'proj-30', status: 'queued', headless: false });
    const headlessTeam = makeTeam({ id: 302, issueNumber: 31, worktreeName: 'proj-31', status: 'queued', headless: true });

    mockDb.getProject.mockReturnValue(project);
    mockDb.getActiveTeamCountByProject
      .mockReturnValueOnce(0)  // processQueue: 0 active
      .mockReturnValueOnce(2); // finally: re-drain check
    mockDb.getQueuedTeamsByProject
      .mockReturnValueOnce([interactiveTeam, headlessTeam])  // processQueue: 2 queued
      .mockReturnValueOnce([]);  // finally: no more queued
    mockDb.updateTeamSilent.mockReturnValue(undefined);
    mockDb.insertTransition.mockReturnValue(undefined);

    await tm.processQueue(1);

    // Allow setImmediate to fire
    await new Promise((resolve) => setImmediate(resolve));

    // Both teams should have been launched
    expect(launchQueuedSpy).toHaveBeenCalledTimes(2);

    // Verify the headless flag is preserved on each team object passed to launchQueued
    const firstCall = launchQueuedSpy.mock.calls[0][0] as Team;
    const secondCall = launchQueuedSpy.mock.calls[1][0] as Team;
    expect(firstCall.headless).toBe(false);
    expect(secondCall.headless).toBe(true);
  });

  it('guard blocks concurrent calls but re-drain catches up', async () => {
    const project = makeProject({ id: 1, maxActiveTeams: 3 });
    const team1 = makeTeam({ id: 201, issueNumber: 1, worktreeName: 'proj-1', status: 'queued' });
    const team2 = makeTeam({ id: 202, issueNumber: 2, worktreeName: 'proj-2', status: 'queued' });

    // Make launchQueued slow so we can attempt a concurrent call
    let resolveFirst: () => void;
    const firstLaunchPromise = new Promise<void>((resolve) => { resolveFirst = resolve; });

    launchQueuedSpy
      .mockImplementationOnce(() => firstLaunchPromise)
      .mockResolvedValue(undefined);

    mockDb.getProject.mockReturnValue(project);
    mockDb.getActiveTeamCountByProject
      .mockReturnValueOnce(2)  // first processQueue: 2 active, 1 slot
      .mockReturnValueOnce(1)  // first finally: re-drain check (slot freed)
      .mockReturnValueOnce(1)  // second processQueue (re-drain)
      .mockReturnValueOnce(2); // second finally: no more slots
    mockDb.getQueuedTeamsByProject
      .mockReturnValueOnce([team1])  // first processQueue
      .mockReturnValueOnce([team2])  // first finally: re-drain check
      .mockReturnValueOnce([team2])  // second processQueue (re-drain)
      .mockReturnValueOnce([]);      // second finally
    mockDb.updateTeamSilent.mockReturnValue(undefined);
    mockDb.insertTransition.mockReturnValue(undefined);

    // Start processQueue — it will start the async filterUnblockedTeams
    const firstCall = tm.processQueue(1);

    // filterUnblockedTeams is async, so launchQueued hasn't been called yet.
    // Yield to let the async filter + launchQueued run, but it will block
    // on the slow launchQueued promise.
    await new Promise((resolve) => setImmediate(resolve));

    // Now launchQueued should have been called once (after filterUnblockedTeams resolved)
    expect(launchQueuedSpy).toHaveBeenCalledTimes(1);
    expect(launchQueuedSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 201 }));

    // Attempt a concurrent call — should be dropped by the guard
    const secondCall = tm.processQueue(1);
    await secondCall; // Returns immediately (guard blocks it)

    // Still only 1 call — the concurrent call was dropped
    expect(launchQueuedSpy).toHaveBeenCalledTimes(1);

    // Release the first launch
    resolveFirst!();
    await firstCall;

    // Allow setImmediate for re-drain
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // Both teams should be launched: team1 by the original call, team2 by the re-drain
    expect(launchQueuedSpy).toHaveBeenCalledTimes(2);
    expect(launchQueuedSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 201 }));
    expect(launchQueuedSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 202 }));
  });
});

// ---------------------------------------------------------------------------
// Dependency filtering in processQueue
// ---------------------------------------------------------------------------

describe('TeamManager.processQueue dependency filtering', () => {
  let tm: TeamManager;
  let launchQueuedSpy: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    tm = new TeamManager();

    launchQueuedSpy = vi.fn().mockResolvedValue(undefined);
    (tm as any).launchQueued = launchQueuedSpy;
    (tm as any).broadcastSnapshot = vi.fn();
  });

  afterEach(async () => {
    // Flush pending re-drain macrotasks and microtasks to prevent leaks
    // between tests via shared module-level mocks.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('skips queued teams with open dependencies', async () => {
    const project = makeProject({ id: 1, maxActiveTeams: 3 });
    const unblockedTeam = makeTeam({ id: 101, issueNumber: 10, worktreeName: 'proj-10', status: 'queued' });
    const blockedTeam = makeTeam({ id: 102, issueNumber: 20, worktreeName: 'proj-20', status: 'queued' });

    mockDb.getProject.mockReturnValue(project);
    mockDb.getActiveTeamCountByProject
      .mockReturnValueOnce(0)  // processQueue: 0 active, 3 available
      .mockReturnValueOnce(1)  // first finally: re-drain check
      .mockReturnValueOnce(1); // second processQueue (re-drain): 1 active, 2 available
    // No 4th value needed: re-drain stops when launchedCount=0 (no unblocked teams)
    mockDb.getQueuedTeamsByProject
      .mockReturnValueOnce([unblockedTeam, blockedTeam])  // first processQueue
      .mockReturnValueOnce([blockedTeam])  // first finally: blocked team still queued
      .mockReturnValueOnce([blockedTeam]); // second processQueue (re-drain)
    // No 4th value needed: re-drain stops when launchedCount=0
    mockDb.updateTeamSilent.mockReturnValue(undefined);
    mockDb.insertTransition.mockReturnValue(undefined);

    // unblockedTeam has no open deps; blockedTeam has open deps
    mockFetchDependenciesForIssue.mockImplementation(async (_projectId: number, issueNumber: number) => {
      if (issueNumber === 10) {
        return { issueNumber: 10, blockedBy: [], resolved: true, openCount: 0 };
      }
      if (issueNumber === 20) {
        return {
          issueNumber: 20,
          blockedBy: [{ number: 5, owner: 'o', repo: 'r', state: 'open', title: 'Blocker' }],
          resolved: false,
          openCount: 1,
        };
      }
      return null;
    });

    await tm.processQueue(1);

    // Allow setImmediate for re-drain (may fire multiple rounds)
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // Only the unblocked team should have been launched
    expect(launchQueuedSpy).toHaveBeenCalledTimes(1);
    expect(launchQueuedSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 101 }));

    // The blocked team should be tracked in the poller
    expect(mockTrackBlockedIssue).toHaveBeenCalledWith(1, 20, [5]);
  });

  it('launches teams when dependencies are resolved (all closed)', async () => {
    const project = makeProject({ id: 1, maxActiveTeams: 2 });
    const team = makeTeam({ id: 101, issueNumber: 10, worktreeName: 'proj-10', status: 'queued' });

    mockDb.getProject.mockReturnValue(project);
    mockDb.getActiveTeamCountByProject
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1);
    mockDb.getQueuedTeamsByProject
      .mockReturnValueOnce([team])
      .mockReturnValueOnce([]);
    mockDb.updateTeamSilent.mockReturnValue(undefined);
    mockDb.insertTransition.mockReturnValue(undefined);

    // Dependencies exist but are all closed
    mockFetchDependenciesForIssue.mockResolvedValue({
      issueNumber: 10,
      blockedBy: [{ number: 5, owner: 'o', repo: 'r', state: 'closed', title: 'Done' }],
      resolved: true,
      openCount: 0,
    });

    await tm.processQueue(1);
    await new Promise((resolve) => setImmediate(resolve));

    expect(launchQueuedSpy).toHaveBeenCalledTimes(1);
    expect(launchQueuedSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 101 }));
    expect(mockTrackBlockedIssue).not.toHaveBeenCalled();
  });

  it('uses permissive fallback when dependency fetch returns null', async () => {
    const project = makeProject({ id: 1, maxActiveTeams: 2 });
    const team = makeTeam({ id: 101, issueNumber: 10, worktreeName: 'proj-10', status: 'queued' });

    mockDb.getProject.mockReturnValue(project);
    mockDb.getActiveTeamCountByProject
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1);
    mockDb.getQueuedTeamsByProject
      .mockReturnValueOnce([team])
      .mockReturnValueOnce([]);
    mockDb.updateTeamSilent.mockReturnValue(undefined);
    mockDb.insertTransition.mockReturnValue(undefined);

    // Dependency fetch fails — returns null
    mockFetchDependenciesForIssue.mockResolvedValue(null);

    await tm.processQueue(1);
    await new Promise((resolve) => setImmediate(resolve));

    // Should still launch (permissive fallback)
    expect(launchQueuedSpy).toHaveBeenCalledTimes(1);
    expect(launchQueuedSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 101 }));
  });

  it('uses permissive fallback when dependency fetch throws', async () => {
    const project = makeProject({ id: 1, maxActiveTeams: 2 });
    const team = makeTeam({ id: 101, issueNumber: 10, worktreeName: 'proj-10', status: 'queued' });

    mockDb.getProject.mockReturnValue(project);
    mockDb.getActiveTeamCountByProject
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1);
    mockDb.getQueuedTeamsByProject
      .mockReturnValueOnce([team])
      .mockReturnValueOnce([]);
    mockDb.updateTeamSilent.mockReturnValue(undefined);
    mockDb.insertTransition.mockReturnValue(undefined);

    // Dependency fetch throws
    mockFetchDependenciesForIssue.mockRejectedValue(new Error('gh CLI not found'));

    await tm.processQueue(1);
    await new Promise((resolve) => setImmediate(resolve));

    // Should still launch (permissive fallback on error)
    expect(launchQueuedSpy).toHaveBeenCalledTimes(1);
    expect(launchQueuedSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 101 }));
  });

  it('only launches up to available slots even when multiple teams are unblocked', async () => {
    const project = makeProject({ id: 1, maxActiveTeams: 2 });
    const team1 = makeTeam({ id: 101, issueNumber: 10, worktreeName: 'proj-10', status: 'queued' });
    const team2 = makeTeam({ id: 102, issueNumber: 20, worktreeName: 'proj-20', status: 'queued' });
    const team3 = makeTeam({ id: 103, issueNumber: 30, worktreeName: 'proj-30', status: 'queued' });

    mockDb.getProject.mockReturnValue(project);
    mockDb.getActiveTeamCountByProject
      .mockReturnValueOnce(1)  // 1 active, max 2 => 1 available
      .mockReturnValueOnce(2); // finally: no more slots
    mockDb.getQueuedTeamsByProject
      .mockReturnValueOnce([team1, team2, team3])
      .mockReturnValueOnce([team2, team3]);
    mockDb.updateTeamSilent.mockReturnValue(undefined);
    mockDb.insertTransition.mockReturnValue(undefined);

    // All teams unblocked
    mockFetchDependenciesForIssue.mockResolvedValue({
      issueNumber: 0,
      blockedBy: [],
      resolved: true,
      openCount: 0,
    });

    await tm.processQueue(1);
    await new Promise((resolve) => setImmediate(resolve));

    // Only 1 slot available, so only team1 should be launched
    expect(launchQueuedSpy).toHaveBeenCalledTimes(1);
    expect(launchQueuedSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 101 }));
  });

  it('skips blocked teams and fills slots with unblocked teams further in queue', async () => {
    const project = makeProject({ id: 1, maxActiveTeams: 3 });
    const blockedTeam = makeTeam({ id: 101, issueNumber: 10, worktreeName: 'proj-10', status: 'queued' });
    const unblockedTeam1 = makeTeam({ id: 102, issueNumber: 20, worktreeName: 'proj-20', status: 'queued' });
    const unblockedTeam2 = makeTeam({ id: 103, issueNumber: 30, worktreeName: 'proj-30', status: 'queued' });

    mockDb.getProject.mockReturnValue(project);
    mockDb.getActiveTeamCountByProject
      .mockReturnValueOnce(1)  // 1 active, max 3 => 2 available
      .mockReturnValueOnce(3); // finally: no more slots
    mockDb.getQueuedTeamsByProject
      .mockReturnValueOnce([blockedTeam, unblockedTeam1, unblockedTeam2])
      .mockReturnValueOnce([blockedTeam]); // finally: blocked team still queued
    mockDb.updateTeamSilent.mockReturnValue(undefined);
    mockDb.insertTransition.mockReturnValue(undefined);

    mockFetchDependenciesForIssue.mockImplementation(async (_projectId: number, issueNumber: number) => {
      if (issueNumber === 10) {
        return {
          issueNumber: 10,
          blockedBy: [{ number: 5, owner: 'o', repo: 'r', state: 'open', title: 'Blocker' }],
          resolved: false,
          openCount: 1,
        };
      }
      return { issueNumber, blockedBy: [], resolved: true, openCount: 0 };
    });

    await tm.processQueue(1);
    await new Promise((resolve) => setImmediate(resolve));

    // blockedTeam skipped, unblockedTeam1 and unblockedTeam2 launched
    expect(launchQueuedSpy).toHaveBeenCalledTimes(2);
    expect(launchQueuedSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 102 }));
    expect(launchQueuedSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 103 }));
    expect(mockTrackBlockedIssue).toHaveBeenCalledWith(1, 10, [5]);
  });

  it('tracks multiple open blockers for a single team', async () => {
    const project = makeProject({ id: 1, maxActiveTeams: 2 });
    const blockedTeam = makeTeam({ id: 101, issueNumber: 10, worktreeName: 'proj-10', status: 'queued' });

    mockDb.getProject.mockReturnValue(project);
    mockDb.getActiveTeamCountByProject
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0);
    mockDb.getQueuedTeamsByProject
      .mockReturnValueOnce([blockedTeam])
      .mockReturnValueOnce([blockedTeam]);
    mockDb.updateTeamSilent.mockReturnValue(undefined);
    mockDb.insertTransition.mockReturnValue(undefined);

    mockFetchDependenciesForIssue.mockResolvedValue({
      issueNumber: 10,
      blockedBy: [
        { number: 5, owner: 'o', repo: 'r', state: 'open', title: 'A' },
        { number: 8, owner: 'o', repo: 'r', state: 'closed', title: 'B' },
        { number: 12, owner: 'o', repo: 'r', state: 'open', title: 'C' },
      ],
      resolved: false,
      openCount: 2,
    });

    await tm.processQueue(1);
    await new Promise((resolve) => setImmediate(resolve));

    // Should not launch the blocked team
    expect(launchQueuedSpy).not.toHaveBeenCalled();

    // Should track only the open blockers (5 and 12, not 8 which is closed)
    expect(mockTrackBlockedIssue).toHaveBeenCalledWith(1, 10, [5, 12]);
  });

  it('skips queued team with open blockedByJson and launches it after deps resolve', async () => {
    const project = makeProject({ id: 1, maxActiveTeams: 3 });
    const team = makeTeam({
      id: 101,
      issueNumber: 10,
      worktreeName: 'proj-10',
      status: 'queued',
    });

    mockDb.getProject.mockReturnValue(project);

    // --- First processQueue call: deps unresolved => team skipped ---
    mockDb.getActiveTeamCountByProject
      .mockReturnValueOnce(0)   // processQueue: 0 active
      .mockReturnValueOnce(0);  // finally: re-drain check
    mockDb.getQueuedTeamsByProject
      .mockReturnValueOnce([team])  // processQueue: 1 queued team
      .mockReturnValueOnce([team]); // finally: still queued (was skipped)
    mockDb.updateTeamSilent.mockReturnValue(undefined);
    mockDb.insertTransition.mockReturnValue(undefined);

    mockFetchDependenciesForIssue.mockResolvedValueOnce({
      issueNumber: 10,
      blockedBy: [{ number: 5, owner: 'o', repo: 'r', state: 'open', title: 'Blocker' }],
      resolved: false,
      openCount: 1,
    });

    await tm.processQueue(1);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // Should not have launched yet
    expect(launchQueuedSpy).not.toHaveBeenCalled();
    expect(mockTrackBlockedIssue).toHaveBeenCalledWith(1, 10, [5]);

    // --- Second processQueue call: deps now resolved => team launches ---
    vi.clearAllMocks();
    launchQueuedSpy = vi.fn().mockResolvedValue(undefined);
    (tm as any).launchQueued = launchQueuedSpy;

    mockDb.getProject.mockReturnValue(project);
    mockDb.getActiveTeamCountByProject
      .mockReturnValueOnce(0)   // processQueue: 0 active
      .mockReturnValueOnce(1);  // finally: re-drain check
    mockDb.getQueuedTeamsByProject
      .mockReturnValueOnce([team])  // processQueue: team still queued
      .mockReturnValueOnce([]);     // finally: no more queued
    mockDb.updateTeamSilent.mockReturnValue(undefined);
    mockDb.insertTransition.mockReturnValue(undefined);

    mockFetchDependenciesForIssue.mockResolvedValueOnce({
      issueNumber: 10,
      blockedBy: [{ number: 5, owner: 'o', repo: 'r', state: 'closed', title: 'Blocker' }],
      resolved: true,
      openCount: 0,
    });

    await tm.processQueue(1);
    await new Promise((resolve) => setImmediate(resolve));

    // Now the team should be launched
    expect(launchQueuedSpy).toHaveBeenCalledTimes(1);
    expect(launchQueuedSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 101 }));
  });
});
