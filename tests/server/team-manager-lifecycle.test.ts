// =============================================================================
// Fleet Commander — TeamManager Lifecycle Tests (stop, stopAll, sendMessage,
// process exit, gracefulShutdown)
// =============================================================================
// Tests for stop(), stopAll(), sendMessage(), attachProcessHandlers
// exit/error handling, and gracefulShutdown. Does NOT duplicate queue/env
// tests from other files.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { EventEmitter } from 'events';
import type { Writable } from 'stream';
import type { Team } from '../../src/shared/types.js';
import { CircularBuffer } from '../../src/server/utils/circular-buffer.js';

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted ensures these are available when vi.mock factories run
// ---------------------------------------------------------------------------

const mockDb = vi.hoisted(() => ({
  getProject: vi.fn(),
  getTeam: vi.fn(),
  getActiveTeams: vi.fn().mockReturnValue([]),
  getActiveTeamCountByProject: vi.fn().mockReturnValue(0),
  getQueuedTeamsByProject: vi.fn().mockReturnValue([]),
  updateTeam: vi.fn(),
  updateTeamSilent: vi.fn(),
  insertTransition: vi.fn(),
  getPullRequest: vi.fn(),
  insertEvent: vi.fn(),
}));

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
    mergeShutdownGraceMs: 120000,
    fleetCommanderRoot: '/tmp/fleet',
    mapCleanupIntervalMs: 3600000,
  },
}));

const mockSseBroker = vi.hoisted(() => ({
  broadcast: vi.fn(),
  getSnapshot: vi.fn().mockReturnValue([]),
}));
vi.mock('../../src/server/services/sse-broker.js', () => ({
  sseBroker: mockSseBroker,
}));

vi.mock('../../src/server/utils/find-git-bash.js', () => ({
  findGitBash: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/server/utils/resolve-message.js', () => ({
  resolveMessage: vi.fn().mockReturnValue('Shutdown message for PR'),
}));

vi.mock('../../src/server/services/usage-tracker.js', () => ({
  getUsageZone: vi.fn().mockReturnValue('green'),
}));

vi.mock('../../src/server/utils/resolve-claude-path.js', () => ({
  resolveClaudePath: vi.fn().mockReturnValue('claude'),
}));

vi.mock('../../src/server/services/issue-fetcher.js', () => ({
  getIssueFetcher: () => ({
    fetchDependenciesForIssue: vi.fn().mockResolvedValue({
      issueNumber: 0, blockedBy: [], resolved: true, openCount: 0,
    }),
  }),
  detectCircularDependencies: vi.fn().mockReturnValue(null),
}));

const mockGithubPoller = vi.hoisted(() => ({
  trackBlockedIssue: vi.fn(),
  reconcilePR: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/server/services/github-poller.js', () => ({
  githubPoller: mockGithubPoller,
}));

vi.mock('../../src/server/services/issue-context-generator.js', () => ({
  generateIssueContext: vi.fn().mockResolvedValue(undefined),
}));

import { TeamManager } from '../../src/server/services/team-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTeam(overrides?: Partial<Team>): Team {
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
    prNumber: null,
    customPrompt: null,
    headless: true,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalCostUsd: 0,
    launchedAt: new Date().toISOString(),
    stoppedAt: null,
    lastEventAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockStdin(): Writable & { write: Mock; end: Mock; destroyed: boolean } {
  return {
    write: vi.fn().mockReturnValue(true),
    end: vi.fn(),
    destroyed: false,
  } as unknown as Writable & { write: Mock; end: Mock; destroyed: boolean };
}

function createMockChildProcess() {
  const child = new EventEmitter();
  (child as any).stdin = createMockStdin();
  (child as any).stdout = new EventEmitter();
  (child as any).stderr = new EventEmitter();
  (child as any).pid = 99999;
  return child;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TeamManager.stop', () => {
  let tm: TeamManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    tm = new TeamManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws when team not found', async () => {
    mockDb.getTeam.mockReturnValue(undefined);

    await expect(tm.stop(999)).rejects.toThrow('Team 999 not found');
  });

  it('cancels a queued team by marking it failed', async () => {
    const team = makeTeam({ id: 1, status: 'queued', pid: null });
    mockDb.getTeam.mockReturnValue(team);

    await tm.stop(1);

    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        fromStatus: 'queued',
        toStatus: 'failed',
        trigger: 'pm_action',
      }),
    );
    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('sends stdin EOF for graceful shutdown of running team', async () => {
    const team = makeTeam({ id: 1, status: 'running', pid: 12345 });
    const mockStdin = createMockStdin();

    (tm as any).stdinPipes.set(1, mockStdin);
    (tm as any).childProcesses.set(1, createMockChildProcess());

    mockDb.getTeam
      .mockReturnValueOnce(team)
      .mockReturnValueOnce({ ...team, pid: 12345 })
      .mockReturnValueOnce({ ...team, status: 'running' })
      .mockReturnValueOnce(team);
    mockDb.updateTeam.mockReturnValue(team);

    // stop() has a 5s setTimeout inside — advance fake timers to avoid timeout
    const stopPromise = tm.stop(1);
    await vi.advanceTimersByTimeAsync(6000);
    await stopPromise;

    expect(mockStdin.end).toHaveBeenCalled();
  });

  it('broadcasts team_stopped SSE event after stop', async () => {
    const team = makeTeam({ id: 1, status: 'running', pid: 12345 });

    (tm as any).stdinPipes.set(1, createMockStdin());
    (tm as any).childProcesses.set(1, createMockChildProcess());

    mockDb.getTeam.mockReturnValue(team);
    mockDb.updateTeam.mockReturnValue(team);

    const stopPromise = tm.stop(1);
    await vi.advanceTimersByTimeAsync(6000);
    await stopPromise;

    expect(mockSseBroker.broadcast).toHaveBeenCalledWith(
      'team_stopped',
      { team_id: 1 },
      1,
    );
  });

  it('should not overwrite done status when process exits cleanly during grace period', async () => {
    const team = makeTeam({ id: 1, status: 'running', pid: 12345 });
    const mockStdin = createMockStdin();
    const child = createMockChildProcess();

    (tm as any).stdinPipes.set(1, mockStdin);
    (tm as any).childProcesses.set(1, child);

    // First call: initial team lookup (running)
    // Second call: after grace period, freshTeam for killProcess (pid gone)
    // Third call: stopTeam re-read shows 'done' (exit handler ran)
    // Fourth call: final return
    mockDb.getTeam
      .mockReturnValueOnce(team)                                    // initial
      .mockReturnValueOnce({ ...team, pid: null, status: 'done' }) // freshTeam
      .mockReturnValueOnce({ ...team, pid: null, status: 'done' }) // stopTeam
      .mockReturnValueOnce({ ...team, pid: null, status: 'done' }); // return

    const stopPromise = tm.stop(1);

    // Simulate process exiting immediately (triggers early resolve of the sleep)
    child.emit('exit', 0, null);

    await vi.advanceTimersByTimeAsync(1000);
    await stopPromise;

    // insertTransition should NOT have been called with 'failed'
    // because stopTeam.status was already 'done'
    expect(mockDb.insertTransition).not.toHaveBeenCalled();
    // updateTeamSilent should NOT have been called to overwrite done with failed
    expect(mockDb.updateTeamSilent).not.toHaveBeenCalled();
    expect(mockDb.updateTeam).not.toHaveBeenCalled();
  });

  it('should resolve the 5s grace period early when process exits', async () => {
    const team = makeTeam({ id: 1, status: 'running', pid: 12345 });
    const mockStdin = createMockStdin();
    const child = createMockChildProcess();

    (tm as any).stdinPipes.set(1, mockStdin);
    (tm as any).childProcesses.set(1, child);

    mockDb.getTeam.mockReturnValue(team);

    const stopPromise = tm.stop(1);

    // Emit exit immediately — should cancel the 5s timer
    child.emit('exit', 0, null);

    // Advance only 100ms — if the race works, stop() should already resolve
    await vi.advanceTimersByTimeAsync(100);
    await stopPromise;

    // stop() completed without needing the full 5000ms
    expect(mockStdin.end).toHaveBeenCalled();
  });
});

// =============================================================================
// stopAll
// =============================================================================

describe('TeamManager.stopAll', () => {
  let tm: TeamManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    tm = new TeamManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should stop teams in parallel, not sequentially', async () => {
    // Create 3 active teams, each with a stdin pipe and child process
    const teams = [1, 2, 3].map(id => {
      const team = makeTeam({ id, status: 'running', pid: 10000 + id });
      const mockStdin = createMockStdin();
      (tm as any).stdinPipes.set(id, mockStdin);
      (tm as any).childProcesses.set(id, createMockChildProcess());
      return team;
    });

    mockDb.getActiveTeams.mockReturnValue(teams);
    mockDb.getTeam.mockImplementation((id: number) =>
      teams.find(t => t.id === id),
    );
    mockDb.updateTeam.mockImplementation((id: number) =>
      teams.find(t => t.id === id),
    );

    const stopAllPromise = tm.stopAll();

    // Advance past the 5-second graceful shutdown timeout for all teams.
    // If stopAll were sequential, we'd need 3 * 5s = 15s.
    // With parallel execution, 6s is enough for all.
    await vi.advanceTimersByTimeAsync(6000);
    const results = await stopAllPromise;

    expect(results).toHaveLength(3);
  });

  it('should return empty array when no active teams', async () => {
    mockDb.getActiveTeams.mockReturnValue([]);

    const results = await tm.stopAll();

    expect(results).toEqual([]);
  });

  it('should use fallback team on stop failure', async () => {
    const team = makeTeam({ id: 1, status: 'running', pid: 12345 });
    mockDb.getActiveTeams.mockReturnValue([team]);
    // getTeam returns undefined, causing stop() to throw "Team X not found"
    mockDb.getTeam.mockReturnValue(undefined);

    const results = await tm.stopAll();

    // The rejected promise falls back to the original team object
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(1);
  });
});

// =============================================================================
// sendMessage
// =============================================================================

describe('TeamManager.sendMessage', () => {
  let tm: TeamManager;

  beforeEach(() => {
    vi.clearAllMocks();
    tm = new TeamManager();
  });

  it('returns false when no stdin pipe exists', () => {
    const result = tm.sendMessage(1, 'hello');
    expect(result).toBe(false);
  });

  it('returns false when stdin is destroyed', () => {
    const mockStdin = createMockStdin();
    mockStdin.destroyed = true;
    (tm as any).stdinPipes.set(1, mockStdin);

    const result = tm.sendMessage(1, 'hello');
    expect(result).toBe(false);
  });

  it('writes a stream-json message to stdin and returns true', () => {
    const mockStdin = createMockStdin();
    (tm as any).stdinPipes.set(1, mockStdin);
    (tm as any).parsedEvents.set(1, new CircularBuffer<unknown>(1000));

    const result = tm.sendMessage(1, 'Fix the tests');
    expect(result).toBe(true);
    expect(mockStdin.write).toHaveBeenCalledTimes(1);

    const written = mockStdin.write.mock.calls[0]![0] as string;
    const parsed = JSON.parse(written.trimEnd());
    expect(parsed.type).toBe('user');
    expect(parsed.message.content).toBe('Fix the tests');
  });

  it('injects synthetic event into parsedEvents for session log', () => {
    const mockStdin = createMockStdin();
    (tm as any).stdinPipes.set(1, mockStdin);
    const buf = new CircularBuffer<unknown>(1000);
    (tm as any).parsedEvents.set(1, buf);

    tm.sendMessage(1, 'Check status', 'user');

    expect(buf.length).toBe(1);
    const event = buf.toArray()[0] as Record<string, unknown>;
    expect(event.type).toBe('user');
    expect(event.agentName).toBe('__pm__');
  });

  it('tags FC messages with __fc__ agent name and subtype', () => {
    const mockStdin = createMockStdin();
    (tm as any).stdinPipes.set(1, mockStdin);
    const buf = new CircularBuffer<unknown>(1000);
    (tm as any).parsedEvents.set(1, buf);

    tm.sendMessage(1, 'CI passed', 'fc', 'ci_green');

    expect(buf.length).toBe(1);
    const event = buf.toArray()[0] as Record<string, unknown>;
    expect(event.type).toBe('fc');
    expect(event.agentName).toBe('__fc__');
    expect(event.subtype).toBe('ci_green');
  });

  it('broadcasts team_output SSE event for the message', () => {
    const mockStdin = createMockStdin();
    (tm as any).stdinPipes.set(1, mockStdin);
    (tm as any).parsedEvents.set(1, new CircularBuffer<unknown>(1000));

    tm.sendMessage(1, 'Hello team');

    expect(mockSseBroker.broadcast).toHaveBeenCalledWith(
      'team_output',
      expect.objectContaining({ team_id: 1 }),
      1,
    );
  });

  it('returns false and does not throw when stdin.write throws', () => {
    const mockStdin = createMockStdin();
    mockStdin.write.mockImplementation(() => {
      throw new Error('Broken pipe');
    });
    (tm as any).stdinPipes.set(1, mockStdin);

    const result = tm.sendMessage(1, 'test');
    expect(result).toBe(false);
  });
});

// =============================================================================
// attachProcessHandlers — process exit
// =============================================================================

describe('TeamManager.attachProcessHandlers (exit)', () => {
  let tm: TeamManager;

  // Flush the async exit-handler microtasks AND the dynamic `import()` for
  // github-poller. handleProcessExit() awaits one dynamic import + one
  // reconcilePR() call, so we need a few ticks of setImmediate to let them
  // resolve before asserting DB state.
  async function flushExit(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  function setupTeamMaps(teamId: number, child: ReturnType<typeof createMockChildProcess>): void {
    (tm as any).childProcesses.set(teamId, child);
    (tm as any).outputBuffers.set(teamId, new CircularBuffer<string>(500));
    (tm as any).parsedEvents.set(teamId, new CircularBuffer<unknown>(1000));
    (tm as any).tokenCounters.set(teamId, {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGithubPoller.reconcilePR.mockResolvedValue(undefined);
    tm = new TeamManager();
  });

  it('marks team done on exit code 0 (no PR)', async () => {
    const child = createMockChildProcess();
    const team = makeTeam({ id: 1, status: 'running', prNumber: null });
    setupTeamMaps(1, child);

    mockDb.getTeam.mockReturnValue(team);

    (tm as any).attachProcessHandlers(1, child);
    child.emit('exit', 0, null);
    await flushExit();

    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        fromStatus: 'running',
        toStatus: 'done',
        trigger: 'system',
        reason: expect.stringContaining('code 0'),
      }),
    );
    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'done', pid: null }),
    );
    // No PR → no forced reconcile
    expect(mockGithubPoller.reconcilePR).not.toHaveBeenCalled();
  });

  it('marks team failed on non-zero exit code', async () => {
    const child = createMockChildProcess();
    const team = makeTeam({ id: 1, status: 'running' });
    setupTeamMaps(1, child);

    mockDb.getTeam.mockReturnValue(team);

    (tm as any).attachProcessHandlers(1, child);
    child.emit('exit', 1, null);
    await flushExit();

    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        fromStatus: 'running',
        toStatus: 'failed',
        trigger: 'system',
        reason: expect.stringContaining('code 1'),
      }),
    );
    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'failed', pid: null }),
    );
    // Non-zero exit skips forced reconcile entirely
    expect(mockGithubPoller.reconcilePR).not.toHaveBeenCalled();
  });

  it('includes signal in reason when process exits with signal', async () => {
    const child = createMockChildProcess();
    const team = makeTeam({ id: 1, status: 'running' });
    setupTeamMaps(1, child);

    mockDb.getTeam.mockReturnValue(team);

    (tm as any).attachProcessHandlers(1, child);
    child.emit('exit', null, 'SIGTERM');
    await flushExit();

    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        fromStatus: 'running',
        toStatus: 'failed',
        reason: expect.stringContaining('SIGTERM'),
      }),
    );
  });

  it('does nothing when team is already done or failed', async () => {
    const child = createMockChildProcess();
    const team = makeTeam({ id: 1, status: 'done' });
    setupTeamMaps(1, child);

    mockDb.getTeam.mockReturnValue(team);

    (tm as any).attachProcessHandlers(1, child);
    child.emit('exit', 0, null);
    await flushExit();

    expect(mockDb.insertTransition).not.toHaveBeenCalled();
  });

  it('broadcasts team_stopped on clean process exit with no PR', async () => {
    const child = createMockChildProcess();
    const team = makeTeam({ id: 1, status: 'running', prNumber: null });
    setupTeamMaps(1, child);

    mockDb.getTeam.mockReturnValue(team);

    (tm as any).attachProcessHandlers(1, child);
    child.emit('exit', 0, null);
    await flushExit();

    expect(mockSseBroker.broadcast).toHaveBeenCalledWith(
      'team_stopped',
      { team_id: 1 },
      1,
    );
  });

  it('does not throw when team not found in DB on exit', async () => {
    const child = createMockChildProcess();
    setupTeamMaps(1, child);

    mockDb.getTeam.mockReturnValue(undefined);

    (tm as any).attachProcessHandlers(1, child);

    expect(() => child.emit('exit', 0, null)).not.toThrow();
    await flushExit();
  });

  // =========================================================================
  // Issue #701 — merge-claim cross-check
  // =========================================================================

  it('rejects done transition when TL claims merge but PR is still open', async () => {
    const child = createMockChildProcess();
    const team = makeTeam({ id: 1, status: 'running', prNumber: 42 });
    setupTeamMaps(1, child);

    // Inject a fake assistant event claiming the PR was merged into
    // parsedEvents BEFORE emitting exit. handleProcessExit snapshots the
    // buffer before purgeTeamMaps clears it.
    const events = (tm as any).parsedEvents.get(1) as CircularBuffer<any>;
    events.push({
      type: 'assistant',
      agentName: 'team-lead',
      message: {
        content: [
          { type: 'text', text: 'PR #42 merged, issue #10 closed. Team done.' },
        ],
      },
    });

    // Stdin pipe so verification_required delivery attempt is exercised.
    const mockStdin = createMockStdin();
    (tm as any).stdinPipes.set(1, mockStdin);

    mockDb.getTeam.mockReturnValue(team);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 42,
      teamId: 1,
      title: null,
      state: 'open',
      mergeStatus: 'blocked_ci_pending',
      ciStatus: 'pending',
      ciFailCount: 0,
      checksJson: null,
      autoMerge: false,
      mergedAt: null,
      baseRefName: 'main',
      updatedAt: new Date().toISOString(),
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    (tm as any).attachProcessHandlers(1, child);
    child.emit('exit', 0, null);
    await flushExit();

    // Forced reconcile MUST have been awaited before the decision
    expect(mockGithubPoller.reconcilePR).toHaveBeenCalledWith(1);
    expect(mockDb.getPullRequest).toHaveBeenCalledWith(42);

    // Transition recorded with from==to==running (stay put)
    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        fromStatus: 'running',
        toStatus: 'running',
        trigger: 'system',
        reason: expect.stringContaining('Done transition rejected'),
      }),
    );
    // pid cleared so PM can see the anomaly
    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(1, { pid: null });
    // Critically: team was NOT marked done
    expect(mockDb.updateTeamSilent).not.toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'done' }),
    );
    // team_stopped NOT broadcast (slot still occupied)
    expect(mockSseBroker.broadcast).not.toHaveBeenCalledWith(
      'team_stopped',
      expect.anything(),
      expect.anything(),
    );
    // Warning logged with both the TL claim and the poller truth
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('REJECTING done transition'),
    );
    expect(warnSpy.mock.calls[0]![0]).toContain('PR #42');
    expect(warnSpy.mock.calls[0]![0]).toContain('state=open');

    warnSpy.mockRestore();
  });

  it('accepts done transition with stale poller data (reconcile lag)', async () => {
    const child = createMockChildProcess();
    const team = makeTeam({ id: 1, status: 'running', prNumber: 43 });
    setupTeamMaps(1, child);

    // Clean shutdown — no merge language in the TL text
    const events = (tm as any).parsedEvents.get(1) as CircularBuffer<any>;
    events.push({
      type: 'assistant',
      agentName: 'team-lead',
      message: {
        content: [
          { type: 'text', text: 'All phases complete. Shutting down.' },
        ],
      },
    });

    mockDb.getTeam.mockReturnValue(team);

    // Simulate reconcilePR refreshing the PR row. Before reconcile: no row;
    // after reconcile: state=merged. We flip the mock during the call.
    mockDb.getPullRequest.mockReturnValueOnce(undefined);
    mockGithubPoller.reconcilePR.mockImplementation(async () => {
      // Stale poller caught up — PR row is now "merged"
      mockDb.getPullRequest.mockReturnValue({
        prNumber: 43,
        teamId: 1,
        title: null,
        state: 'merged',
        mergeStatus: 'clean',
        ciStatus: 'passing',
        ciFailCount: 0,
        checksJson: null,
        autoMerge: true,
        mergedAt: new Date().toISOString(),
        baseRefName: 'main',
        updatedAt: new Date().toISOString(),
      });
    });

    (tm as any).attachProcessHandlers(1, child);
    child.emit('exit', 0, null);
    await flushExit();

    // Forced reconcile ran
    expect(mockGithubPoller.reconcilePR).toHaveBeenCalledWith(1);

    // Team transitioned to done
    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        fromStatus: 'running',
        toStatus: 'done',
        trigger: 'system',
      }),
    );
    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'done', pid: null }),
    );
    expect(mockSseBroker.broadcast).toHaveBeenCalledWith(
      'team_stopped',
      { team_id: 1 },
      1,
    );
  });

  it('accepts done transition on happy path (PR merged + matching reason)', async () => {
    const child = createMockChildProcess();
    const team = makeTeam({ id: 1, status: 'running', prNumber: 44 });
    setupTeamMaps(1, child);

    const events = (tm as any).parsedEvents.get(1) as CircularBuffer<any>;
    events.push({
      type: 'assistant',
      agentName: 'team-lead',
      message: {
        content: [
          { type: 'text', text: 'PR #44 merged. Closing issue and exiting.' },
        ],
      },
    });

    mockDb.getTeam.mockReturnValue(team);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 44,
      teamId: 1,
      title: null,
      state: 'merged',
      mergeStatus: 'clean',
      ciStatus: 'passing',
      ciFailCount: 0,
      checksJson: null,
      autoMerge: true,
      mergedAt: new Date().toISOString(),
      baseRefName: 'main',
      updatedAt: new Date().toISOString(),
    });

    (tm as any).attachProcessHandlers(1, child);
    child.emit('exit', 0, null);
    await flushExit();

    // Forced reconcile ran
    expect(mockGithubPoller.reconcilePR).toHaveBeenCalledWith(1);

    // Transitioned to done normally
    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        fromStatus: 'running',
        toStatus: 'done',
      }),
    );
    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'done', pid: null }),
    );
    expect(mockSseBroker.broadcast).toHaveBeenCalledWith(
      'team_stopped',
      { team_id: 1 },
      1,
    );
  });

  it('accepts done transition when PR is open but reason has no merge claim', async () => {
    const child = createMockChildProcess();
    const team = makeTeam({ id: 1, status: 'running', prNumber: 45 });
    setupTeamMaps(1, child);

    // PM-triggered manual stop, no merge language
    const events = (tm as any).parsedEvents.get(1) as CircularBuffer<any>;
    events.push({
      type: 'assistant',
      agentName: 'team-lead',
      message: {
        content: [{ type: 'text', text: 'Stopping per PM request. Goodbye.' }],
      },
    });

    mockDb.getTeam.mockReturnValue(team);
    mockDb.getPullRequest.mockReturnValue({
      prNumber: 45,
      teamId: 1,
      title: null,
      state: 'open',
      mergeStatus: 'clean',
      ciStatus: 'passing',
      ciFailCount: 0,
      checksJson: null,
      autoMerge: false,
      mergedAt: null,
      baseRefName: 'main',
      updatedAt: new Date().toISOString(),
    });

    (tm as any).attachProcessHandlers(1, child);
    child.emit('exit', 0, null);
    await flushExit();

    // Accepted
    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'done' }),
    );
  });
});

// =============================================================================
// attachProcessHandlers — process error
// =============================================================================

describe('TeamManager.attachProcessHandlers (error)', () => {
  let tm: TeamManager;

  beforeEach(() => {
    vi.clearAllMocks();
    tm = new TeamManager();
  });

  it('marks team failed on process error', () => {
    const child = createMockChildProcess();
    const team = makeTeam({ id: 1, status: 'running' });

    (tm as any).childProcesses.set(1, child);
    (tm as any).outputBuffers.set(1, new CircularBuffer<string>(500));
    (tm as any).parsedEvents.set(1, new CircularBuffer<unknown>(1000));
    (tm as any).tokenCounters.set(1, { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0 });

    mockDb.getTeam.mockReturnValue(team);

    (tm as any).attachProcessHandlers(1, child);

    child.emit('error', new Error('ENOENT'));

    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        fromStatus: 'running',
        toStatus: 'failed',
        trigger: 'system',
        reason: expect.stringContaining('ENOENT'),
      }),
    );
    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'failed', pid: null }),
    );
  });

  it('cleans up internal maps on process error', () => {
    const child = createMockChildProcess();
    const team = makeTeam({ id: 1, status: 'running' });

    (tm as any).childProcesses.set(1, child);
    (tm as any).outputBuffers.set(1, new CircularBuffer<string>(500));
    (tm as any).parsedEvents.set(1, new CircularBuffer<unknown>(1000));
    (tm as any).stdinPipes.set(1, createMockStdin());
    (tm as any).tokenCounters.set(1, { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0 });

    mockDb.getTeam.mockReturnValue(team);

    (tm as any).attachProcessHandlers(1, child);

    child.emit('error', new Error('spawn error'));

    expect((tm as any).childProcesses.has(1)).toBe(false);
    expect((tm as any).stdinPipes.has(1)).toBe(false);
    expect((tm as any).outputBuffers.has(1)).toBe(false);
    expect((tm as any).parsedEvents.has(1)).toBe(false);
  });
});

// =============================================================================
// gracefulShutdown
// =============================================================================

describe('TeamManager.gracefulShutdown', () => {
  let tm: TeamManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    tm = new TeamManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends pr_merged_shutdown message via stdin', () => {
    const mockStdin = createMockStdin();
    (tm as any).stdinPipes.set(1, mockStdin);
    (tm as any).parsedEvents.set(1, new CircularBuffer<unknown>(1000));

    tm.gracefulShutdown(1, 42, 120000);

    expect(mockStdin.write).toHaveBeenCalled();
  });

  it('clears existing shutdown timer before setting new one', () => {
    const mockStdin = createMockStdin();
    (tm as any).stdinPipes.set(1, mockStdin);
    (tm as any).parsedEvents.set(1, new CircularBuffer<unknown>(1000));

    tm.gracefulShutdown(1, 42, 120000);
    tm.gracefulShutdown(1, 43, 60000);

    expect((tm as any).shutdownTimers.size).toBe(1);
  });

  it('should store killTimer in shutdownTimers after grace period expires', () => {
    const mockStdin = createMockStdin();
    (tm as any).stdinPipes.set(1, mockStdin);
    (tm as any).parsedEvents.set(1, []);
    (tm as any).childProcesses.set(1, createMockChildProcess());

    tm.gracefulShutdown(1, 42, 5000);

    // graceTimer is stored immediately
    expect((tm as any).shutdownTimers.has(1)).toBe(true);
    const graceTimerRef = (tm as any).shutdownTimers.get(1);

    // Advance past grace period — graceTimer fires, killTimer is created
    vi.advanceTimersByTime(5000);

    // killTimer should now be stored in shutdownTimers
    expect((tm as any).shutdownTimers.has(1)).toBe(true);
    expect((tm as any).shutdownTimers.size).toBe(1);
    // Verify it is a different timer (the killTimer, not the graceTimer)
    expect((tm as any).shutdownTimers.get(1)).not.toBe(graceTimerRef);

    // purgeTeamMaps should cancel the killTimer
    (tm as any).purgeTeamMaps(1);
    expect((tm as any).shutdownTimers.has(1)).toBe(false);

    // Advance past kill window — force kill should NOT fire (timer was cancelled)
    vi.advanceTimersByTime(10_000);
    // If killTimer had fired, it would call killProcess and broadcast team_stopped.
    // Since we purged, neither should happen.
    expect(mockSseBroker.broadcast).not.toHaveBeenCalledWith(
      'team_stopped',
      expect.objectContaining({ team_id: 1 }),
      1,
    );
  });

  it('should allow stop() to cancel the killTimer during the kill window', async () => {
    const mockStdin = createMockStdin();
    (tm as any).stdinPipes.set(1, mockStdin);
    (tm as any).parsedEvents.set(1, []);
    (tm as any).childProcesses.set(1, createMockChildProcess());
    mockDb.getTeam.mockReturnValue(makeTeam({ id: 1, pid: 12345 }));

    tm.gracefulShutdown(1, 42, 5000);

    // Advance past grace period — killTimer is created and stored
    vi.advanceTimersByTime(5000);
    expect((tm as any).shutdownTimers.has(1)).toBe(true);

    // stop() should clear the killTimer from shutdownTimers
    await tm.stop(1);
    expect((tm as any).shutdownTimers.has(1)).toBe(false);

    // Clear all mock calls so we can isolate what happens after stop()
    mockSseBroker.broadcast.mockClear();

    // Advance past kill window — force kill should NOT fire (no additional broadcast)
    vi.advanceTimersByTime(10_000);
    expect(mockSseBroker.broadcast).not.toHaveBeenCalledWith(
      'team_stopped',
      expect.objectContaining({ team_id: 1 }),
      1,
    );
  });
});

// =============================================================================
// purgeTeamMaps
// =============================================================================

describe('TeamManager.purgeTeamMaps', () => {
  let tm: TeamManager;

  beforeEach(() => {
    vi.clearAllMocks();
    tm = new TeamManager();
  });

  it('should delete entries from all per-team maps', () => {
    const teamId = 1;

    // Populate all maps
    (tm as any).outputBuffers.set(teamId, new CircularBuffer<string>(10));
    (tm as any).childProcesses.set(teamId, createMockChildProcess());
    (tm as any).stdinPipes.set(teamId, createMockStdin());
    (tm as any).parsedEvents.set(teamId, new CircularBuffer<unknown>(1000));
    (tm as any).tokenCounters.set(teamId, { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0 });
    (tm as any).agentMaps.set(teamId, new Map());
    (tm as any).lastStreamAt.set(teamId, Date.now());
    (tm as any).thinkingTeams.add(teamId);
    (tm as any).thinkingStartTimes.set(teamId, Date.now());
    (tm as any).thinkingBlockIndex.set(teamId, 0);

    (tm as any).purgeTeamMaps(teamId);

    expect((tm as any).outputBuffers.has(teamId)).toBe(false);
    expect((tm as any).childProcesses.has(teamId)).toBe(false);
    expect((tm as any).stdinPipes.has(teamId)).toBe(false);
    expect((tm as any).parsedEvents.has(teamId)).toBe(false);
    expect((tm as any).tokenCounters.has(teamId)).toBe(false);
    expect((tm as any).agentMaps.has(teamId)).toBe(false);
    expect((tm as any).lastStreamAt.has(teamId)).toBe(false);
    expect((tm as any).thinkingTeams.has(teamId)).toBe(false);
    expect((tm as any).thinkingStartTimes.has(teamId)).toBe(false);
    expect((tm as any).thinkingBlockIndex.has(teamId)).toBe(false);
  });

  it('should clear shutdown timer before deleting it', () => {
    const teamId = 1;
    const timer = setTimeout(() => {}, 100000);
    (tm as any).shutdownTimers.set(teamId, timer);

    (tm as any).purgeTeamMaps(teamId);

    expect((tm as any).shutdownTimers.has(teamId)).toBe(false);
  });

  it('should be idempotent — calling twice does not throw', () => {
    const teamId = 1;
    (tm as any).outputBuffers.set(teamId, new CircularBuffer<string>(10));

    (tm as any).purgeTeamMaps(teamId);
    expect(() => (tm as any).purgeTeamMaps(teamId)).not.toThrow();
  });
});

// =============================================================================
// sweepOrphanedMaps
// =============================================================================

describe('TeamManager.sweepOrphanedMaps', () => {
  let tm: TeamManager;

  beforeEach(() => {
    vi.clearAllMocks();
    tm = new TeamManager();
  });

  it('should purge maps for teams in terminal state (done)', () => {
    const teamId = 5;
    (tm as any).outputBuffers.set(teamId, new CircularBuffer<string>(10));
    (tm as any).parsedEvents.set(teamId, new CircularBuffer<unknown>(1000));
    (tm as any).agentMaps.set(teamId, new Map());
    (tm as any).lastStreamAt.set(teamId, Date.now());

    mockDb.getTeam.mockReturnValue(makeTeam({ id: teamId, status: 'done' }));

    (tm as any).sweepOrphanedMaps();

    expect((tm as any).outputBuffers.has(teamId)).toBe(false);
    expect((tm as any).parsedEvents.has(teamId)).toBe(false);
    expect((tm as any).agentMaps.has(teamId)).toBe(false);
    expect((tm as any).lastStreamAt.has(teamId)).toBe(false);
  });

  it('should purge maps for teams in terminal state (failed)', () => {
    const teamId = 6;
    (tm as any).tokenCounters.set(teamId, { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0 });

    mockDb.getTeam.mockReturnValue(makeTeam({ id: teamId, status: 'failed' }));

    (tm as any).sweepOrphanedMaps();

    expect((tm as any).tokenCounters.has(teamId)).toBe(false);
  });

  it('should NOT purge maps for teams with active child processes', () => {
    const teamId = 7;
    const child = createMockChildProcess();
    (tm as any).childProcesses.set(teamId, child);
    (tm as any).outputBuffers.set(teamId, new CircularBuffer<string>(10));
    (tm as any).parsedEvents.set(teamId, new CircularBuffer<unknown>(1000));

    mockDb.getTeam.mockReturnValue(makeTeam({ id: teamId, status: 'failed' }));

    (tm as any).sweepOrphanedMaps();

    // Maps should still exist because the child process is active
    expect((tm as any).childProcesses.has(teamId)).toBe(true);
    expect((tm as any).outputBuffers.has(teamId)).toBe(true);
    expect((tm as any).parsedEvents.has(teamId)).toBe(true);
  });

  it('should NOT purge maps for running teams', () => {
    const teamId = 8;
    (tm as any).outputBuffers.set(teamId, new CircularBuffer<string>(10));
    (tm as any).agentMaps.set(teamId, new Map());

    mockDb.getTeam.mockReturnValue(makeTeam({ id: teamId, status: 'running' }));

    (tm as any).sweepOrphanedMaps();

    expect((tm as any).outputBuffers.has(teamId)).toBe(true);
    expect((tm as any).agentMaps.has(teamId)).toBe(true);
  });

  it('should NOT purge maps for idle or stuck teams', () => {
    const teamIdIdle = 9;
    const teamIdStuck = 10;
    (tm as any).outputBuffers.set(teamIdIdle, new CircularBuffer<string>(10));
    (tm as any).outputBuffers.set(teamIdStuck, new CircularBuffer<string>(10));

    mockDb.getTeam
      .mockReturnValueOnce(makeTeam({ id: teamIdIdle, status: 'idle' }))
      .mockReturnValueOnce(makeTeam({ id: teamIdStuck, status: 'stuck' }));

    (tm as any).sweepOrphanedMaps();

    expect((tm as any).outputBuffers.has(teamIdIdle)).toBe(true);
    expect((tm as any).outputBuffers.has(teamIdStuck)).toBe(true);
  });

  it('should purge maps for teams that no longer exist in DB', () => {
    const teamId = 11;
    (tm as any).outputBuffers.set(teamId, new CircularBuffer<string>(10));
    (tm as any).parsedEvents.set(teamId, new CircularBuffer<unknown>(1000));
    (tm as any).lastStreamAt.set(teamId, Date.now());

    mockDb.getTeam.mockReturnValue(undefined);

    (tm as any).sweepOrphanedMaps();

    expect((tm as any).outputBuffers.has(teamId)).toBe(false);
    expect((tm as any).parsedEvents.has(teamId)).toBe(false);
    expect((tm as any).lastStreamAt.has(teamId)).toBe(false);
  });

  it('should not log when zero teams are purged', () => {
    const consoleSpy = vi.spyOn(console, 'log');

    // No maps populated — nothing to sweep
    (tm as any).sweepOrphanedMaps();

    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Periodic cleanup'),
    );
    consoleSpy.mockRestore();
  });

  it('should log when teams are purged', () => {
    const consoleSpy = vi.spyOn(console, 'log');
    const teamId = 12;
    (tm as any).outputBuffers.set(teamId, new CircularBuffer<string>(10));

    mockDb.getTeam.mockReturnValue(undefined);

    (tm as any).sweepOrphanedMaps();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('purged maps for 1 orphaned team(s)'),
    );
    consoleSpy.mockRestore();
  });
});
