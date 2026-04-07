// =============================================================================
// Fleet Commander — UsageTracker tests
// =============================================================================
// Tests for:
// 1. UsagePoller.start() DB seeding of zone state (issue #66)
// 2. processUsageSnapshot() zone transition and queue drain (issue #533)
// 3. UsageZone hard_red state (issue #678)
// 4. isUsageBlocked() (issue #678)
// 5. Override activation/deactivation (issue #678)
// 6. Override auto-deactivation (issue #678)
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted ensures variables are available in hoisted vi.mock factories
// ---------------------------------------------------------------------------

const mockGetLatestUsage = vi.hoisted(() => vi.fn());
const mockInsertUsageSnapshot = vi.hoisted(() => vi.fn());
const mockGetProjects = vi.hoisted(() => vi.fn());
const mockGetQueuedTeamsByProject = vi.hoisted(() => vi.fn());

vi.mock('../../src/server/db.js', () => ({
  getDatabase: () => ({
    getLatestUsage: mockGetLatestUsage,
    insertUsageSnapshot: mockInsertUsageSnapshot,
    getProjects: mockGetProjects,
    getQueuedTeamsByProject: mockGetQueuedTeamsByProject,
  }),
}));

vi.mock('../../src/server/config.js', () => ({
  default: {
    usagePollIntervalMs: 900_000,
    usageRedDailyPct: 85,
    usageRedWeeklyPct: 95,
    usageHardExtraPct: 90,
  },
}));

const mockBroadcast = vi.hoisted(() => vi.fn());

vi.mock('../../src/server/services/sse-broker.js', () => ({
  sseBroker: {
    broadcast: mockBroadcast,
  },
}));

const mockProcessQueue = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../src/server/services/team-manager.js', () => ({
  getTeamManager: () => ({
    processQueue: mockProcessQueue,
  }),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  usagePoller,
  getUsageZone,
  processUsageSnapshot,
  isUsageBlocked,
  isUsageOverrideActive,
  isHardPaused,
  activateUsageOverride,
  deactivateUsageOverride,
} from '../../src/server/services/usage-tracker.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UsagePoller.start() — DB seeding of zone state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Stop any running interval from a previous test
    usagePoller.stop();
  });

  it('seeds _lastZone to red when the latest DB snapshot exceeds the daily threshold', () => {
    mockGetLatestUsage.mockReturnValue({
      id: 1,
      teamId: null,
      projectId: null,
      sessionId: null,
      dailyPercent: 90,
      weeklyPercent: 50,
      sonnetPercent: 0,
      extraPercent: 0,
      dailyResetsAt: null,
      weeklyResetsAt: null,
      rawOutput: null,
      recordedAt: '2026-03-18T00:00:00Z',
    });

    // Stub poll() to prevent actual HTTP calls
    const pollSpy = vi.spyOn(usagePoller, 'poll').mockImplementation(() => {});

    usagePoller.start();

    expect(mockGetLatestUsage).toHaveBeenCalledTimes(1);
    expect(getUsageZone()).toBe('red');

    usagePoller.stop();
    pollSpy.mockRestore();
  });

  it('seeds _lastZone to red when the latest DB snapshot exceeds the weekly threshold', () => {
    mockGetLatestUsage.mockReturnValue({
      id: 2,
      teamId: null,
      projectId: null,
      sessionId: null,
      dailyPercent: 10,
      weeklyPercent: 96,
      sonnetPercent: 0,
      extraPercent: 0,
      dailyResetsAt: null,
      weeklyResetsAt: null,
      rawOutput: null,
      recordedAt: '2026-03-18T00:00:00Z',
    });

    const pollSpy = vi.spyOn(usagePoller, 'poll').mockImplementation(() => {});

    usagePoller.start();

    expect(getUsageZone()).toBe('red');

    usagePoller.stop();
    pollSpy.mockRestore();
  });

  it('seeds _lastZone to green when the latest DB snapshot is below thresholds', () => {
    mockGetLatestUsage.mockReturnValue({
      id: 3,
      teamId: null,
      projectId: null,
      sessionId: null,
      dailyPercent: 40,
      weeklyPercent: 60,
      sonnetPercent: 0,
      extraPercent: 0,
      dailyResetsAt: null,
      weeklyResetsAt: null,
      rawOutput: null,
      recordedAt: '2026-03-18T00:00:00Z',
    });

    const pollSpy = vi.spyOn(usagePoller, 'poll').mockImplementation(() => {});

    usagePoller.start();

    expect(getUsageZone()).toBe('green');

    usagePoller.stop();
    pollSpy.mockRestore();
  });

  it('keeps defaults (green) when no usage snapshots exist in DB', () => {
    mockGetLatestUsage.mockReturnValue(undefined);

    const pollSpy = vi.spyOn(usagePoller, 'poll').mockImplementation(() => {});

    usagePoller.start();

    expect(mockGetLatestUsage).toHaveBeenCalledTimes(1);
    expect(getUsageZone()).toBe('green');

    usagePoller.stop();
    pollSpy.mockRestore();
  });

  it('keeps defaults (green) when getLatestUsage throws', () => {
    mockGetLatestUsage.mockImplementation(() => {
      throw new Error('DB locked');
    });

    const pollSpy = vi.spyOn(usagePoller, 'poll').mockImplementation(() => {});

    // Should not throw — error is caught and logged
    expect(() => usagePoller.start()).not.toThrow();

    expect(getUsageZone()).toBe('green');

    usagePoller.stop();
    pollSpy.mockRestore();
  });

  it('seeds _latestExtra from DB and computes hard_red zone', () => {
    mockGetLatestUsage.mockReturnValue({
      id: 4,
      teamId: null,
      projectId: null,
      sessionId: null,
      dailyPercent: 10,
      weeklyPercent: 10,
      sonnetPercent: 0,
      extraPercent: 92,
      dailyResetsAt: null,
      weeklyResetsAt: null,
      rawOutput: null,
      recordedAt: '2026-03-18T00:00:00Z',
    });

    const pollSpy = vi.spyOn(usagePoller, 'poll').mockImplementation(() => {});

    usagePoller.start();

    expect(getUsageZone()).toBe('hard_red');

    usagePoller.stop();
    pollSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// processUsageSnapshot() — zone transition and queue drain (issue #533)
// ---------------------------------------------------------------------------

describe('processUsageSnapshot() — zone transition and queue drain', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetProjects.mockReturnValue([]);
    mockGetQueuedTeamsByProject.mockReturnValue([]);
    // Reset to green by submitting low values
    await processUsageSnapshot({ dailyPercent: 0, weeklyPercent: 0, extraPercent: 0 });
    vi.clearAllMocks();
    mockGetProjects.mockReturnValue([]);
    mockGetQueuedTeamsByProject.mockReturnValue([]);
  });

  it('should update _latestDaily and _latestWeekly from submitted data', async () => {
    // Submit low values => zone should be green
    await processUsageSnapshot({ dailyPercent: 50, weeklyPercent: 60 });
    expect(getUsageZone()).toBe('green');

    // Submit high daily value => zone should be red (85 threshold)
    await processUsageSnapshot({ dailyPercent: 90, weeklyPercent: 50 });
    expect(getUsageZone()).toBe('red');
  });

  it('should trigger queue drain on red-to-green transition', async () => {
    mockGetProjects.mockReturnValue([{ id: 1, slug: 'test-proj', status: 'active' }]);
    mockGetQueuedTeamsByProject.mockReturnValue([{ id: 10, status: 'queued' }]);

    // Set zone to red
    await processUsageSnapshot({ dailyPercent: 90, weeklyPercent: 50 });
    expect(getUsageZone()).toBe('red');
    expect(mockProcessQueue).not.toHaveBeenCalled();

    // Transition to green
    await processUsageSnapshot({ dailyPercent: 10, weeklyPercent: 10 });
    expect(getUsageZone()).toBe('green');
    expect(mockProcessQueue).toHaveBeenCalledWith(1);
  });

  it('should not trigger queue drain when zone stays green', async () => {
    await processUsageSnapshot({ dailyPercent: 10, weeklyPercent: 10 });
    expect(getUsageZone()).toBe('green');

    await processUsageSnapshot({ dailyPercent: 20, weeklyPercent: 20 });
    expect(getUsageZone()).toBe('green');

    expect(mockProcessQueue).not.toHaveBeenCalled();
  });

  it('should not trigger queue drain when zone stays red', async () => {
    mockGetProjects.mockReturnValue([{ id: 1, slug: 'test-proj', status: 'active' }]);
    mockGetQueuedTeamsByProject.mockReturnValue([{ id: 10, status: 'queued' }]);

    await processUsageSnapshot({ dailyPercent: 90, weeklyPercent: 50 });
    expect(getUsageZone()).toBe('red');

    await processUsageSnapshot({ dailyPercent: 92, weeklyPercent: 50 });
    expect(getUsageZone()).toBe('red');

    expect(mockProcessQueue).not.toHaveBeenCalled();
  });

  it('should not trigger queue drain on green-to-red transition', async () => {
    await processUsageSnapshot({ dailyPercent: 10, weeklyPercent: 10 });
    expect(getUsageZone()).toBe('green');

    await processUsageSnapshot({ dailyPercent: 90, weeklyPercent: 50 });
    expect(getUsageZone()).toBe('red');

    expect(mockProcessQueue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// UsageZone hard_red state (issue #678)
// ---------------------------------------------------------------------------

describe('UsageZone hard_red state', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetProjects.mockReturnValue([]);
    mockGetQueuedTeamsByProject.mockReturnValue([]);
    // Reset to green
    await processUsageSnapshot({ dailyPercent: 0, weeklyPercent: 0, extraPercent: 0 });
    vi.clearAllMocks();
  });

  it('returns hard_red when extraPercent >= usageHardExtraPct', async () => {
    await processUsageSnapshot({ extraPercent: 92 });
    expect(getUsageZone()).toBe('hard_red');
  });

  it('returns red when daily is high but extra is below hard threshold', async () => {
    await processUsageSnapshot({ dailyPercent: 90, weeklyPercent: 50, extraPercent: 50 });
    expect(getUsageZone()).toBe('red');
  });

  it('returns hard_red even when daily/weekly are also high', async () => {
    await processUsageSnapshot({ dailyPercent: 90, weeklyPercent: 96, extraPercent: 95 });
    expect(getUsageZone()).toBe('hard_red');
  });

  it('returns green when all values are below thresholds', async () => {
    await processUsageSnapshot({ dailyPercent: 10, weeklyPercent: 10, extraPercent: 10 });
    expect(getUsageZone()).toBe('green');
  });
});

// ---------------------------------------------------------------------------
// isUsageBlocked() (issue #678)
// ---------------------------------------------------------------------------

describe('isUsageBlocked()', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetProjects.mockReturnValue([]);
    mockGetQueuedTeamsByProject.mockReturnValue([]);
    // Reset to green and deactivate any override
    await processUsageSnapshot({ dailyPercent: 0, weeklyPercent: 0, extraPercent: 0 });
    deactivateUsageOverride();
    vi.clearAllMocks();
  });

  it('returns true when zone is red and override not active', async () => {
    await processUsageSnapshot({ dailyPercent: 90, weeklyPercent: 50 });
    expect(isUsageBlocked()).toBe(true);
  });

  it('returns false when zone is red and override IS active', async () => {
    await processUsageSnapshot({ dailyPercent: 90, weeklyPercent: 50 });
    await activateUsageOverride();
    expect(isUsageBlocked()).toBe(false);
  });

  it('returns true when zone is hard_red even with override active', async () => {
    // Start in red, activate override, then move to hard_red
    await processUsageSnapshot({ dailyPercent: 90, weeklyPercent: 50, extraPercent: 50 });
    await activateUsageOverride();
    expect(isUsageBlocked()).toBe(false);
    // Now push extra above hard threshold — override auto-clears
    await processUsageSnapshot({ dailyPercent: 90, weeklyPercent: 50, extraPercent: 95 });
    expect(isUsageBlocked()).toBe(true);
    expect(getUsageZone()).toBe('hard_red');
  });

  it('returns false when zone is green', async () => {
    await processUsageSnapshot({ dailyPercent: 10, weeklyPercent: 10, extraPercent: 0 });
    expect(isUsageBlocked()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Override activation/deactivation (issue #678)
// ---------------------------------------------------------------------------

describe('Override activation/deactivation', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetProjects.mockReturnValue([]);
    mockGetQueuedTeamsByProject.mockReturnValue([]);
    // Reset to green and deactivate any override
    await processUsageSnapshot({ dailyPercent: 0, weeklyPercent: 0, extraPercent: 0 });
    deactivateUsageOverride();
    vi.clearAllMocks();
  });

  it('activateUsageOverride() succeeds when zone is red', async () => {
    await processUsageSnapshot({ dailyPercent: 90, weeklyPercent: 50 });
    vi.clearAllMocks();

    const result = await activateUsageOverride();
    expect(result).toEqual({ overrideActive: true, hardPaused: false });
    expect(isUsageOverrideActive()).toBe(true);
    expect(mockBroadcast).toHaveBeenCalledWith('usage_override_changed', {
      overrideActive: true,
      hardPaused: false,
    });
  });

  it('activateUsageOverride() refuses when zone is hard_red', async () => {
    await processUsageSnapshot({ extraPercent: 95 });
    vi.clearAllMocks();

    const result = await activateUsageOverride();
    expect(result).toEqual({ overrideActive: false, hardPaused: true });
    expect(isUsageOverrideActive()).toBe(false);
  });

  it('activateUsageOverride() refuses when zone is green (no pause to override)', async () => {
    await processUsageSnapshot({ dailyPercent: 10, weeklyPercent: 10, extraPercent: 0 });
    vi.clearAllMocks();

    const result = await activateUsageOverride();
    expect(result).toEqual({ overrideActive: false, hardPaused: false });
    expect(isUsageOverrideActive()).toBe(false);
  });

  it('deactivateUsageOverride() clears override', async () => {
    await processUsageSnapshot({ dailyPercent: 90, weeklyPercent: 50 });
    await activateUsageOverride();
    expect(isUsageOverrideActive()).toBe(true);
    vi.clearAllMocks();

    const result = deactivateUsageOverride();
    expect(result.overrideActive).toBe(false);
    expect(isUsageOverrideActive()).toBe(false);
    expect(mockBroadcast).toHaveBeenCalledWith('usage_override_changed', {
      overrideActive: false,
      hardPaused: false,
    });
  });

  it('triggers queue drain on activation when projects have queued teams', async () => {
    mockGetProjects.mockReturnValue([{ id: 1, slug: 'test-proj', status: 'active' }]);
    mockGetQueuedTeamsByProject.mockReturnValue([{ id: 10, status: 'queued' }]);

    await processUsageSnapshot({ dailyPercent: 90, weeklyPercent: 50 });
    vi.clearAllMocks();
    mockGetProjects.mockReturnValue([{ id: 1, slug: 'test-proj', status: 'active' }]);
    mockGetQueuedTeamsByProject.mockReturnValue([{ id: 10, status: 'queued' }]);

    await activateUsageOverride();
    expect(mockProcessQueue).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// Override auto-deactivation (issue #678)
// ---------------------------------------------------------------------------

describe('Override auto-deactivation', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetProjects.mockReturnValue([]);
    mockGetQueuedTeamsByProject.mockReturnValue([]);
    // Reset to green and deactivate any override
    await processUsageSnapshot({ dailyPercent: 0, weeklyPercent: 0, extraPercent: 0 });
    deactivateUsageOverride();
    vi.clearAllMocks();
    mockGetProjects.mockReturnValue([]);
    mockGetQueuedTeamsByProject.mockReturnValue([]);
  });

  it('clears override when zone transitions from red to green', async () => {
    // Go red, activate override
    await processUsageSnapshot({ dailyPercent: 90, weeklyPercent: 50, extraPercent: 0 });
    await activateUsageOverride();
    expect(isUsageOverrideActive()).toBe(true);
    vi.clearAllMocks();

    // Submit low values — zone becomes green, override should auto-clear
    await processUsageSnapshot({ dailyPercent: 10, weeklyPercent: 10, extraPercent: 0 });
    expect(getUsageZone()).toBe('green');
    expect(isUsageOverrideActive()).toBe(false);

    // Should have broadcast usage_override_changed with overrideActive: false
    const overrideBroadcasts = mockBroadcast.mock.calls.filter(
      (call: unknown[]) => call[0] === 'usage_override_changed',
    );
    expect(overrideBroadcasts.length).toBeGreaterThan(0);
    expect(overrideBroadcasts[overrideBroadcasts.length - 1][1]).toEqual({
      overrideActive: false,
      hardPaused: false,
    });
  });

  it('clears override when extra hits hard limit', async () => {
    // Go red with override active
    await processUsageSnapshot({ dailyPercent: 90, weeklyPercent: 50, extraPercent: 50 });
    await activateUsageOverride();
    expect(isUsageOverrideActive()).toBe(true);
    vi.clearAllMocks();

    // Submit high extra — zone becomes hard_red, override should auto-clear
    await processUsageSnapshot({ dailyPercent: 90, weeklyPercent: 50, extraPercent: 95 });
    expect(getUsageZone()).toBe('hard_red');
    expect(isUsageOverrideActive()).toBe(false);
    expect(isHardPaused()).toBe(true);

    // Should have broadcast usage_override_changed with hardPaused: true
    const overrideBroadcasts = mockBroadcast.mock.calls.filter(
      (call: unknown[]) => call[0] === 'usage_override_changed',
    );
    expect(overrideBroadcasts.length).toBeGreaterThan(0);
    expect(overrideBroadcasts[overrideBroadcasts.length - 1][1]).toEqual({
      overrideActive: false,
      hardPaused: true,
    });
  });
});
