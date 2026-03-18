// =============================================================================
// Fleet Commander — UsagePoller.start() DB seeding tests (issue #66)
// =============================================================================
// Verifies that _lastZone, _latestDaily, and _latestWeekly are hydrated from
// the latest usage_snapshots DB row on startup, so that zone transitions
// (especially red -> green) are correctly detected after a server restart.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

const mockGetLatestUsage = vi.fn();

vi.mock('../../src/server/db.js', () => ({
  getDatabase: () => ({
    getLatestUsage: mockGetLatestUsage,
    insertUsageSnapshot: vi.fn(),
  }),
}));

vi.mock('../../src/server/config.js', () => ({
  default: {
    usagePollIntervalMs: 900_000,
    usageRedDailyPct: 85,
    usageRedWeeklyPct: 95,
  },
}));

vi.mock('../../src/server/services/sse-broker.js', () => ({
  sseBroker: {
    broadcast: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { usagePoller, getUsageZone } from '../../src/server/services/usage-tracker.js';

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
});
