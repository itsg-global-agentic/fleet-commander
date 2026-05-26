// =============================================================================
// Fleet Commander — Stuck Detector Tests: background-aware suppression (#730)
//
// CC 2.1.145+ ships `background_tasks` and `session_crons` arrays on Stop /
// SubagentStop hook input. When either array is non-empty the agent is
// intentionally awaiting background work; FC must not escalate the team
// to `stuck` via the idle-stuck timer. The control cases (no background
// work) MUST still escalate normally.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Team } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Mocks — must be declared before import
// ---------------------------------------------------------------------------

const mockDb = {
  getActiveTeams: vi.fn<() => Partial<Team>[]>().mockReturnValue([]),
  updateTeam: vi.fn(),
  updateTeamSilent: vi.fn(),
  insertTransition: vi.fn(),
  getPullRequest: vi.fn(),
  hasActiveSubagent: vi.fn().mockReturnValue(false),
};

const mockSseBroker = {
  broadcast: vi.fn(),
};

type SubagentActivityEntry = { lastEventAt: number; toolUseId: string; startedAt: number };

const mockManager = {
  stop: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn(),
  syncStreamActivityToDb: vi.fn(),
  getLastStreamAt: vi.fn().mockReturnValue(null),
  thinkingTeams: new Set<number>(),
  getSubagentActivity: vi.fn<(teamId: number) => Map<string, SubagentActivityEntry>>().mockReturnValue(new Map()),
  clearSubagentActivity: vi.fn(),
};

vi.mock('../../src/server/db.js', () => ({
  getDatabase: () => mockDb,
}));

vi.mock('../../src/server/services/sse-broker.js', () => ({
  sseBroker: mockSseBroker,
}));

const mockGetTeamManager = vi.fn(() => mockManager);
vi.mock('../../src/server/services/team-manager.js', () => ({
  getTeamManager: (...args: unknown[]) => mockGetTeamManager(...args),
}));

vi.mock('../../src/server/utils/resolve-message.js', () => ({
  resolveMessage: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/server/config.js', () => ({
  default: {
    stuckCheckIntervalMs: 60000,
    idleThresholdMin: 5,
    stuckThresholdMin: 10,
    subagentStuckThresholdMin: 3,
    launchTimeoutMin: 5,
  },
}));

// Import after mocks are set up
const { stuckDetector } = await import('../../src/server/services/stuck-detector.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTeam(overrides: Partial<Team>): Partial<Team> {
  return {
    id: 1,
    issueNumber: 100,
    issueKey: '100',
    issueProvider: 'github',
    issueTitle: 'Test issue',
    projectId: 1,
    status: 'running',
    phase: 'implementing',
    pid: 12345,
    sessionId: 'sess-abc',
    worktreeName: 'test-100',
    branchName: 'feat/100-test',
    prNumber: null,
    customPrompt: null,
    blockedByJson: null,
    pendingChildrenJson: null,
    backgroundTasksJson: null,
    sessionCronsJson: null,
    launchedAt: new Date(Date.now() - 60_000).toISOString(),
    stoppedAt: null,
    lastEventAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function minutesAgo(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.getActiveTeams.mockReturnValue([]);
  mockDb.hasActiveSubagent.mockReturnValue(false);
  mockDb.getPullRequest.mockReturnValue(undefined);
  mockManager.thinkingTeams.clear();
  mockManager.getSubagentActivity.mockReturnValue(new Map());
  mockGetTeamManager.mockImplementation(() => mockManager);
});

// =============================================================================
// Background-aware idle/stuck suppression (#730)
// =============================================================================

describe('Background-aware idle/stuck suppression (#730)', () => {
  it('does NOT transition idle -> stuck when team has non-empty background_tasks_json', () => {
    const team = makeTeam({
      status: 'idle',
      lastEventAt: minutesAgo(11), // past the 10 min stuck threshold
      backgroundTasksJson: JSON.stringify([{ shell_command_id: 'sc_1', description: 'long build' }]),
    });
    mockDb.getActiveTeams.mockReturnValue([team]);

    stuckDetector.check();

    // Stuck transition must be suppressed
    const stuckCalls = mockDb.updateTeamSilent.mock.calls.filter(
      (call: unknown[]) => {
        const fields = call[1] as Record<string, unknown> | undefined;
        return fields?.status === 'stuck';
      },
    );
    expect(stuckCalls).toHaveLength(0);
    const stuckTransitions = mockDb.insertTransition.mock.calls.filter(
      (call: unknown[]) => {
        const arg = call[0] as Record<string, unknown> | undefined;
        return arg?.toStatus === 'stuck';
      },
    );
    expect(stuckTransitions).toHaveLength(0);
  });

  it('does NOT transition idle -> stuck when team has non-empty session_crons_json', () => {
    const team = makeTeam({
      status: 'idle',
      lastEventAt: minutesAgo(11),
      sessionCronsJson: JSON.stringify([{ cron_id: 'c1', schedule: '*/5 * * * *' }]),
    });
    mockDb.getActiveTeams.mockReturnValue([team]);

    stuckDetector.check();

    expect(mockDb.updateTeamSilent).not.toHaveBeenCalledWith(1, expect.objectContaining({ status: 'stuck' }));
    expect(mockDb.insertTransition).not.toHaveBeenCalled();
  });

  it('does NOT transition idle -> stuck when BOTH background fields are non-empty', () => {
    const team = makeTeam({
      status: 'idle',
      lastEventAt: minutesAgo(11),
      backgroundTasksJson: JSON.stringify([{ shell_command_id: 'sc_1' }]),
      sessionCronsJson: JSON.stringify([{ cron_id: 'c1' }]),
    });
    mockDb.getActiveTeams.mockReturnValue([team]);

    stuckDetector.check();

    expect(mockDb.updateTeamSilent).not.toHaveBeenCalledWith(1, expect.objectContaining({ status: 'stuck' }));
  });

  it('DOES transition idle -> stuck when both background arrays are null (control case)', () => {
    const team = makeTeam({
      status: 'idle',
      lastEventAt: minutesAgo(11),
      backgroundTasksJson: null,
      sessionCronsJson: null,
    });
    mockDb.getActiveTeams.mockReturnValue([team]);

    stuckDetector.check();

    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        fromStatus: 'idle',
        toStatus: 'stuck',
        trigger: 'timer',
      }),
    );
    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(1, { status: 'stuck' });
  });

  it('DOES transition idle -> stuck when background_tasks_json is the literal string "[]" (empty array)', () => {
    // Defense against a stray writer that stored "[]" instead of normalizing
    // to NULL. The parser must treat empty arrays as "no work pending".
    const team = makeTeam({
      status: 'idle',
      lastEventAt: minutesAgo(11),
      backgroundTasksJson: '[]',
      sessionCronsJson: '[]',
    });
    mockDb.getActiveTeams.mockReturnValue([team]);

    stuckDetector.check();

    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(1, { status: 'stuck' });
  });

  it('DOES transition idle -> stuck when background_tasks_json is malformed JSON', () => {
    // Corrupted column must not block stuck detection forever.
    const team = makeTeam({
      status: 'idle',
      lastEventAt: minutesAgo(11),
      backgroundTasksJson: 'not valid json {',
      sessionCronsJson: 'also not valid }',
    });
    mockDb.getActiveTeams.mockReturnValue([team]);

    stuckDetector.check();

    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(1, { status: 'stuck' });
  });

  it('DOES transition running -> idle even when background_tasks_json is set', () => {
    // The suppression only affects idle->stuck, not running->idle. A team
    // with pending background work should still report idle (it really is
    // dormant), just never escalate to stuck.
    const team = makeTeam({
      status: 'running',
      lastEventAt: minutesAgo(6),
      backgroundTasksJson: JSON.stringify([{ shell_command_id: 'sc_1' }]),
    });
    mockDb.getActiveTeams.mockReturnValue([team]);

    stuckDetector.check();

    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        fromStatus: 'running',
        toStatus: 'idle',
        trigger: 'timer',
      }),
    );
    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(1, { status: 'idle' });
  });

  it('background-pending team transitions to stuck on a later pass once arrays clear', () => {
    // First pass: backgroundTasksJson set — suppressed.
    const teamWithBg = makeTeam({
      status: 'idle',
      lastEventAt: minutesAgo(11),
      backgroundTasksJson: JSON.stringify([{ shell_command_id: 'sc_1' }]),
    });
    mockDb.getActiveTeams.mockReturnValue([teamWithBg]);

    stuckDetector.check();
    expect(mockDb.updateTeamSilent).not.toHaveBeenCalledWith(1, expect.objectContaining({ status: 'stuck' }));

    // Clear the mock and run a second pass with backgroundTasksJson=null.
    vi.clearAllMocks();
    mockDb.hasActiveSubagent.mockReturnValue(false);
    mockDb.getPullRequest.mockReturnValue(undefined);

    const teamClear = makeTeam({
      status: 'idle',
      lastEventAt: minutesAgo(11),
      backgroundTasksJson: null,
      sessionCronsJson: null,
    });
    mockDb.getActiveTeams.mockReturnValue([teamClear]);

    stuckDetector.check();

    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(1, { status: 'stuck' });
  });

  it('does NOT suppress idle->stuck when only an empty array is stored alongside a populated one... no — populated wins', () => {
    // Sanity: if EITHER array is non-empty, the team is awaiting background
    // work. An empty session_crons_json must not "rescue" the team from the
    // suppression set by a non-empty background_tasks_json.
    const team = makeTeam({
      status: 'idle',
      lastEventAt: minutesAgo(11),
      backgroundTasksJson: JSON.stringify([{ shell_command_id: 'sc_1' }]),
      sessionCronsJson: '[]', // empty, should not contribute
    });
    mockDb.getActiveTeams.mockReturnValue([team]);

    stuckDetector.check();

    expect(mockDb.updateTeamSilent).not.toHaveBeenCalledWith(1, expect.objectContaining({ status: 'stuck' }));
  });
});
