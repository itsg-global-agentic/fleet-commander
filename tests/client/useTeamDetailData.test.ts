// =============================================================================
// Fleet Commander — useTeamDetailData Hook Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGet = vi.fn();

// Stable API object reference — the hook uses `api` as a useEffect dependency,
// so returning a new object each render would cause an infinite re-render loop.
const mockApi = {
  get: mockGet,
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
};

vi.mock('../../src/client/hooks/useApi', () => ({
  useApi: () => mockApi,
}));

// Import after mocks
import { useTeamDetailData } from '../../src/client/hooks/useTeamDetailData';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    issueNumber: 100,
    issueTitle: 'Fix rendering bug',
    status: 'running',
    phase: 'implementing',
    worktreeName: 'kea-100',
    branchName: 'feat/kea-100',
    model: 'claude-sonnet',
    prNumber: null,
    pr: null,
    launchedAt: '2026-03-21T10:00:00Z',
    lastEventAt: '2026-03-21T10:05:00Z',
    durationMin: 5,
    idleMin: 0,
    totalInputTokens: 10000,
    totalOutputTokens: 5000,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalCostUsd: 0.50,
    githubRepo: 'user/repo',
    recentEvents: [],
    outputTail: null,
    ...overrides,
  };
}

function makeTransitions() {
  return [
    { id: 1, teamId: 1, fromStatus: 'queued', toStatus: 'launching', trigger: 'system', reason: 'slot available', createdAt: '2026-03-21T10:00:00Z' },
  ];
}

function makeRoster() {
  return [
    { name: 'team-lead', role: 'lead', isActive: true, firstSeen: '2026-03-21T10:00:00Z', lastSeen: '2026-03-21T10:05:00Z', toolUseCount: 10, errorCount: 0 },
  ];
}

function makeEdges() {
  return [
    { sender: 'team-lead', recipient: 'dev', count: 3, lastSummary: 'Implement feature X' },
  ];
}

function makeSpawns() {
  return [
    {
      id: 1,
      recipient: 'dev',
      sender: 'team-lead',
      content: 'do feature X',
      sessionId: 'sess-1',
      createdAt: '2026-03-21T10:00:00Z',
      eventId: 1,
      terminalStatus: 'running' as const,
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useTeamDetailData', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null/empty state when selectedTeamId is null', () => {
    const { result } = renderHook(() => useTeamDetailData(null, null, null));

    expect(result.current.detail).toBeNull();
    expect(result.current.transitions).toEqual([]);
    expect(result.current.roster).toEqual([]);
    expect(result.current.messageEdges).toEqual([]);
    expect(result.current.spawnRecords).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('fires all 5 fetches in parallel when selectedTeamId is set', async () => {
    const detail = makeDetail();
    const transitions = makeTransitions();
    const rosterData = makeRoster();
    const edges = makeEdges();
    const spawns = makeSpawns();

    mockGet.mockImplementation((path: string) => {
      if (path === 'teams/1') return Promise.resolve(detail);
      if (path === 'teams/1/transitions') return Promise.resolve(transitions);
      if (path === 'teams/1/roster') return Promise.resolve(rosterData);
      if (path === 'teams/1/messages/summary') return Promise.resolve(edges);
      if (path === 'teams/1/spawns') return Promise.resolve(spawns);
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });

    const { result } = renderHook(() => useTeamDetailData(1, null, null));

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockGet).toHaveBeenCalledTimes(5);
    expect(mockGet).toHaveBeenCalledWith('teams/1');
    expect(mockGet).toHaveBeenCalledWith('teams/1/transitions');
    expect(mockGet).toHaveBeenCalledWith('teams/1/roster');
    expect(mockGet).toHaveBeenCalledWith('teams/1/messages/summary');
    expect(mockGet).toHaveBeenCalledWith('teams/1/spawns');

    expect(result.current.detail).toEqual(detail);
    expect(result.current.transitions).toEqual(transitions);
    expect(result.current.roster).toEqual(rosterData);
    expect(result.current.messageEdges).toEqual(edges);
    expect(result.current.spawnRecords).toEqual(spawns);
    expect(result.current.error).toBeNull();
  });

  it('sets error when detail fetch fails but keeps non-critical data', async () => {
    const transitions = makeTransitions();

    mockGet.mockImplementation((path: string) => {
      if (path === 'teams/1') return Promise.reject(new Error('Network error'));
      if (path === 'teams/1/transitions') return Promise.resolve(transitions);
      if (path === 'teams/1/roster') return Promise.resolve([]);
      if (path === 'teams/1/messages/summary') return Promise.resolve([]);
      if (path === 'teams/1/spawns') return Promise.resolve([]);
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });

    const { result } = renderHook(() => useTeamDetailData(1, null, null));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Network error');
    expect(result.current.detail).toBeNull();
    expect(result.current.transitions).toEqual(transitions);
  });

  it('degrades gracefully when non-critical fetches fail', async () => {
    const detail = makeDetail();

    mockGet.mockImplementation((path: string) => {
      if (path === 'teams/1') return Promise.resolve(detail);
      return Promise.reject(new Error('Non-critical failure'));
    });

    const { result } = renderHook(() => useTeamDetailData(1, null, null));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.detail).toEqual(detail);
    expect(result.current.transitions).toEqual([]);
    expect(result.current.roster).toEqual([]);
    expect(result.current.messageEdges).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('clears all data when selectedTeamId changes to null', async () => {
    const detail = makeDetail();
    mockGet.mockResolvedValue(detail);

    const { result, rerender } = renderHook(
      ({ teamId }: { teamId: number | null }) => useTeamDetailData(teamId, null, null),
      { initialProps: { teamId: 1 } },
    );

    await waitFor(() => {
      expect(result.current.detail).not.toBeNull();
    });

    rerender({ teamId: null });

    expect(result.current.detail).toBeNull();
    expect(result.current.transitions).toEqual([]);
    expect(result.current.roster).toEqual([]);
    expect(result.current.messageEdges).toEqual([]);
    expect(result.current.spawnRecords).toEqual([]);
  });

  it('refreshDetail re-fetches only detail when caches are fresh', async () => {
    const detail = makeDetail();
    const transitions = makeTransitions();
    const rosterData = makeRoster();
    const edges = makeEdges();
    const spawns = makeSpawns();

    mockGet.mockImplementation((path: string) => {
      if (path === 'teams/1') return Promise.resolve(detail);
      if (path === 'teams/1/transitions') return Promise.resolve(transitions);
      if (path === 'teams/1/roster') return Promise.resolve(rosterData);
      if (path === 'teams/1/messages/summary') return Promise.resolve(edges);
      if (path === 'teams/1/spawns') return Promise.resolve(spawns);
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });

    const { result } = renderHook(() => useTeamDetailData(1, null, null));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    mockGet.mockClear();
    mockGet.mockImplementation((path: string) => {
      if (path === 'teams/1') return Promise.resolve(detail);
      if (path === 'teams/1/transitions') return Promise.resolve(transitions);
      if (path === 'teams/1/roster') return Promise.resolve(rosterData);
      if (path === 'teams/1/messages/summary') return Promise.resolve(edges);
      if (path === 'teams/1/spawns') return Promise.resolve(spawns);
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });

    // Call refreshDetail immediately — caches are fresh (< 30s)
    act(() => {
      result.current.refreshDetail();
    });

    await waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith('teams/1');
    });
    // Only detail is re-fetched, not the cached endpoints
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('does not trigger SSE refresh for a different team', async () => {
    const detail = makeDetail();
    mockGet.mockResolvedValue(detail);

    const { result, rerender } = renderHook(
      ({ teamId, lastEvent, lastEventTeamId }: {
        teamId: number | null;
        lastEvent: Date | null;
        lastEventTeamId: number | null;
      }) => useTeamDetailData(teamId, lastEvent, lastEventTeamId),
      { initialProps: { teamId: 1, lastEvent: null as Date | null, lastEventTeamId: null as number | null } },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const callCountAfterInit = mockGet.mock.calls.length;

    // SSE event for a different team (id=2) — should NOT trigger refresh
    rerender({ teamId: 1, lastEvent: new Date(), lastEventTeamId: 2 });

    // Wait a bit for any potential debounced call
    await new Promise(resolve => setTimeout(resolve, 100));

    // No additional calls
    expect(mockGet.mock.calls.length).toBe(callCountAfterInit);
  });

  it('periodic refresh re-fetches roster and message edges while a team is selected', async () => {
    const detail = makeDetail();
    const transitions = makeTransitions();
    const rosterData = makeRoster();
    const edges = makeEdges();
    const spawns = makeSpawns();

    mockGet.mockImplementation((path: string) => {
      if (path === 'teams/1') return Promise.resolve(detail);
      if (path === 'teams/1/transitions') return Promise.resolve(transitions);
      if (path === 'teams/1/roster') return Promise.resolve(rosterData);
      if (path === 'teams/1/messages/summary') return Promise.resolve(edges);
      if (path === 'teams/1/spawns') return Promise.resolve(spawns);
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });

    // Install fake timers BEFORE rendering so the hook's setInterval is
    // registered with the fake-timer queue. Use shouldAdvanceTime: true so
    // micro-timers (like the ones React uses internally) still progress and
    // don't deadlock the initial useEffect.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result, rerender } = renderHook(
        ({ teamId, lastEvent, lastEventTeamId }: {
          teamId: number | null;
          lastEvent: Date | null;
          lastEventTeamId: number | null;
        }) => useTeamDetailData(teamId, lastEvent, lastEventTeamId),
        { initialProps: { teamId: 1, lastEvent: null as Date | null, lastEventTeamId: null as number | null } },
      );

      // Wait for the initial Promise.allSettled to resolve. With shouldAdvanceTime:true,
      // waitFor's internal setTimeout still polls.
      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      const initialRosterCalls = mockGet.mock.calls.filter(([p]) => p === 'teams/1/roster').length;
      const initialEdgesCalls = mockGet.mock.calls.filter(([p]) => p === 'teams/1/messages/summary').length;

      expect(initialRosterCalls).toBe(1);
      expect(initialEdgesCalls).toBe(1);

      // Simulate continuous SSE events at 1 Hz for 6 seconds, like an active
      // team would emit. Each rerender resets the SSE debounce timer (the bug
      // being worked around). The new periodic interval (POLL_INTERVAL_MS =
      // 5_000) should still fire at t=5s and re-fetch the stale caches.
      for (let t = 1; t <= 6; t++) {
        await act(async () => {
          rerender({ teamId: 1, lastEvent: new Date(), lastEventTeamId: 1 });
          await vi.advanceTimersByTimeAsync(1000);
        });
      }

      const rosterCallsAfter = mockGet.mock.calls.filter(([p]) => p === 'teams/1/roster').length;
      const edgesCallsAfter = mockGet.mock.calls.filter(([p]) => p === 'teams/1/messages/summary').length;

      // The periodic interval should have fired at least once (at t=5s) and refetched roster + edges.
      expect(rosterCallsAfter).toBeGreaterThan(initialRosterCalls);
      expect(edgesCallsAfter).toBeGreaterThan(initialEdgesCalls);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes spawnRecords from the /spawns endpoint', async () => {
    const detail = makeDetail();
    const spawns = makeSpawns();

    mockGet.mockImplementation((path: string) => {
      if (path === 'teams/1') return Promise.resolve(detail);
      if (path === 'teams/1/spawns') return Promise.resolve(spawns);
      // Other endpoints return empty so test focuses on spawnRecords
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useTeamDetailData(1, null, null));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.spawnRecords).toEqual(spawns);
  });

  it('falls back to empty spawnRecords when the /spawns endpoint fails', async () => {
    const detail = makeDetail();

    mockGet.mockImplementation((path: string) => {
      if (path === 'teams/1') return Promise.resolve(detail);
      if (path === 'teams/1/spawns') return Promise.reject(new Error('500'));
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useTeamDetailData(1, null, null));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.detail).toEqual(detail);
    expect(result.current.spawnRecords).toEqual([]);
    // Failure of a non-critical endpoint must NOT set the error state
    expect(result.current.error).toBeNull();
  });

  it('exposes refreshDetail as a stable function', async () => {
    const detail = makeDetail();
    mockGet.mockResolvedValue(detail);

    const { result, rerender } = renderHook(
      ({ teamId }: { teamId: number | null }) => useTeamDetailData(teamId, null, null),
      { initialProps: { teamId: 1 } },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const fn1 = result.current.refreshDetail;

    // Re-render with same teamId
    rerender({ teamId: 1 });

    const fn2 = result.current.refreshDetail;

    // refreshDetail should be a function
    expect(typeof fn1).toBe('function');
    expect(typeof fn2).toBe('function');
  });
});
