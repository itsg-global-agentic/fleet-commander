// =============================================================================
// Fleet Commander — TeamManager.processQueue re-drain race condition test
// =============================================================================
// Verifies that when two concurrent processQueue calls hit the guard,
// the dropped call's work is picked up by the re-drain in the finally block.
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

    mockDb.updateTeam.mockReturnValue(undefined);
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
    mockDb.updateTeam.mockReturnValue(undefined);
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
    mockDb.updateTeam.mockReturnValue(undefined);
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
    mockDb.updateTeam.mockReturnValue(undefined);
    mockDb.insertTransition.mockReturnValue(undefined);

    // Start processQueue — it will block on launchQueued (called but awaiting)
    const firstCall = tm.processQueue(1);

    // launchQueued was invoked synchronously before the await pauses execution
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
