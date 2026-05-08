// =============================================================================
// Fleet Commander — TeamManager Subagent Activity Tests (issue #689)
// =============================================================================
// Tests for the per-subagent activity tracking introduced for the
// `subagent_stuck` watchdog: getSubagentActivity / clearSubagentActivity
// public accessors, seeding from Agent/Task tool_use events, lastEventAt
// updates from non-TL stream events, and clearing on tool_result.
// =============================================================================

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { EventEmitter } from 'events';
import type { Writable } from 'stream';
import type { Team } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Mocks
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
  upsertTeamTask: vi.fn().mockReturnValue({ taskId: 't', subject: 's', status: 'pending', owner: 'team-lead' }),
  getTeamDashboard: vi.fn().mockReturnValue([]),
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
  resolveMessage: vi.fn().mockReturnValue('msg'),
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

/**
 * Drive a stream-json line through the team manager's stdout handler.
 * captureOutput is private — call via casts. Returns the spawned events
 * Map for assertion.
 */
function attachCapture(tm: TeamManager, teamId: number, child: EventEmitter): void {
  mockDb.getTeam.mockReturnValue(makeTeam({ id: teamId }));
  (tm as any).initOutputBuffer(teamId);
  (tm as any).captureOutput(teamId, child);
}

function emitStdoutLine(child: EventEmitter, obj: Record<string, unknown>): void {
  const stdout = (child as any).stdout as EventEmitter;
  stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TeamManager subagent activity (issue #689)', () => {
  let tm: TeamManager;

  beforeEach(() => {
    vi.clearAllMocks();
    tm = new TeamManager();
  });

  describe('getSubagentActivity / clearSubagentActivity', () => {
    it('returns an empty Map for an unknown team', () => {
      const activity = tm.getSubagentActivity(999);
      expect(activity.size).toBe(0);
    });

    it('returns the recorded activity after a subagent spawn is observed', () => {
      const child = createMockChildProcess();
      attachCapture(tm, 1, child);

      // TL emits an assistant event with a tool_use for "Agent" / "dev"
      emitStdoutLine(child, {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu_seed_1',
              name: 'Agent',
              input: { name: 'dev' },
            },
          ],
        },
      });

      const activity = tm.getSubagentActivity(1);
      expect(activity.size).toBe(1);
      const entry = activity.get('dev');
      expect(entry).toBeDefined();
      expect(entry?.toolUseId).toBe('tu_seed_1');
      expect(typeof entry?.lastEventAt).toBe('number');
      expect(typeof entry?.startedAt).toBe('number');
    });

    it('clearSubagentActivity removes a single agent entry', () => {
      const child = createMockChildProcess();
      attachCapture(tm, 1, child);

      emitStdoutLine(child, {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu_clear_1', name: 'Task', input: { name: 'reviewer' } },
          ],
        },
      });

      expect(tm.getSubagentActivity(1).size).toBe(1);
      tm.clearSubagentActivity(1, 'reviewer');
      expect(tm.getSubagentActivity(1).size).toBe(0);
    });

    it('updates lastEventAt when a non-TL stream event arrives', async () => {
      const child = createMockChildProcess();
      attachCapture(tm, 1, child);

      // Seed via an Agent tool_use.
      emitStdoutLine(child, {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu_update_1', name: 'Agent', input: { name: 'dev' } },
          ],
        },
      });

      const before = tm.getSubagentActivity(1).get('dev')!.lastEventAt;
      // Wait a tick of wall-clock so Date.now() advances. tm uses Date.now()
      // directly (not vi.useFakeTimers), so a tiny delay is sufficient.
      await new Promise((resolve) => setTimeout(resolve, 5));

      // A subsequent assistant event with parent_tool_use_id pointing at the
      // dev's tool_use_id resolves to agent='dev' and bumps lastEventAt.
      emitStdoutLine(child, {
        type: 'assistant',
        parent_tool_use_id: 'tu_update_1',
        message: { content: [{ type: 'text', text: 'progress' }] },
      });

      const after = tm.getSubagentActivity(1).get('dev')!.lastEventAt;
      expect(after).toBeGreaterThan(before);
    });

    it('clears the activity entry when a matching tool_result arrives', () => {
      const child = createMockChildProcess();
      attachCapture(tm, 1, child);

      emitStdoutLine(child, {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu_done_1', name: 'Agent', input: { name: 'planner' } },
          ],
        },
      });
      expect(tm.getSubagentActivity(1).get('planner')).toBeDefined();

      // Subagent's tool_result arrives — entry must be cleared.
      emitStdoutLine(child, {
        type: 'tool_result',
        tool_use_id: 'tu_done_1',
      });

      expect(tm.getSubagentActivity(1).get('planner')).toBeUndefined();
    });

    it('purgeTeamMaps removes the subagent activity for a team', () => {
      const child = createMockChildProcess();
      attachCapture(tm, 1, child);

      emitStdoutLine(child, {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu_purge_1', name: 'Agent', input: { name: 'dev' } },
          ],
        },
      });
      expect(tm.getSubagentActivity(1).size).toBe(1);

      // purgeTeamMaps is private — call via cast.
      (tm as any).purgeTeamMaps(1);
      expect(tm.getSubagentActivity(1).size).toBe(0);
    });

    it('seeds independent entries for multiple distinct subagents', () => {
      const child = createMockChildProcess();
      attachCapture(tm, 1, child);

      emitStdoutLine(child, {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu_a_1', name: 'Agent', input: { name: 'dev' } },
            { type: 'tool_use', id: 'tu_a_2', name: 'Agent', input: { name: 'reviewer' } },
          ],
        },
      });

      const activity = tm.getSubagentActivity(1);
      expect(activity.size).toBe(2);
      expect(activity.get('dev')?.toolUseId).toBe('tu_a_1');
      expect(activity.get('reviewer')?.toolUseId).toBe('tu_a_2');
    });

    it('respawn (same agent name, new toolUseId) overwrites prior entry', () => {
      const child = createMockChildProcess();
      attachCapture(tm, 1, child);

      emitStdoutLine(child, {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu_respawn_a', name: 'Agent', input: { name: 'dev' } },
          ],
        },
      });
      expect(tm.getSubagentActivity(1).get('dev')?.toolUseId).toBe('tu_respawn_a');

      emitStdoutLine(child, {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu_respawn_b', name: 'Agent', input: { name: 'dev' } },
          ],
        },
      });
      expect(tm.getSubagentActivity(1).get('dev')?.toolUseId).toBe('tu_respawn_b');
      expect(tm.getSubagentActivity(1).size).toBe(1);
    });
  });
});
