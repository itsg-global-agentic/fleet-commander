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
};

const mockSseBroker = {
  broadcast: vi.fn(),
};

const mockManager = {
  stop: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn(),
  syncStreamActivityToDb: vi.fn(),
  getLastStreamAt: vi.fn().mockReturnValue(null),
  thinkingTeams: new Set<number>(),
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
