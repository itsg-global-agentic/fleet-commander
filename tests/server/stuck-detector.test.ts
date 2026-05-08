// =============================================================================
// Fleet Commander — Stuck Detector Tests (launch timeout)
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
    launchedAt: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
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
// Launch timeout detection
// =============================================================================

describe('Launch timeout detection', () => {
  it('transitions launching -> failed when launchedAt exceeds timeout', () => {
    const team = makeTeam({
      status: 'launching',
      launchedAt: minutesAgo(10), // 10 min ago, well past the 5 min timeout
      lastEventAt: null,
    });
    mockDb.getActiveTeams.mockReturnValue([team]);

    stuckDetector.check();

    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        fromStatus: 'launching',
        toStatus: 'failed',
        trigger: 'timer',
        reason: expect.stringContaining('Launch timeout'),
      }),
    );
    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(1, { status: 'failed' });
  });

  it('does NOT transition launching team with recent launchedAt', () => {
    const team = makeTeam({
      status: 'launching',
      launchedAt: minutesAgo(2), // 2 min ago, within the 5 min timeout
      lastEventAt: null,
    });
    mockDb.getActiveTeams.mockReturnValue([team]);

    stuckDetector.check();

    expect(mockDb.insertTransition).not.toHaveBeenCalled();
    expect(mockDb.updateTeamSilent).not.toHaveBeenCalled();
  });

  it('broadcasts SSE on launching -> failed', () => {
    const team = makeTeam({
      status: 'launching',
      launchedAt: minutesAgo(10),
      lastEventAt: null,
    });
    mockDb.getActiveTeams.mockReturnValue([team]);

    stuckDetector.check();

    expect(mockSseBroker.broadcast).toHaveBeenCalledWith(
      'team_status_changed',
      expect.objectContaining({
        team_id: 1,
        status: 'failed',
        previous_status: 'launching',
      }),
      1,
    );
  });

  it('calls manager.stop to kill hung process', () => {
    const team = makeTeam({
      status: 'launching',
      launchedAt: minutesAgo(10),
      lastEventAt: null,
    });
    mockDb.getActiveTeams.mockReturnValue([team]);

    stuckDetector.check();

    expect(mockManager.stop).toHaveBeenCalledWith(1);
  });

  it('does not crash if manager.stop throws', () => {
    mockManager.stop.mockRejectedValueOnce(new Error('process not found'));

    const team = makeTeam({
      status: 'launching',
      launchedAt: minutesAgo(10),
      lastEventAt: null,
    });
    mockDb.getActiveTeams.mockReturnValue([team]);

    // Should not throw
    expect(() => stuckDetector.check()).not.toThrow();
    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(1, { status: 'failed' });
  });

  it('guards against launchedAt === null', () => {
    const team = makeTeam({
      status: 'launching',
      launchedAt: null,
      lastEventAt: null,
    });
    mockDb.getActiveTeams.mockReturnValue([team]);

    stuckDetector.check();

    // Should skip this team entirely
    expect(mockDb.insertTransition).not.toHaveBeenCalled();
    expect(mockDb.updateTeamSilent).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Teams in other statuses are unaffected by launch timeout
// =============================================================================

describe('Teams in other statuses unaffected by launch timeout', () => {
  const otherStatuses = ['running', 'idle', 'stuck', 'queued'] as const;

  for (const status of otherStatuses) {
    it(`does not apply launch timeout to ${status} team`, () => {
      const team = makeTeam({
        status,
        launchedAt: minutesAgo(10), // Old enough to trigger, but wrong status
        lastEventAt: status === 'running' ? new Date().toISOString() : minutesAgo(1),
      });
      mockDb.getActiveTeams.mockReturnValue([team]);

      stuckDetector.check();

      // Should NOT transition to 'failed' via launch timeout
      const failedCalls = mockDb.insertTransition.mock.calls.filter(
        (call: unknown[]) => {
          const arg = call[0] as Record<string, unknown>;
          return arg.reason && String(arg.reason).includes('Launch timeout');
        },
      );
      expect(failedCalls).toHaveLength(0);
    });
  }
});

// =============================================================================
// Existing idle/stuck detection still works
// =============================================================================

describe('Existing idle/stuck detection', () => {
  it('transitions running -> idle when lastEventAt exceeds idle threshold', () => {
    const team = makeTeam({
      status: 'running',
      lastEventAt: minutesAgo(6), // 6 min ago, past the 5 min idle threshold
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

  it('transitions idle -> stuck when lastEventAt exceeds stuck threshold', () => {
    const team = makeTeam({
      status: 'idle',
      lastEventAt: minutesAgo(11), // 11 min ago, past the 10 min stuck threshold
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
});

// =============================================================================
// Idle nudge message
// =============================================================================

describe('Idle nudge message', () => {
  it('sends idle_nudge message when running -> idle and resolveMessage returns a message', async () => {
    const { resolveMessage } = await import('../../src/server/utils/resolve-message.js');
    const mockedResolveMessage = vi.mocked(resolveMessage);
    mockedResolveMessage.mockReturnValue('FC status check: idle for 6 minutes');

    const team = makeTeam({
      status: 'running',
      lastEventAt: minutesAgo(6), // 6 min ago, past the 5 min idle threshold
    });
    mockDb.getActiveTeams.mockReturnValue([team]);

    stuckDetector.check();

    expect(mockedResolveMessage).toHaveBeenCalledWith('idle_nudge', {
      IDLE_MINUTES: '6',
    });
    expect(mockManager.sendMessage).toHaveBeenCalledWith(1, 'FC status check: idle for 6 minutes', 'fc', 'idle_nudge');

    // Reset mock to default
    mockedResolveMessage.mockReturnValue(null);
  });

  it('does NOT send idle_nudge message when resolveMessage returns null (template disabled)', async () => {
    const { resolveMessage } = await import('../../src/server/utils/resolve-message.js');
    const mockedResolveMessage = vi.mocked(resolveMessage);
    mockedResolveMessage.mockReturnValue(null);

    const team = makeTeam({
      status: 'running',
      lastEventAt: minutesAgo(6),
    });
    mockDb.getActiveTeams.mockReturnValue([team]);

    stuckDetector.check();

    // Transition should still happen
    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(1, { status: 'idle' });
    // But no message sent
    expect(mockManager.sendMessage).not.toHaveBeenCalled();
  });

  it('sends stuck_nudge message when idle -> stuck and resolveMessage returns a message', async () => {
    const { resolveMessage } = await import('../../src/server/utils/resolve-message.js');
    const mockedResolveMessage = vi.mocked(resolveMessage);
    // idle->stuck only calls resolveMessage once (for stuck_nudge, not idle_nudge)
    mockedResolveMessage.mockReturnValue('Hey, you have been idle for a while');

    const team = makeTeam({
      status: 'idle',
      lastEventAt: minutesAgo(11),
    });
    mockDb.getActiveTeams.mockReturnValue([team]);

    stuckDetector.check();

    expect(mockedResolveMessage).toHaveBeenCalledWith('stuck_nudge', {
      ISSUE_NUMBER: '100',
      ISSUE_KEY: '100',
    });
    expect(mockManager.sendMessage).toHaveBeenCalledWith(1, 'Hey, you have been idle for a while', 'fc', 'stuck_nudge');

    // Reset mock to default
    mockedResolveMessage.mockReturnValue(null);
  });

  it('does not crash check loop when getTeamManager throws during idle nudge', async () => {
    const { resolveMessage } = await import('../../src/server/utils/resolve-message.js');
    const mockedResolveMessage = vi.mocked(resolveMessage);
    mockedResolveMessage.mockReturnValue('FC status check: idle for 6 minutes');

    // Make getTeamManager throw on every call — all existing call sites are
    // already guarded by try/catch, so only the nudge send is being tested here
    mockGetTeamManager.mockImplementation(() => { throw new Error('TeamManager not initialized'); });

    const team = makeTeam({
      status: 'running',
      lastEventAt: minutesAgo(6),
    });
    mockDb.getActiveTeams.mockReturnValue([team]);

    // Should not throw despite getTeamManager throwing
    expect(() => stuckDetector.check()).not.toThrow();

    // Transition should still happen
    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(1, { status: 'idle' });
    // But sendMessage should NOT have been called (getTeamManager threw)
    expect(mockManager.sendMessage).not.toHaveBeenCalled();

    // Reset mock
    mockedResolveMessage.mockReturnValue(null);
  });

  it('does not crash check loop when getTeamManager throws during stuck nudge', async () => {
    const { resolveMessage } = await import('../../src/server/utils/resolve-message.js');
    const mockedResolveMessage = vi.mocked(resolveMessage);
    mockedResolveMessage.mockReturnValue('Hey, you have been idle for a while');

    // Make getTeamManager throw on every call
    mockGetTeamManager.mockImplementation(() => { throw new Error('TeamManager not initialized'); });

    const team = makeTeam({
      status: 'idle',
      lastEventAt: minutesAgo(11),
    });
    mockDb.getActiveTeams.mockReturnValue([team]);

    // Should not throw despite getTeamManager throwing
    expect(() => stuckDetector.check()).not.toThrow();

    // Transition should still happen
    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(1, { status: 'stuck' });
    // But sendMessage should NOT have been called (getTeamManager threw)
    expect(mockManager.sendMessage).not.toHaveBeenCalled();

    // Reset mock
    mockedResolveMessage.mockReturnValue(null);
  });

  it('skips idle_nudge when team has pending CI on PR', async () => {
    const { resolveMessage } = await import('../../src/server/utils/resolve-message.js');
    const mockedResolveMessage = vi.mocked(resolveMessage);
    mockedResolveMessage.mockReturnValue('FC status check: idle');

    const team = makeTeam({
      status: 'running',
      phase: 'pr',
      lastEventAt: minutesAgo(6),
      prNumber: 42,
    });
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({ ciStatus: 'pending' });

    stuckDetector.check();

    // Transition should be skipped entirely (CI pending)
    expect(mockDb.updateTeamSilent).not.toHaveBeenCalled();
    expect(mockManager.sendMessage).not.toHaveBeenCalled();

    // Reset mocks
    mockedResolveMessage.mockReturnValue(null);
    mockDb.getPullRequest.mockReturnValue(undefined);
  });
});

// =============================================================================
// Issue #690 — false-positive idle/stuck suppression
// =============================================================================

describe('Issue #690 — false-positive idle/stuck suppression', () => {
  // --- Fix A: suppress idle_nudge when subagent in progress ----------------
  describe('Fix A: idle_nudge suppressed when subagent active', () => {
    it('transitions to idle but does NOT send idle_nudge when a subagent is in_progress', async () => {
      const { resolveMessage } = await import('../../src/server/utils/resolve-message.js');
      const mockedResolveMessage = vi.mocked(resolveMessage);
      mockedResolveMessage.mockReturnValue('FC status check: idle for 6 minutes');

      const team = makeTeam({
        status: 'running',
        lastEventAt: minutesAgo(6),
      });
      mockDb.getActiveTeams.mockReturnValue([team]);
      mockDb.hasActiveSubagent.mockReturnValue(true);

      stuckDetector.check();

      // Transition should still happen — team genuinely has no TL events
      expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(1, { status: 'idle' });
      // But the nudge must NOT be sent (active subagent is working)
      expect(mockManager.sendMessage).not.toHaveBeenCalled();
      expect(mockDb.hasActiveSubagent).toHaveBeenCalledWith(1);

      mockedResolveMessage.mockReturnValue(null);
    });

    it('sends idle_nudge normally when no subagent is in_progress', async () => {
      const { resolveMessage } = await import('../../src/server/utils/resolve-message.js');
      const mockedResolveMessage = vi.mocked(resolveMessage);
      mockedResolveMessage.mockReturnValue('FC status check: idle for 6 minutes');

      const team = makeTeam({
        status: 'running',
        lastEventAt: minutesAgo(6),
      });
      mockDb.getActiveTeams.mockReturnValue([team]);
      mockDb.hasActiveSubagent.mockReturnValue(false);

      stuckDetector.check();

      expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(1, { status: 'idle' });
      expect(mockManager.sendMessage).toHaveBeenCalledWith(
        1,
        'FC status check: idle for 6 minutes',
        'fc',
        'idle_nudge',
      );

      mockedResolveMessage.mockReturnValue(null);
    });
  });

  // --- Fix B: suppress stuck detection while waiting on CI/merge ----------
  describe('Fix B: suppress idle/stuck while waiting on CI/merge', () => {
    it('does NOT transition to idle when phase=pr and mergeStatus=behind', () => {
      const team = makeTeam({
        status: 'running',
        phase: 'pr',
        lastEventAt: minutesAgo(6),
        prNumber: 42,
      });
      mockDb.getActiveTeams.mockReturnValue([team]);
      mockDb.getPullRequest.mockReturnValue({
        ciStatus: 'success',
        mergeStatus: 'behind',
      });

      stuckDetector.check();

      expect(mockDb.updateTeamSilent).not.toHaveBeenCalled();
      expect(mockDb.insertTransition).not.toHaveBeenCalled();
    });

    it('does NOT transition to idle when phase=pr and mergeStatus=blocked_ci_pending', () => {
      const team = makeTeam({
        status: 'running',
        phase: 'pr',
        lastEventAt: minutesAgo(6),
        prNumber: 42,
      });
      mockDb.getActiveTeams.mockReturnValue([team]);
      mockDb.getPullRequest.mockReturnValue({
        ciStatus: 'success',
        mergeStatus: 'blocked_ci_pending',
      });

      stuckDetector.check();

      expect(mockDb.updateTeamSilent).not.toHaveBeenCalled();
      expect(mockDb.insertTransition).not.toHaveBeenCalled();
    });

    it('does NOT transition idle -> stuck when phase=pr and ciStatus=pending', () => {
      const team = makeTeam({
        status: 'idle',
        phase: 'pr',
        lastEventAt: minutesAgo(11),
        prNumber: 42,
      });
      mockDb.getActiveTeams.mockReturnValue([team]);
      mockDb.getPullRequest.mockReturnValue({ ciStatus: 'pending' });

      stuckDetector.check();

      expect(mockDb.updateTeamSilent).not.toHaveBeenCalled();
    });

    it('DOES transition to idle when phase is not pr, regardless of PR state', () => {
      const team = makeTeam({
        status: 'running',
        phase: 'implementing', // not pr
        lastEventAt: minutesAgo(6),
        prNumber: 42,
      });
      mockDb.getActiveTeams.mockReturnValue([team]);
      // Even with pending CI, the phase guard only kicks in for phase=pr
      mockDb.getPullRequest.mockReturnValue({ ciStatus: 'success', mergeStatus: 'clean' });

      stuckDetector.check();

      expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(1, { status: 'idle' });
    });
  });

  // --- Fix C: clamp idleMin to >= 0 ---------------------------------------
  describe('Fix C: idleMin clamped to non-negative', () => {
    it('does not treat a negative idle time as exceeding the idle threshold', () => {
      // lastEventAt in the future (clock skew) → raw idleMinutes would be negative
      const team = makeTeam({
        status: 'running',
        lastEventAt: new Date(Date.now() + 60_000).toISOString(), // 1 min in future
      });
      mockDb.getActiveTeams.mockReturnValue([team]);

      stuckDetector.check();

      // Clamped to 0 — must not transition
      expect(mockDb.updateTeamSilent).not.toHaveBeenCalled();
      expect(mockDb.insertTransition).not.toHaveBeenCalled();
    });
  });

  // --- Fix D: do not compute idle/stuck for queued/launching/done/failed ---
  describe('Fix D: skip queued/launching/done/failed teams', () => {
    it('skips queued team that has been queued for hours', () => {
      const team = makeTeam({
        status: 'queued',
        // lastEventAt very old — would easily exceed any threshold
        lastEventAt: minutesAgo(120),
        launchedAt: null,
      });
      mockDb.getActiveTeams.mockReturnValue([team]);

      stuckDetector.check();

      // No status change, no transition
      expect(mockDb.updateTeamSilent).not.toHaveBeenCalled();
      expect(mockDb.insertTransition).not.toHaveBeenCalled();
      expect(mockManager.sendMessage).not.toHaveBeenCalled();
    });

    it('does not mark a recent launching team as idle/stuck via the event-time path', () => {
      // launching team within the launch-timeout window, but with an old
      // lastEventAt — must not fall through to idle/stuck detection.
      const team = makeTeam({
        status: 'launching',
        launchedAt: minutesAgo(2),
        lastEventAt: minutesAgo(30),
      });
      mockDb.getActiveTeams.mockReturnValue([team]);

      stuckDetector.check();

      // Launch-timeout should not fire (2 < 5), and idle/stuck path must be skipped.
      expect(mockDb.insertTransition).not.toHaveBeenCalled();
      expect(mockDb.updateTeamSilent).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// Subagent stuck detection (#689)
// =============================================================================
//
// FC's per-subagent watchdog: when a subagent goes silent past
// FLEET_SUBAGENT_STUCK_THRESHOLD_MIN while the team has an in_progress
// team_tasks row, FC sends `subagent_stuck` to the TL via stdin instead of
// letting the TL silently absorb the subagent's role at 2x cost.
//
// Each test uses a unique toolUseId (the dedup key includes it) so the
// singleton stuckDetector's emittedSubagentStuck Set does not bleed state
// across tests.
// =============================================================================

describe('Subagent stuck detection (#689)', () => {
  function makeActivity(
    agentName: string,
    idleMinutes: number,
    toolUseId: string,
  ): Map<string, SubagentActivityEntry> {
    const m = new Map<string, SubagentActivityEntry>();
    const lastEventAt = Date.now() - idleMinutes * 60_000;
    const startedAt = lastEventAt - 60_000;
    m.set(agentName, { lastEventAt, toolUseId, startedAt });
    return m;
  }

  it('emits subagent_stuck with correct payload when a subagent is silent past threshold', async () => {
    const { resolveMessage } = await import('../../src/server/utils/resolve-message.js');
    const mockedResolveMessage = vi.mocked(resolveMessage);
    mockedResolveMessage.mockReturnValue(
      "FC subagent watchdog: subagent 'dev' has been silent for 4 minutes (tool_use_id=tu_001). ...",
    );

    const team = makeTeam({
      id: 1,
      status: 'running',
      lastEventAt: minutesAgo(1), // TL itself is fine
    });
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.hasActiveSubagent.mockReturnValue(true);
    mockManager.getSubagentActivity.mockReturnValue(makeActivity('dev', 4, 'tu_001'));

    stuckDetector.check();

    expect(mockManager.sendMessage).toHaveBeenCalledWith(
      1,
      expect.stringContaining("subagent 'dev'"),
      'fc',
      'subagent_stuck',
    );
    expect(mockSseBroker.broadcast).toHaveBeenCalledWith(
      'team_warning',
      expect.objectContaining({
        team_id: 1,
        warning_type: 'subagent_stuck',
        details: expect.objectContaining({
          agent_name: 'dev',
          tool_use_id: 'tu_001',
        }),
      }),
      1,
    );
    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        fromStatus: 'running',
        toStatus: 'running',
        trigger: 'timer',
        reason: expect.stringContaining('subagent_stuck'),
      }),
    );

    mockedResolveMessage.mockReturnValue(null);
  });

  it('emits subagent_stuck for a silent subagent on an idle team', async () => {
    const { resolveMessage } = await import('../../src/server/utils/resolve-message.js');
    const mockedResolveMessage = vi.mocked(resolveMessage);
    mockedResolveMessage.mockReturnValue('FC subagent watchdog: subagent ...');

    const team = makeTeam({
      id: 2,
      status: 'idle',
      lastEventAt: minutesAgo(7),
    });
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.hasActiveSubagent.mockReturnValue(true);
    mockManager.getSubagentActivity.mockReturnValue(makeActivity('reviewer', 5, 'tu_002'));

    stuckDetector.check();

    expect(mockManager.sendMessage).toHaveBeenCalledWith(
      2,
      expect.any(String),
      'fc',
      'subagent_stuck',
    );

    mockedResolveMessage.mockReturnValue(null);
  });

  it('does NOT emit twice for the same (team, agent, toolUseId) — dedup works', async () => {
    const { resolveMessage } = await import('../../src/server/utils/resolve-message.js');
    const mockedResolveMessage = vi.mocked(resolveMessage);
    mockedResolveMessage.mockReturnValue('subagent_stuck msg');

    const team = makeTeam({
      id: 3,
      status: 'running',
      lastEventAt: minutesAgo(1),
    });
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.hasActiveSubagent.mockReturnValue(true);

    // First pass: still silent, same toolUseId.
    mockManager.getSubagentActivity.mockReturnValue(makeActivity('dev', 4, 'tu_dedup'));
    stuckDetector.check();
    expect(mockManager.sendMessage).toHaveBeenCalledTimes(1);

    // Second pass: still silent, same toolUseId — dedup must suppress.
    mockManager.getSubagentActivity.mockReturnValue(makeActivity('dev', 5, 'tu_dedup'));
    stuckDetector.check();
    expect(mockManager.sendMessage).toHaveBeenCalledTimes(1);

    mockedResolveMessage.mockReturnValue(null);
  });

  it('does NOT emit when subagentStuckThresholdMin is 0 (feature disabled)', async () => {
    const configMod = await import('../../src/server/config.js');
    const cfg = configMod.default as unknown as { subagentStuckThresholdMin: number };
    const original = cfg.subagentStuckThresholdMin;
    cfg.subagentStuckThresholdMin = 0;

    try {
      const team = makeTeam({ id: 4, status: 'running', lastEventAt: minutesAgo(1) });
      mockDb.getActiveTeams.mockReturnValue([team]);
      mockDb.hasActiveSubagent.mockReturnValue(true);
      mockManager.getSubagentActivity.mockReturnValue(makeActivity('dev', 30, 'tu_disabled'));

      stuckDetector.check();

      expect(mockManager.sendMessage).not.toHaveBeenCalled();
      expect(mockSseBroker.broadcast).not.toHaveBeenCalledWith(
        'team_warning',
        expect.anything(),
        expect.anything(),
      );
    } finally {
      cfg.subagentStuckThresholdMin = original;
    }
  });

  it('does NOT emit when no in_progress task exists (hasActiveSubagent=false)', () => {
    const team = makeTeam({ id: 5, status: 'running', lastEventAt: minutesAgo(1) });
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.hasActiveSubagent.mockReturnValue(false);
    mockManager.getSubagentActivity.mockReturnValue(makeActivity('dev', 30, 'tu_no_task'));

    stuckDetector.check();

    expect(mockManager.sendMessage).not.toHaveBeenCalled();
  });

  it('does NOT emit while team is in extended thinking', () => {
    const team = makeTeam({ id: 6, status: 'running', lastEventAt: minutesAgo(1) });
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.hasActiveSubagent.mockReturnValue(true);
    mockManager.thinkingTeams.add(6);
    mockManager.getSubagentActivity.mockReturnValue(makeActivity('dev', 30, 'tu_thinking'));

    stuckDetector.check();

    expect(mockManager.sendMessage).not.toHaveBeenCalled();
    mockManager.thinkingTeams.delete(6);
  });

  it('does NOT emit for terminal-status teams (queued/launching/done/failed not in active list)', () => {
    // queued/launching are filtered by status check; even if hasActiveSubagent
    // returned true (it shouldn't), the status guard skips detection.
    const team = makeTeam({ id: 7, status: 'launching', lastEventAt: minutesAgo(1) });
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.hasActiveSubagent.mockReturnValue(true);
    mockManager.getSubagentActivity.mockReturnValue(makeActivity('dev', 30, 'tu_launching'));

    stuckDetector.check();

    expect(mockManager.sendMessage).not.toHaveBeenCalled();
  });

  it('does NOT emit when idle minutes are below threshold', () => {
    const team = makeTeam({ id: 8, status: 'running', lastEventAt: minutesAgo(1) });
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.hasActiveSubagent.mockReturnValue(true);
    // 2 min idle < 3 min threshold
    mockManager.getSubagentActivity.mockReturnValue(makeActivity('dev', 2, 'tu_within'));

    stuckDetector.check();

    expect(mockManager.sendMessage).not.toHaveBeenCalled();
  });

  it('does NOT emit when no subagent activity entries exist', () => {
    const team = makeTeam({ id: 9, status: 'running', lastEventAt: minutesAgo(1) });
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.hasActiveSubagent.mockReturnValue(true);
    // Empty activity map — TL hasn't spawned any subagent yet (or all have
    // completed). The DB's hasActiveSubagent may be true from a stale or
    // mismatched team_tasks row, but with no in-memory activity to track,
    // the watchdog has nothing to evaluate.
    mockManager.getSubagentActivity.mockReturnValue(new Map());

    stuckDetector.check();

    expect(mockManager.sendMessage).not.toHaveBeenCalled();
  });

  it('emits a separate warning for a respawn (new toolUseId resets dedup slate)', async () => {
    const { resolveMessage } = await import('../../src/server/utils/resolve-message.js');
    const mockedResolveMessage = vi.mocked(resolveMessage);
    mockedResolveMessage.mockReturnValue('subagent_stuck msg');

    const team = makeTeam({ id: 10, status: 'running', lastEventAt: minutesAgo(1) });
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.hasActiveSubagent.mockReturnValue(true);

    // First spawn — emits.
    mockManager.getSubagentActivity.mockReturnValue(makeActivity('dev', 4, 'tu_respawn_1'));
    stuckDetector.check();
    expect(mockManager.sendMessage).toHaveBeenCalledTimes(1);

    // After respawn — same agent name, different toolUseId — must emit again.
    mockManager.getSubagentActivity.mockReturnValue(makeActivity('dev', 4, 'tu_respawn_2'));
    stuckDetector.check();
    expect(mockManager.sendMessage).toHaveBeenCalledTimes(2);

    mockedResolveMessage.mockReturnValue(null);
  });

  it('warns multiple distinct subagents in the same team independently', async () => {
    const { resolveMessage } = await import('../../src/server/utils/resolve-message.js');
    const mockedResolveMessage = vi.mocked(resolveMessage);
    mockedResolveMessage.mockReturnValue('subagent_stuck msg');

    const team = makeTeam({ id: 11, status: 'running', lastEventAt: minutesAgo(1) });
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.hasActiveSubagent.mockReturnValue(true);

    const activity = new Map<string, SubagentActivityEntry>();
    activity.set('dev', {
      lastEventAt: Date.now() - 4 * 60_000,
      toolUseId: 'tu_multi_dev',
      startedAt: Date.now() - 5 * 60_000,
    });
    activity.set('reviewer', {
      lastEventAt: Date.now() - 5 * 60_000,
      toolUseId: 'tu_multi_rev',
      startedAt: Date.now() - 6 * 60_000,
    });
    mockManager.getSubagentActivity.mockReturnValue(activity);

    stuckDetector.check();

    // One sendMessage per distinct stuck subagent.
    expect(mockManager.sendMessage).toHaveBeenCalledTimes(2);

    mockedResolveMessage.mockReturnValue(null);
  });
});
