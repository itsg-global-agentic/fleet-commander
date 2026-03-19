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
  insertTransition: vi.fn(),
  getPullRequest: vi.fn(),
};

const mockSseBroker = {
  broadcast: vi.fn(),
};

const mockManager = {
  stop: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn(),
};

vi.mock('../../src/server/db.js', () => ({
  getDatabase: () => mockDb,
}));

vi.mock('../../src/server/services/sse-broker.js', () => ({
  sseBroker: mockSseBroker,
}));

vi.mock('../../src/server/services/team-manager.js', () => ({
  getTeamManager: () => mockManager,
}));

vi.mock('../../src/server/utils/resolve-message.js', () => ({
  resolveMessage: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/server/config.js', () => ({
  default: {
    stuckCheckIntervalMs: 60000,
    idleThresholdMin: 3,
    stuckThresholdMin: 5,
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
    expect(mockDb.updateTeam).toHaveBeenCalledWith(1, { status: 'failed' });
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
    expect(mockDb.updateTeam).not.toHaveBeenCalled();
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
    expect(mockDb.updateTeam).toHaveBeenCalledWith(1, { status: 'failed' });
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
    expect(mockDb.updateTeam).not.toHaveBeenCalled();
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
      lastEventAt: minutesAgo(4), // 4 min ago, past the 3 min idle threshold
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
    expect(mockDb.updateTeam).toHaveBeenCalledWith(1, { status: 'idle' });
  });

  it('transitions idle -> stuck when lastEventAt exceeds stuck threshold', () => {
    const team = makeTeam({
      status: 'idle',
      lastEventAt: minutesAgo(6), // 6 min ago, past the 5 min stuck threshold
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
    expect(mockDb.updateTeam).toHaveBeenCalledWith(1, { status: 'stuck' });
  });
});

// =============================================================================
// Idle nudge message
// =============================================================================

describe('Idle nudge message', () => {
  it('sends idle_nudge message when running -> idle and resolveMessage returns a message', async () => {
    const { resolveMessage } = await import('../../src/server/utils/resolve-message.js');
    const mockedResolveMessage = vi.mocked(resolveMessage);
    mockedResolveMessage.mockReturnValue('FC status check: idle for 4 minutes');

    const team = makeTeam({
      status: 'running',
      lastEventAt: minutesAgo(4), // 4 min ago, past the 3 min idle threshold
    });
    mockDb.getActiveTeams.mockReturnValue([team]);

    stuckDetector.check();

    expect(mockedResolveMessage).toHaveBeenCalledWith('idle_nudge', {
      IDLE_MINUTES: '4',
    });
    expect(mockManager.sendMessage).toHaveBeenCalledWith(1, 'FC status check: idle for 4 minutes');

    // Reset mock to default
    mockedResolveMessage.mockReturnValue(null);
  });

  it('does NOT send idle_nudge message when resolveMessage returns null (template disabled)', async () => {
    const { resolveMessage } = await import('../../src/server/utils/resolve-message.js');
    const mockedResolveMessage = vi.mocked(resolveMessage);
    mockedResolveMessage.mockReturnValue(null);

    const team = makeTeam({
      status: 'running',
      lastEventAt: minutesAgo(4),
    });
    mockDb.getActiveTeams.mockReturnValue([team]);

    stuckDetector.check();

    // Transition should still happen
    expect(mockDb.updateTeam).toHaveBeenCalledWith(1, { status: 'idle' });
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
      lastEventAt: minutesAgo(6),
    });
    mockDb.getActiveTeams.mockReturnValue([team]);

    stuckDetector.check();

    expect(mockedResolveMessage).toHaveBeenCalledWith('stuck_nudge', {
      ISSUE_NUMBER: '100',
    });
    expect(mockManager.sendMessage).toHaveBeenCalledWith(1, 'Hey, you have been idle for a while');

    // Reset mock to default
    mockedResolveMessage.mockReturnValue(null);
  });

  it('skips idle_nudge when team has pending CI on PR', async () => {
    const { resolveMessage } = await import('../../src/server/utils/resolve-message.js');
    const mockedResolveMessage = vi.mocked(resolveMessage);
    mockedResolveMessage.mockReturnValue('FC status check: idle');

    const team = makeTeam({
      status: 'running',
      lastEventAt: minutesAgo(4),
      prNumber: 42,
    });
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getPullRequest.mockReturnValue({ ciStatus: 'pending' });

    stuckDetector.check();

    // Transition should be skipped entirely (CI pending)
    expect(mockDb.updateTeam).not.toHaveBeenCalled();
    expect(mockManager.sendMessage).not.toHaveBeenCalled();

    // Reset mocks
    mockedResolveMessage.mockReturnValue(null);
    mockDb.getPullRequest.mockReturnValue(undefined);
  });
});
