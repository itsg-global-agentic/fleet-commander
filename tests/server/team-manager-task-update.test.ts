// =============================================================================
// Fleet Commander — TeamManager TaskUpdate / TaskStop stream parser (Issue #764)
// =============================================================================
// Tests for the CC 2.1.16+ TaskUpdate / TaskStop tool stream-event handler in
// team-manager.ts. These tool_use blocks are the ONLY signal FC receives for
// task status transitions (there is no native TaskUpdated hook), so the
// stream-event parser must always flow through — unlike TodoWrite, the
// wasTaskSeenByHook dedup guard does NOT apply.
// =============================================================================

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { EventEmitter } from 'events';
import type { Writable } from 'stream';
import type { Team, TeamTask } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDb = vi.hoisted(() => {
  const upsertTeamTask = vi.fn();
  const getTeamTasks = vi.fn().mockReturnValue([]);
  return {
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
    upsertTeamTask,
    getTeamTasks,
    getTeamDashboard: vi.fn().mockReturnValue([]),
  };
});

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
  resolveMessage: vi.fn().mockReturnValue('msg'),
}));

vi.mock('../../src/server/services/usage-tracker.js', () => ({
  getUsageZone: vi.fn().mockReturnValue('green'),
  isUsageBlocked: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/server/utils/resolve-claude-path.js', () => ({
  resolveClaudePath: vi.fn().mockReturnValue('claude'),
}));

vi.mock('../../src/server/services/issue-fetcher.js', () => ({
  getIssueFetcher: () => ({
    fetchDependenciesForIssue: vi.fn().mockResolvedValue({
      issueNumber: 0,
      blockedBy: [],
      resolved: true,
      openCount: 0,
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
import { recordHookTaskId, resetTaskDedupState } from '../../src/server/services/task-dedup.js';

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

function makeTeamTask(overrides?: Partial<TeamTask>): TeamTask {
  return {
    id: 1,
    teamId: 1,
    taskId: 'task-1',
    subject: 'Existing task',
    description: 'Existing description',
    status: 'in_progress',
    owner: 'dev',
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

function attachCapture(tm: TeamManager, teamId: number, child: EventEmitter): void {
  mockDb.getTeam.mockReturnValue(makeTeam({ id: teamId }));
  (tm as any).initOutputBuffer(teamId);
  (tm as any).captureOutput(teamId, child);
}

function emitStdoutLine(child: EventEmitter, obj: Record<string, unknown>): void {
  const stdout = (child as any).stdout as EventEmitter;
  stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));
}

function makeTaskUpdate(input: Record<string, unknown>, opts?: { parentToolUseId?: string }) {
  return {
    type: 'assistant',
    ...(opts?.parentToolUseId ? { parent_tool_use_id: opts.parentToolUseId } : {}),
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'tu_taskupdate_1',
          name: 'TaskUpdate',
          input,
        },
      ],
    },
  };
}

function makeTaskStop(input: Record<string, unknown>) {
  return {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'tu_taskstop_1',
          name: 'TaskStop',
          input,
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TeamManager TaskUpdate / TaskStop stream parser (Issue #764)', () => {
  let tm: TeamManager;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetTaskDedupState();
    mockDb.getTeamTasks.mockReset();
    mockDb.getTeamTasks.mockReturnValue([]);
    mockDb.upsertTeamTask.mockReset();
    mockDb.upsertTeamTask.mockImplementation((data: {
      teamId: number;
      taskId: string;
      subject: string;
      description?: string | null;
      status: string;
      owner: string;
    }) => makeTeamTask({
      teamId: data.teamId,
      taskId: data.taskId,
      subject: data.subject,
      description: data.description ?? null,
      status: data.status as TeamTask['status'],
      owner: data.owner,
    }));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tm = new TeamManager();
  });

  it('upserts status=completed when TaskUpdate fires for an existing task', () => {
    const existing = makeTeamTask({ taskId: 'task-7', status: 'in_progress', owner: 'dev', subject: 'Run tests' });
    mockDb.getTeamTasks.mockReturnValue([existing]);

    const child = createMockChildProcess();
    attachCapture(tm, 1, child);

    emitStdoutLine(child, makeTaskUpdate({ taskId: 'task-7', status: 'completed' }));

    expect(mockDb.upsertTeamTask).toHaveBeenCalledTimes(1);
    const arg = mockDb.upsertTeamTask.mock.calls[0][0];
    expect(arg).toMatchObject({
      teamId: 1,
      taskId: 'task-7',
      status: 'completed',
      subject: 'Run tests',
      owner: 'dev',
    });
  });

  it('broadcasts task_updated SSE with the new status', () => {
    const existing = makeTeamTask({ taskId: 'task-7', status: 'in_progress', owner: 'reviewer', subject: 'Review PR' });
    mockDb.getTeamTasks.mockReturnValue([existing]);

    const child = createMockChildProcess();
    attachCapture(tm, 1, child);

    emitStdoutLine(child, makeTaskUpdate({ taskId: 'task-7', status: 'completed' }));

    const taskUpdatedCalls = mockSseBroker.broadcast.mock.calls.filter(
      (c) => c[0] === 'task_updated'
    );
    expect(taskUpdatedCalls.length).toBe(1);
    const [, payload, teamId] = taskUpdatedCalls[0];
    expect(payload).toMatchObject({
      team_id: 1,
      task_id: 'task-7',
      status: 'completed',
      subject: 'Review PR',
      owner: 'reviewer',
    });
    expect(teamId).toBe(1);
  });

  it('preserves subject/description from existing row when TaskUpdate omits them', () => {
    const existing = makeTeamTask({
      taskId: 'task-8',
      subject: 'Original subject',
      description: 'Original description',
      status: 'pending',
      owner: 'planner',
    });
    mockDb.getTeamTasks.mockReturnValue([existing]);

    const child = createMockChildProcess();
    attachCapture(tm, 1, child);

    emitStdoutLine(child, makeTaskUpdate({ taskId: 'task-8', status: 'in_progress' }));

    expect(mockDb.upsertTeamTask).toHaveBeenCalledTimes(1);
    const arg = mockDb.upsertTeamTask.mock.calls[0][0];
    expect(arg.subject).toBe('Original subject');
    expect(arg.description).toBe('Original description');
    expect(arg.status).toBe('in_progress');
  });

  it('uses TaskUpdate input.subject when provided', () => {
    const existing = makeTeamTask({ taskId: 'task-9', subject: 'Old', status: 'pending', owner: 'dev' });
    mockDb.getTeamTasks.mockReturnValue([existing]);

    const child = createMockChildProcess();
    attachCapture(tm, 1, child);

    emitStdoutLine(child, makeTaskUpdate({
      taskId: 'task-9',
      status: 'in_progress',
      subject: 'New subject',
    }));

    const arg = mockDb.upsertTeamTask.mock.calls[0][0];
    expect(arg.subject).toBe('New subject');
  });

  it('logs warning and upserts with placeholder subject when task is unknown', () => {
    mockDb.getTeamTasks.mockReturnValue([]);

    const child = createMockChildProcess();
    attachCapture(tm, 1, child);

    emitStdoutLine(child, makeTaskUpdate({ taskId: 'task-unknown', status: 'completed' }));

    expect(warnSpy).toHaveBeenCalled();
    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((m) => m.includes('unknown task_id=task-unknown'))).toBe(true);

    expect(mockDb.upsertTeamTask).toHaveBeenCalledTimes(1);
    const arg = mockDb.upsertTeamTask.mock.calls[0][0];
    expect(arg.taskId).toBe('task-unknown');
    expect(arg.subject).toBe('Untitled task');
    expect(arg.status).toBe('completed');
    expect(arg.owner).toBe('team-lead');
  });

  it('maps TaskStop to status=cancelled', () => {
    const existing = makeTeamTask({ taskId: 'task-3', status: 'in_progress', owner: 'dev', subject: 'Build' });
    mockDb.getTeamTasks.mockReturnValue([existing]);

    const child = createMockChildProcess();
    attachCapture(tm, 1, child);

    emitStdoutLine(child, makeTaskStop({ taskId: 'task-3' }));

    expect(mockDb.upsertTeamTask).toHaveBeenCalledTimes(1);
    const arg = mockDb.upsertTeamTask.mock.calls[0][0];
    expect(arg).toMatchObject({
      teamId: 1,
      taskId: 'task-3',
      status: 'cancelled',
      subject: 'Build',
      owner: 'dev',
    });

    const taskUpdatedCalls = mockSseBroker.broadcast.mock.calls.filter(
      (c) => c[0] === 'task_updated'
    );
    expect(taskUpdatedCalls.length).toBe(1);
    expect(taskUpdatedCalls[0][1]).toMatchObject({ status: 'cancelled' });
  });

  it('does NOT call upsertTeamTask when taskId is missing', () => {
    const child = createMockChildProcess();
    attachCapture(tm, 1, child);

    emitStdoutLine(child, makeTaskUpdate({ status: 'completed' }));

    expect(mockDb.upsertTeamTask).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((m) => m.includes('TaskUpdate without taskId'))).toBe(true);
  });

  it('preserves owner from existing row on TaskUpdate (does not reassign)', () => {
    const existing = makeTeamTask({
      taskId: 'task-owner',
      status: 'in_progress',
      owner: 'reviewer',
      subject: 'Review',
    });
    mockDb.getTeamTasks.mockReturnValue([existing]);

    const child = createMockChildProcess();
    attachCapture(tm, 1, child);

    // Seed a different agent into the agentMap so we can verify
    // owner is NOT reassigned from parent_tool_use_id.
    emitStdoutLine(child, {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu_dev_1', name: 'Agent', input: { name: 'dev' } },
        ],
      },
    });

    // TaskUpdate emitted as a subagent (parent_tool_use_id points at dev),
    // but the existing row was owned by reviewer — owner must stay 'reviewer'.
    emitStdoutLine(child, makeTaskUpdate(
      { taskId: 'task-owner', status: 'completed' },
      { parentToolUseId: 'tu_dev_1' }
    ));

    expect(mockDb.upsertTeamTask).toHaveBeenCalledTimes(1);
    const arg = mockDb.upsertTeamTask.mock.calls[0][0];
    expect(arg.owner).toBe('reviewer');
  });

  it('does NOT skip TaskUpdate via wasTaskSeenByHook dedup', () => {
    // recordHookTaskId for the same task would cause TodoWrite to bail,
    // but TaskUpdate must always flow through (status changes are precious).
    recordHookTaskId(1, 'task-dedup');
    const existing = makeTeamTask({ taskId: 'task-dedup', status: 'in_progress', owner: 'dev' });
    mockDb.getTeamTasks.mockReturnValue([existing]);

    const child = createMockChildProcess();
    attachCapture(tm, 1, child);

    emitStdoutLine(child, makeTaskUpdate({ taskId: 'task-dedup', status: 'completed' }));

    expect(mockDb.upsertTeamTask).toHaveBeenCalledTimes(1);
    expect(mockDb.upsertTeamTask.mock.calls[0][0]).toMatchObject({
      taskId: 'task-dedup',
      status: 'completed',
    });
  });

  it('passes through unrecognized status values with a warning', () => {
    const existing = makeTeamTask({ taskId: 'task-weird', status: 'in_progress', owner: 'dev' });
    mockDb.getTeamTasks.mockReturnValue([existing]);

    const child = createMockChildProcess();
    attachCapture(tm, 1, child);

    emitStdoutLine(child, makeTaskUpdate({
      taskId: 'task-weird',
      status: 'paused',
    }));

    expect(mockDb.upsertTeamTask).toHaveBeenCalledTimes(1);
    expect(mockDb.upsertTeamTask.mock.calls[0][0].status).toBe('paused');
    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((m) => m.includes('unrecognized status="paused"'))).toBe(true);
  });

  it('preserves existing status when TaskUpdate omits status', () => {
    const existing = makeTeamTask({ taskId: 'task-nostatus', status: 'completed', owner: 'dev' });
    mockDb.getTeamTasks.mockReturnValue([existing]);

    const child = createMockChildProcess();
    attachCapture(tm, 1, child);

    emitStdoutLine(child, makeTaskUpdate({
      taskId: 'task-nostatus',
      subject: 'Updated subject',
    }));

    expect(mockDb.upsertTeamTask).toHaveBeenCalledTimes(1);
    const arg = mockDb.upsertTeamTask.mock.calls[0][0];
    expect(arg.status).toBe('completed');
    expect(arg.subject).toBe('Updated subject');
  });
});
