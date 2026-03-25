// =============================================================================
// Fleet Commander — TeamManager Lifecycle Tests (stop, sendMessage, process exit)
// =============================================================================
// Tests for stop(), sendMessage(), attachProcessHandlers exit/error handling,
// and gracefulShutdown. Does NOT duplicate queue/env tests from other files.
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

vi.mock('../../src/server/services/github-poller.js', () => ({
  githubPoller: {
    trackBlockedIssue: vi.fn(),
  },
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
    mockDb.updateTeam.mockReturnValue(team);

    await tm.stop(1);

    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        fromStatus: 'queued',
        toStatus: 'failed',
        trigger: 'pm_action',
      }),
    );
    expect(mockDb.updateTeam).toHaveBeenCalledWith(
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
    (tm as any).parsedEvents.set(1, []);

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
    const events: unknown[] = [];
    (tm as any).parsedEvents.set(1, events);

    tm.sendMessage(1, 'Check status', 'user');

    expect(events.length).toBe(1);
    const event = events[0] as Record<string, unknown>;
    expect(event.type).toBe('user');
    expect(event.agentName).toBe('__pm__');
  });

  it('tags FC messages with __fc__ agent name and subtype', () => {
    const mockStdin = createMockStdin();
    (tm as any).stdinPipes.set(1, mockStdin);
    const events: unknown[] = [];
    (tm as any).parsedEvents.set(1, events);

    tm.sendMessage(1, 'CI passed', 'fc', 'ci_green');

    expect(events.length).toBe(1);
    const event = events[0] as Record<string, unknown>;
    expect(event.type).toBe('fc');
    expect(event.agentName).toBe('__fc__');
    expect(event.subtype).toBe('ci_green');
  });

  it('broadcasts team_output SSE event for the message', () => {
    const mockStdin = createMockStdin();
    (tm as any).stdinPipes.set(1, mockStdin);
    (tm as any).parsedEvents.set(1, []);

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

  beforeEach(() => {
    vi.clearAllMocks();
    tm = new TeamManager();
  });

  it('marks team done on exit code 0', () => {
    const child = createMockChildProcess();
    const team = makeTeam({ id: 1, status: 'running' });

    (tm as any).childProcesses.set(1, child);
    (tm as any).outputBuffers.set(1, new CircularBuffer<string>(500));
    (tm as any).parsedEvents.set(1, []);
    (tm as any).tokenCounters.set(1, { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0 });

    mockDb.getTeam.mockReturnValue(team);

    (tm as any).attachProcessHandlers(1, child);

    child.emit('exit', 0, null);

    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        fromStatus: 'running',
        toStatus: 'done',
        trigger: 'system',
        reason: expect.stringContaining('code 0'),
      }),
    );
    expect(mockDb.updateTeam).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'done', pid: null }),
    );
  });

  it('marks team failed on non-zero exit code', () => {
    const child = createMockChildProcess();
    const team = makeTeam({ id: 1, status: 'running' });

    (tm as any).childProcesses.set(1, child);
    (tm as any).outputBuffers.set(1, new CircularBuffer<string>(500));
    (tm as any).parsedEvents.set(1, []);
    (tm as any).tokenCounters.set(1, { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0 });

    mockDb.getTeam.mockReturnValue(team);

    (tm as any).attachProcessHandlers(1, child);

    child.emit('exit', 1, null);

    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        fromStatus: 'running',
        toStatus: 'failed',
        trigger: 'system',
        reason: expect.stringContaining('code 1'),
      }),
    );
    expect(mockDb.updateTeam).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'failed', pid: null }),
    );
  });

  it('includes signal in reason when process exits with signal', () => {
    const child = createMockChildProcess();
    const team = makeTeam({ id: 1, status: 'running' });

    (tm as any).childProcesses.set(1, child);
    (tm as any).outputBuffers.set(1, new CircularBuffer<string>(500));
    (tm as any).parsedEvents.set(1, []);
    (tm as any).tokenCounters.set(1, { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0 });

    mockDb.getTeam.mockReturnValue(team);

    (tm as any).attachProcessHandlers(1, child);

    child.emit('exit', null, 'SIGTERM');

    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        fromStatus: 'running',
        toStatus: 'failed',
        reason: expect.stringContaining('SIGTERM'),
      }),
    );
  });

  it('does nothing when team is already done or failed', () => {
    const child = createMockChildProcess();
    const team = makeTeam({ id: 1, status: 'done' });

    (tm as any).childProcesses.set(1, child);
    (tm as any).outputBuffers.set(1, new CircularBuffer<string>(500));
    (tm as any).parsedEvents.set(1, []);
    (tm as any).tokenCounters.set(1, { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0 });

    mockDb.getTeam.mockReturnValue(team);

    (tm as any).attachProcessHandlers(1, child);

    child.emit('exit', 0, null);

    expect(mockDb.insertTransition).not.toHaveBeenCalled();
  });

  it('broadcasts team_stopped on process exit', () => {
    const child = createMockChildProcess();
    const team = makeTeam({ id: 1, status: 'running' });

    (tm as any).childProcesses.set(1, child);
    (tm as any).outputBuffers.set(1, new CircularBuffer<string>(500));
    (tm as any).parsedEvents.set(1, []);
    (tm as any).tokenCounters.set(1, { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0 });

    mockDb.getTeam.mockReturnValue(team);

    (tm as any).attachProcessHandlers(1, child);

    child.emit('exit', 0, null);

    expect(mockSseBroker.broadcast).toHaveBeenCalledWith(
      'team_stopped',
      { team_id: 1 },
      1,
    );
  });

  it('does not throw when team not found in DB on exit', () => {
    const child = createMockChildProcess();

    (tm as any).childProcesses.set(1, child);
    (tm as any).outputBuffers.set(1, new CircularBuffer<string>(500));
    (tm as any).parsedEvents.set(1, []);
    (tm as any).tokenCounters.set(1, { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0 });

    mockDb.getTeam.mockReturnValue(undefined);

    (tm as any).attachProcessHandlers(1, child);

    expect(() => child.emit('exit', 0, null)).not.toThrow();
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
    (tm as any).parsedEvents.set(1, []);
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
    expect(mockDb.updateTeam).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'failed', pid: null }),
    );
  });

  it('cleans up internal maps on process error', () => {
    const child = createMockChildProcess();
    const team = makeTeam({ id: 1, status: 'running' });

    (tm as any).childProcesses.set(1, child);
    (tm as any).outputBuffers.set(1, new CircularBuffer<string>(500));
    (tm as any).parsedEvents.set(1, []);
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
    (tm as any).parsedEvents.set(1, []);

    tm.gracefulShutdown(1, 42, 120000);

    expect(mockStdin.write).toHaveBeenCalled();
  });

  it('clears existing shutdown timer before setting new one', () => {
    const mockStdin = createMockStdin();
    (tm as any).stdinPipes.set(1, mockStdin);
    (tm as any).parsedEvents.set(1, []);

    tm.gracefulShutdown(1, 42, 120000);
    tm.gracefulShutdown(1, 43, 60000);

    expect((tm as any).shutdownTimers.size).toBe(1);
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
    (tm as any).parsedEvents.set(teamId, []);
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
    (tm as any).parsedEvents.set(teamId, []);
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
    (tm as any).parsedEvents.set(teamId, []);

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
    (tm as any).parsedEvents.set(teamId, []);
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
