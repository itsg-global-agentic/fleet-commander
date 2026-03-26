// =============================================================================
// Fleet Commander — Event Collector Tests
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  processEvent,
  resetThrottleState,
  resetSubagentTrackers,
  getSubagentTrackerSize,
  cleanSubagentTrackersForTeam,
  normalizeAgentName,
  classifyAgentRole,
  shouldAdvancePhase,
  PHASE_ORDER,
  EventCollectorError,
  type EventPayload,
  type EventCollectorDb,
  type SseBroker,
  type TeamMessageSender,
} from '../../src/server/services/event-collector.js';
import {
  buildPayloadFromCcStdin,
  buildPayloadFromLegacy,
} from '../../src/server/routes/events.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockDb(overrides?: Partial<EventCollectorDb>): EventCollectorDb {
  let nextEventId = 1;
  let nextMsgId = 1;

  const insertEvent = vi.fn().mockImplementation(() => ({ id: nextEventId++ }));
  const updateTeam = vi.fn();
  const insertTransition = vi.fn();
  const insertAgentMessage = vi.fn().mockImplementation(() => ({ id: nextMsgId++ }));

  // processEventTransaction delegates to individual mocks so existing
  // assertions on insertEvent, updateTeam, etc. continue to pass.
  const processEventTransaction = vi.fn().mockImplementation(
    (ops: {
      transition?: { teamId: number; fromStatus: string; toStatus: string; trigger: string; reason: string };
      statusUpdate?: { teamId: number; fields: Record<string, unknown> };
      heartbeatUpdate: { teamId: number; lastEventAt: string };
      eventInsert: { teamId: number; sessionId: string | null; agentName: string | null; eventType: string; toolName?: string | null; payload: string };
      agentMessages?: Array<{ teamId: number; sender: string; recipient: string; summary?: string | null; content?: string | null; sessionId?: string | null }>;
    }) => {
      if (ops.transition) {
        insertTransition(ops.transition);
      }
      if (ops.statusUpdate) {
        updateTeam(ops.statusUpdate.teamId, ops.statusUpdate.fields);
      }
      updateTeam(ops.heartbeatUpdate.teamId, { lastEventAt: ops.heartbeatUpdate.lastEventAt });
      const result = insertEvent(ops.eventInsert);
      const eventId = result.id;
      if (ops.agentMessages) {
        for (const msg of ops.agentMessages) {
          insertAgentMessage({ ...msg, eventId });
        }
      }
      return { eventId };
    },
  );

  // processThrottledUpdate delegates to individual mocks so existing
  // assertions on insertTransition, updateTeam, etc. continue to pass.
  const processThrottledUpdate = vi.fn().mockImplementation(
    (ops: {
      transition?: { teamId: number; fromStatus: string; toStatus: string; trigger: string; reason: string };
      statusUpdate?: { teamId: number; fields: Record<string, unknown> };
      heartbeatUpdate: { teamId: number; lastEventAt: string };
    }) => {
      if (ops.transition) {
        insertTransition(ops.transition);
      }
      if (ops.statusUpdate) {
        updateTeam(ops.statusUpdate.teamId, ops.statusUpdate.fields);
      }
      updateTeam(ops.heartbeatUpdate.teamId, { lastEventAt: ops.heartbeatUpdate.lastEventAt });
    },
  );

  return {
    getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'running', phase: 'implementing' }),
    insertEvent,
    updateTeam,
    updateTeamSilent: updateTeam,
    insertTransition,
    insertAgentMessage,
    processEventTransaction,
    processThrottledUpdate,
    ...overrides,
  };
}

function createMockSse(): SseBroker {
  return {
    broadcast: vi.fn(),
  };
}

function makePayload(overrides?: Partial<EventPayload>): EventPayload {
  return {
    event: 'tool_use',
    team: 'kea-100',
    timestamp: new Date().toISOString(),
    session_id: 'sess-abc',
    tool_name: 'Bash',
    agent_type: 'coordinator',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function createMockMessageSender(): TeamMessageSender & { sendMessage: ReturnType<typeof vi.fn> } {
  return {
    sendMessage: vi.fn().mockReturnValue(true),
  };
}

beforeEach(() => {
  resetThrottleState();
  resetSubagentTrackers();
});

// =============================================================================
// Valid payload processing — all 9 event types
// =============================================================================

describe('Valid payload processing', () => {
  const eventTypes = [
    'tool_use',
    'session_start',
    'session_end',
    'stop',
    'stop_failure',
    'subagent_start',
    'subagent_stop',
    'notification',
    'teammate_idle',
    'tool_error',
    'pre_compact',
    'worktree_create',
    'worktree_remove',
  ];

  const normalizedTypes: Record<string, string> = {
    tool_use: 'ToolUse',
    session_start: 'SessionStart',
    session_end: 'SessionEnd',
    stop: 'Stop',
    stop_failure: 'StopFailure',
    subagent_start: 'SubagentStart',
    subagent_stop: 'SubagentStop',
    notification: 'Notification',
    teammate_idle: 'TeammateIdle',
    tool_error: 'ToolError',
    pre_compact: 'PreCompact',
    worktree_create: 'WorktreeCreate',
    worktree_remove: 'WorktreeRemove',
  };

  for (const eventType of eventTypes) {
    it(`processes ${eventType} event`, () => {
      const db = createMockDb();
      const sse = createMockSse();
      const payload = makePayload({ event: eventType });

      const result = processEvent(payload, db, sse);

      expect(result.processed).toBe(true);
      expect(result.team_id).toBe(1);
      expect(result.event_id).toBe(1);

      // Verify event was inserted with normalized type
      expect(db.insertEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: normalizedTypes[eventType],
        }),
      );

      // Verify SSE was broadcast
      expect(sse.broadcast).toHaveBeenCalledWith(
        'team_event',
        expect.objectContaining({
          event_type: normalizedTypes[eventType],
          team_id: 1,
        }),
      );
    });
  }
});

// =============================================================================
// Invalid payload rejection
// =============================================================================

describe('Invalid payload rejection', () => {
  it('rejects payload with missing event field', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makePayload({ event: '' });

    expect(() => processEvent(payload, db, sse)).toThrow(EventCollectorError);
    expect(() => processEvent(payload, db, sse)).toThrow('Missing required fields');
  });

  it('rejects payload with missing team field', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makePayload({ team: '' });

    expect(() => processEvent(payload, db, sse)).toThrow(EventCollectorError);
  });

  it('sets VALIDATION_ERROR code for invalid payloads', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makePayload({ event: '', team: '' });

    try {
      processEvent(payload, db, sse);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EventCollectorError);
      expect((err as EventCollectorError).code).toBe('VALIDATION_ERROR');
    }
  });

  it('throws TEAM_NOT_FOUND when team does not exist', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue(undefined),
    });
    const sse = createMockSse();
    const payload = makePayload();

    try {
      processEvent(payload, db, sse);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EventCollectorError);
      expect((err as EventCollectorError).code).toBe('TEAM_NOT_FOUND');
    }
  });
});

// =============================================================================
// State transitions
// =============================================================================

describe('State transitions', () => {
  it('transitions idle -> running on non-dormancy event', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'idle', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'session_start' });

    processEvent(payload, db, sse);

    // Should have called updateTeam with status: 'running'
    expect(db.updateTeam).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'running' }),
    );
  });

  it('transitions stuck -> running on non-dormancy event', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'stuck', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'notification' });

    processEvent(payload, db, sse);

    expect(db.updateTeam).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'running' }),
    );
  });

  // --- Dormancy event filtering (Issue #193) ---

  it('does NOT transition idle -> running on stop event', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'idle', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'stop' });

    processEvent(payload, db, sse);

    // Should NOT have called updateTeam with status: 'running'
    const statusCalls = (db.updateTeam as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).status !== undefined,
    );
    expect(statusCalls).toHaveLength(0);
    expect(db.insertTransition).not.toHaveBeenCalled();
  });

  it('does NOT transition idle -> running on session_end event', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'idle', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'session_end' });

    processEvent(payload, db, sse);

    const statusCalls = (db.updateTeam as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).status !== undefined,
    );
    expect(statusCalls).toHaveLength(0);
    expect(db.insertTransition).not.toHaveBeenCalled();
  });

  it('does NOT transition stuck -> running on stop event', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'stuck', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'stop' });

    processEvent(payload, db, sse);

    const statusCalls = (db.updateTeam as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).status !== undefined,
    );
    expect(statusCalls).toHaveLength(0);
    expect(db.insertTransition).not.toHaveBeenCalled();
  });

  it('does NOT transition stuck -> running on session_end event', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'stuck', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'session_end' });

    processEvent(payload, db, sse);

    const statusCalls = (db.updateTeam as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).status !== undefined,
    );
    expect(statusCalls).toHaveLength(0);
    expect(db.insertTransition).not.toHaveBeenCalled();
  });

  it('still updates lastEventAt for dormancy events on idle teams', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'idle', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'stop' });

    processEvent(payload, db, sse);

    // lastEventAt should still be updated even though status did not change
    expect(db.updateTeam).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ lastEventAt: expect.any(String) }),
    );
  });

  it('still updates lastEventAt for dormancy events on stuck teams', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'stuck', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'session_end' });

    processEvent(payload, db, sse);

    expect(db.updateTeam).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ lastEventAt: expect.any(String) }),
    );
  });

  it('still inserts DB event and broadcasts SSE for dormancy events on idle teams', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'idle', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'stop' });

    const result = processEvent(payload, db, sse);

    expect(result.processed).toBe(true);
    expect(db.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'Stop' }),
    );
    expect(sse.broadcast).toHaveBeenCalledWith(
      'team_event',
      expect.objectContaining({ event_type: 'Stop' }),
    );
  });

  // --- Non-dormancy events that DO trigger recovery ---

  const nonDormancyRecoveryEvents = [
    'tool_use',
    'session_start',
    'subagent_start',
    'subagent_stop',
    'notification',
  ];

  for (const eventType of nonDormancyRecoveryEvents) {
    it(`transitions idle -> running on ${eventType} event`, () => {
      const db = createMockDb({
        getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'idle', phase: 'implementing' }),
      });
      const sse = createMockSse();
      const payload = makePayload({ event: eventType });

      processEvent(payload, db, sse);

      expect(db.insertTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: 1,
          fromStatus: 'idle',
          toStatus: 'running',
          trigger: 'hook',
        }),
      );
      expect(db.updateTeam).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ status: 'running' }),
      );
    });
  }

  // --- Existing non-dormancy tests ---

  it('does NOT transition running -> running (no redundant update)', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'running', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'session_start' });

    processEvent(payload, db, sse);

    // updateTeam should be called for lastEventAt, but NOT for status: 'running'
    const statusCalls = (db.updateTeam as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).status !== undefined,
    );
    expect(statusCalls).toHaveLength(0);
  });

  it('always updates lastEventAt regardless of status', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makePayload();

    processEvent(payload, db, sse);

    expect(db.updateTeam).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ lastEventAt: expect.any(String) }),
    );
  });

  it('updates lastEventAt even for throttled tool_use events', () => {
    const db = createMockDb();
    const sse = createMockSse();

    // First tool_use (goes through)
    processEvent(makePayload({ event: 'tool_use' }), db, sse);

    // Second tool_use within throttle window (deduplicated but lastEventAt still updated)
    const result = processEvent(makePayload({ event: 'tool_use' }), db, sse);
    expect(result.processed).toBe(false);

    // updateTeam should have been called with lastEventAt for both events
    const lastEventCalls = (db.updateTeam as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).lastEventAt !== undefined,
    );
    expect(lastEventCalls.length).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// Terminal state guards (Issue #388)
// =============================================================================

describe('Terminal state guards', () => {
  it('should NOT transition done team to running on activity event', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'done', phase: 'done' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'tool_use' });

    processEvent(payload, db, sse);

    // Should NOT have inserted a transition or changed status
    expect(db.insertTransition).not.toHaveBeenCalled();
    const statusCalls = (db.updateTeam as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).status !== undefined,
    );
    expect(statusCalls).toHaveLength(0);
  });

  it('should NOT transition failed team to running on session_start', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'failed', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'session_start' });

    processEvent(payload, db, sse);

    // Should NOT have inserted a transition or changed status
    expect(db.insertTransition).not.toHaveBeenCalled();
    const statusCalls = (db.updateTeam as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).status !== undefined,
    );
    expect(statusCalls).toHaveLength(0);
  });

  it('should NOT transition failed team to running on subagent_start', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'failed', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'subagent_start', teammate_name: 'fleet-dev' });

    processEvent(payload, db, sse);

    // Should NOT have inserted a transition or changed status
    expect(db.insertTransition).not.toHaveBeenCalled();
    const statusCalls = (db.updateTeam as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).status !== undefined,
    );
    expect(statusCalls).toHaveLength(0);
  });

  it('should still record events for terminal teams', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'done', phase: 'done' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'notification' });

    const result = processEvent(payload, db, sse);

    // Event should still be inserted and broadcast
    expect(result.processed).toBe(true);
    expect(db.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'Notification' }),
    );
    expect(sse.broadcast).toHaveBeenCalledWith(
      'team_event',
      expect.objectContaining({ event_type: 'Notification' }),
    );
    // No status transition should have occurred
    expect(db.insertTransition).not.toHaveBeenCalled();
  });

  it('should still update lastEventAt for terminal teams', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'failed', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'tool_use' });

    processEvent(payload, db, sse);

    expect(db.updateTeam).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ lastEventAt: expect.any(String) }),
    );
  });

  it('should handle stale launching->failed race (fresh re-read prevents transition)', () => {
    let callCount = 0;
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call: team appears to be launching
          return { id: 1, status: 'launching', phase: 'init' };
        }
        // Second call (fresh re-read): launch timeout already fired, team is now failed
        return { id: 1, status: 'failed', phase: 'init' };
      }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'session_start' });

    processEvent(payload, db, sse);

    // The fresh re-read should prevent the transition
    expect(db.insertTransition).not.toHaveBeenCalled();
    const statusCalls = (db.updateTeam as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).status !== undefined,
    );
    expect(statusCalls).toHaveLength(0);
  });

  it('should still allow legitimate launching->running transition', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'launching', phase: 'init' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'session_start' });

    processEvent(payload, db, sse);

    // The transition should proceed normally
    expect(db.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        fromStatus: 'launching',
        toStatus: 'running',
        trigger: 'hook',
      }),
    );
    expect(db.updateTeam).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'running' }),
    );
  });

  it('should handle stale idle->done race (fresh re-read prevents transition)', () => {
    let callCount = 0;
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return { id: 1, status: 'idle', phase: 'implementing' };
        }
        // Fresh re-read: poller already transitioned team to done
        return { id: 1, status: 'done', phase: 'done' };
      }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'tool_use' });

    processEvent(payload, db, sse);

    // The fresh re-read should prevent the transition
    expect(db.insertTransition).not.toHaveBeenCalled();
    const statusCalls = (db.updateTeam as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).status !== undefined,
    );
    expect(statusCalls).toHaveLength(0);
  });
});

// =============================================================================
// tool_use throttling
// =============================================================================

describe('tool_use throttling', () => {
  it('processes first tool_use event', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makePayload({ event: 'tool_use' });

    const result = processEvent(payload, db, sse);

    expect(result.processed).toBe(true);
    expect(result.event_id).toBe(1);
  });

  it('deduplicates tool_use within 5s window (processed: false)', () => {
    const db = createMockDb();
    const sse = createMockSse();

    // First call succeeds
    const r1 = processEvent(makePayload({ event: 'tool_use' }), db, sse);
    expect(r1.processed).toBe(true);

    // Second call within throttle window
    const r2 = processEvent(makePayload({ event: 'tool_use' }), db, sse);
    expect(r2.processed).toBe(false);
    expect(r2.event_id).toBeNull();
    expect(r2.team_id).toBe(1);
  });

  it('does not insert event to DB for deduplicated tool_use', () => {
    const db = createMockDb();
    const sse = createMockSse();

    processEvent(makePayload({ event: 'tool_use' }), db, sse);
    processEvent(makePayload({ event: 'tool_use' }), db, sse);

    // insertEvent should be called only once
    expect(db.insertEvent).toHaveBeenCalledTimes(1);
  });

  it('does not broadcast SSE for deduplicated tool_use', () => {
    const db = createMockDb();
    const sse = createMockSse();

    processEvent(makePayload({ event: 'tool_use' }), db, sse);
    processEvent(makePayload({ event: 'tool_use' }), db, sse);

    // broadcast should be called only once
    expect(sse.broadcast).toHaveBeenCalledTimes(1);
  });

  it('throttles per-team (different teams are independent)', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockImplementation((name: string) => {
        if (name === 'kea-100') return { id: 1, status: 'running', phase: 'implementing' };
        if (name === 'kea-200') return { id: 2, status: 'running', phase: 'implementing' };
        return undefined;
      }),
    });
    const sse = createMockSse();

    // Team 1 - first event
    const r1 = processEvent(makePayload({ event: 'tool_use', team: 'kea-100' }), db, sse);
    expect(r1.processed).toBe(true);

    // Team 2 - first event (different team, should go through)
    const r2 = processEvent(makePayload({ event: 'tool_use', team: 'kea-200' }), db, sse);
    expect(r2.processed).toBe(true);
    expect(r2.team_id).toBe(2);

    // Team 1 - second event (throttled)
    const r3 = processEvent(makePayload({ event: 'tool_use', team: 'kea-100' }), db, sse);
    expect(r3.processed).toBe(false);
  });
});

// =============================================================================
// Non-tool_use events are never throttled
// =============================================================================

describe('Non-tool_use events never throttled', () => {
  const nonToolUseEvents = [
    'session_start',
    'session_end',
    'stop',
    'stop_failure',
    'subagent_start',
    'subagent_stop',
    'notification',
    'teammate_idle',
    'tool_error',
    'worktree_create',
    'worktree_remove',
  ];

  for (const eventType of nonToolUseEvents) {
    it(`${eventType} is never throttled even when sent rapidly`, () => {
      const db = createMockDb();
      const sse = createMockSse();

      const r1 = processEvent(makePayload({ event: eventType }), db, sse);
      const r2 = processEvent(makePayload({ event: eventType }), db, sse);
      const r3 = processEvent(makePayload({ event: eventType }), db, sse);

      expect(r1.processed).toBe(true);
      expect(r2.processed).toBe(true);
      expect(r3.processed).toBe(true);
    });
  }
});

// =============================================================================
// SSE broadcast data shape
// =============================================================================

describe('SSE broadcast', () => {
  it('broadcasts with correct data shape', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makePayload({
      event: 'session_start',
      session_id: 'sess-xyz',
      agent_type: 'kea-coordinator',
      tool_name: undefined,
    });

    processEvent(payload, db, sse);

    expect(sse.broadcast).toHaveBeenCalledWith(
      'team_event',
      expect.objectContaining({
        event_id: 1,
        team_id: 1,
        event_type: 'SessionStart',
        session_id: 'sess-xyz',
        agent_name: 'kea-coordinator', // No fleet- prefix to strip here
        tool_name: null,
      }),
    );
  });

  it('includes tool_name in broadcast when present', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makePayload({
      event: 'tool_use',
      tool_name: 'Edit',
    });

    processEvent(payload, db, sse);

    expect(sse.broadcast).toHaveBeenCalledWith(
      'team_event',
      expect.objectContaining({
        tool_name: 'Edit',
      }),
    );
  });
});

// =============================================================================
// Edge cases
// =============================================================================

describe('tool_error event with error field', () => {
  it('stores error and tool_use_id fields in payload JSON', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makePayload({
      event: 'tool_error',
      tool_name: 'Bash',
      error: 'exit code 1',
      tool_use_id: 'toolu_abc123',
    });

    const result = processEvent(payload, db, sse);

    expect(result.processed).toBe(true);
    expect(db.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ToolError',
        toolName: 'Bash',
      }),
    );

    // Verify the full payload JSON contains the error fields
    const insertCall = (db.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const storedPayload = JSON.parse(insertCall.payload);
    expect(storedPayload.error).toBe('exit code 1');
    expect(storedPayload.tool_use_id).toBe('toolu_abc123');
  });

  it('stores tool_input when provided via route', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makePayload({
      event: 'tool_error',
      tool_name: 'Bash',
      error: 'permission denied',
      tool_use_id: 'toolu_xyz',
      tool_input: '{"command":"rm -rf /"}',
    });

    processEvent(payload, db, sse);

    const insertCall = (db.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const storedPayload = JSON.parse(insertCall.payload);
    expect(storedPayload.tool_input).toBe('{"command":"rm -rf /"}');
  });

  it('handles tool_error with only error field (no message)', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload: EventPayload = {
      event: 'tool_error',
      team: 'kea-100',
      session_id: 'sess-abc',
      tool_name: 'Edit',
      error: 'file not found',
    };

    const result = processEvent(payload, db, sse);

    expect(result.processed).toBe(true);
    const insertCall = (db.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const storedPayload = JSON.parse(insertCall.payload);
    expect(storedPayload.error).toBe('file not found');
    expect(storedPayload.message).toBeUndefined();
  });
});

// =============================================================================
// StopFailure event with error_details and last_assistant_message
// =============================================================================

describe('StopFailure event', () => {
  it('stores error_details and last_assistant_message in payload JSON', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makePayload({
      event: 'stop_failure',
      error_details: 'rate_limit',
      last_assistant_message: 'I was about to run the tests when...',
    });

    const result = processEvent(payload, db, sse);

    expect(result.processed).toBe(true);
    expect(db.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'StopFailure',
      }),
    );

    // Verify the full payload JSON contains the StopFailure-specific fields
    const insertCall = (db.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const storedPayload = JSON.parse(insertCall.payload);
    expect(storedPayload.error_details).toBe('rate_limit');
    expect(storedPayload.last_assistant_message).toBe('I was about to run the tests when...');
  });

  it('is treated as a dormancy event (does not transition idle -> running)', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'idle', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'stop_failure', error_details: 'api_error' });

    processEvent(payload, db, sse);

    // Should NOT have called updateTeam with status: 'running'
    const statusCalls = (db.updateTeam as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).status !== undefined,
    );
    expect(statusCalls).toHaveLength(0);
    expect(db.insertTransition).not.toHaveBeenCalled();
  });

  it('is treated as a dormancy event (does not transition stuck -> running)', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'stuck', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'stop_failure', error_details: 'rate_limit' });

    processEvent(payload, db, sse);

    const statusCalls = (db.updateTeam as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).status !== undefined,
    );
    expect(statusCalls).toHaveLength(0);
    expect(db.insertTransition).not.toHaveBeenCalled();
  });

  it('still updates lastEventAt for stop_failure events', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'idle', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'stop_failure', error_details: 'rate_limit' });

    processEvent(payload, db, sse);

    expect(db.updateTeam).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ lastEventAt: expect.any(String) }),
    );
  });

  it('handles stop_failure with only error field (no error_details)', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload: EventPayload = {
      event: 'stop_failure',
      team: 'kea-100',
      session_id: 'sess-abc',
      error: 'API rate limit exceeded',
    };

    const result = processEvent(payload, db, sse);

    expect(result.processed).toBe(true);
    const insertCall = (db.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const storedPayload = JSON.parse(insertCall.payload);
    expect(storedPayload.error).toBe('API rate limit exceeded');
  });
});

// =============================================================================
// Edge cases
// =============================================================================

describe('Edge cases', () => {
  it('handles unknown event types (passes through unchanged)', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makePayload({ event: 'some_custom_event' });

    const result = processEvent(payload, db, sse);

    expect(result.processed).toBe(true);
    expect(db.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'some_custom_event' }),
    );
  });

  it('uses current time when no timestamp in payload', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makePayload({ event: 'session_start', timestamp: undefined });

    processEvent(payload, db, sse);

    // Verify insertEvent was called (the timestamp is handled by the DB's default)
    expect(db.insertEvent).toHaveBeenCalled();
  });

  it('handles null session_id and agent_type', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makePayload({
      event: 'session_start',
      session_id: undefined,
      agent_type: undefined,
    });

    processEvent(payload, db, sse);

    expect(db.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: null,
        agentName: 'team-lead', // Empty agent_type maps to "team-lead"
      }),
    );
  });
});

// =============================================================================
// Agent message routing (SendMessage capture)
// =============================================================================

describe('Agent message routing', () => {
  it('creates agent_message record for SendMessage events with msg_to', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makePayload({
      event: 'tool_use',
      tool_name: 'SendMessage',
      agent_type: 'coordinator',
      session_id: 'sess-abc',
      msg_to: 'dev-typescript',
      msg_summary: 'Implement the feature',
      message: 'Full message content here',
    });

    processEvent(payload, db, sse);

    expect(db.insertAgentMessage).toHaveBeenCalledWith({
      teamId: 1,
      eventId: 1,
      sender: 'coordinator', // already normalized (no fleet- prefix)
      recipient: 'dev-typescript', // already normalized (no fleet- prefix)
      summary: 'Implement the feature',
      content: 'Full message content here',
      sessionId: 'sess-abc',
    });
  });

  it('does not create agent_message for non-SendMessage events', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makePayload({
      event: 'tool_use',
      tool_name: 'Bash',
      agent_type: 'coordinator',
    });

    processEvent(payload, db, sse);

    expect(db.insertAgentMessage).not.toHaveBeenCalled();
  });

  it('does not create agent_message when msg_to is missing', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makePayload({
      event: 'tool_use',
      tool_name: 'SendMessage',
      agent_type: 'coordinator',
    });

    processEvent(payload, db, sse);

    expect(db.insertAgentMessage).not.toHaveBeenCalled();
  });

  it('handles broadcast messages (msg_to = "*")', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makePayload({
      event: 'tool_use',
      tool_name: 'SendMessage',
      agent_type: 'coordinator',
      msg_to: '*',
      message: 'Team-wide broadcast',
    });

    processEvent(payload, db, sse);

    expect(db.insertAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: 'coordinator',
        recipient: '*', // "*" passes through normalization unchanged
        content: 'Team-wide broadcast',
      }),
    );
  });

  it('uses "team-lead" as sender when agent_type is missing', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makePayload({
      event: 'tool_use',
      tool_name: 'SendMessage',
      agent_type: undefined,
      msg_to: 'dev-typescript',
    });

    processEvent(payload, db, sse);

    expect(db.insertAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: 'team-lead', // Empty agent_type normalizes to "team-lead"
        recipient: 'dev-typescript',
      }),
    );
  });

  it('silently handles insertAgentMessage failures', () => {
    const db = createMockDb({
      insertAgentMessage: vi.fn().mockImplementation(() => {
        throw new Error('DB constraint violation');
      }),
    });
    const sse = createMockSse();
    const payload = makePayload({
      event: 'tool_use',
      tool_name: 'SendMessage',
      agent_type: 'coordinator',
      msg_to: 'dev-typescript',
    });

    // Should not throw — failure is silently caught
    const result = processEvent(payload, db, sse);
    expect(result.processed).toBe(true);
  });
});

// =============================================================================
// Subagent crash detection
// =============================================================================

// =============================================================================
// Subagent spawn message recording (Issue #288)
// =============================================================================

describe('Subagent spawn message recording', () => {
  it('records a TL->subagent agent message on subagent_start', () => {
    const db = createMockDb();
    const sse = createMockSse();

    processEvent(
      makePayload({ event: 'subagent_start', teammate_name: 'fleet-dev', agent_type: 'coordinator' }),
      db,
      sse,
    );

    expect(db.insertAgentMessage).toHaveBeenCalledWith({
      teamId: 1,
      eventId: 1,
      sender: 'team-lead',     // TL spawns subagents (normalizeAgentName(null))
      recipient: 'dev',        // fleet- prefix stripped from teammate_name
      summary: 'spawned agent',
      content: null,
      sessionId: 'sess-abc',
    });
  });

  it('records spawn message with agent_type fallback when teammate_name is missing', () => {
    const db = createMockDb();
    const sse = createMockSse();

    processEvent(
      makePayload({ event: 'subagent_start', teammate_name: undefined, agent_type: 'fleet-reviewer' }),
      db,
      sse,
    );

    expect(db.insertAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: 'team-lead',
        recipient: 'reviewer', // fleet- prefix stripped from agent_type fallback
        summary: 'spawned agent',
      }),
    );
  });

  it('silently handles insertAgentMessage failure during subagent_start', () => {
    const db = createMockDb({
      insertAgentMessage: vi.fn().mockImplementation(() => {
        throw new Error('DB constraint violation');
      }),
    });
    const sse = createMockSse();

    // Should not throw
    const result = processEvent(
      makePayload({ event: 'subagent_start', teammate_name: 'fleet-dev' }),
      db,
      sse,
    );
    expect(result.processed).toBe(true);
  });

  it('does not record spawn message for non-subagent_start events', () => {
    const db = createMockDb();
    const sse = createMockSse();

    processEvent(
      makePayload({ event: 'subagent_stop', teammate_name: 'fleet-dev' }),
      db,
      sse,
    );

    // insertAgentMessage should NOT have been called (no SendMessage tool_name either)
    expect(db.insertAgentMessage).not.toHaveBeenCalled();
  });
});

describe('Subagent crash detection', () => {
  it('sends advisory message when subagent stops quickly with few events', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const sender = createMockMessageSender();

    // SubagentStart
    processEvent(
      makePayload({ event: 'subagent_start', teammate_name: 'fleet-dev', agent_type: 'coordinator' }),
      db,
      sse,
      sender,
    );

    // SubagentStop immediately (within 2 min, < 5 events)
    processEvent(
      makePayload({ event: 'subagent_stop', teammate_name: 'fleet-dev', agent_type: 'coordinator' }),
      db,
      sse,
      sender,
    );

    expect(sender.sendMessage).toHaveBeenCalledWith(
      1,
      expect.stringContaining("Subagent 'fleet-dev' appears to have crashed"),
      'fc',
      'subagent_crash',
    );
  });

  it('does NOT send advisory when subagent runs long enough', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const sender = createMockMessageSender();

    // SubagentStart — we need to simulate passage of time
    // Since we can't easily mock Date.now() without affecting all code,
    // we verify the logic by checking that a subagent with many events does not trigger
    processEvent(
      makePayload({ event: 'subagent_start', teammate_name: 'fleet-dev', agent_type: 'coordinator' }),
      db,
      sse,
      sender,
    );

    // Generate enough events to exceed the minimum (5)
    for (let i = 0; i < 6; i++) {
      processEvent(
        makePayload({ event: 'tool_use', teammate_name: 'fleet-dev', agent_type: 'fleet-dev' }),
        db,
        sse,
        sender,
      );
      resetThrottleState(); // Reset throttle to allow each event through
    }

    // SubagentStop — should NOT trigger crash advisory because event count >= 5
    processEvent(
      makePayload({ event: 'subagent_stop', teammate_name: 'fleet-dev', agent_type: 'coordinator' }),
      db,
      sse,
      sender,
    );

    expect(sender.sendMessage).not.toHaveBeenCalled();
  });

  it('does NOT send advisory when no messageSender is provided', () => {
    const db = createMockDb();
    const sse = createMockSse();

    // SubagentStart without message sender
    processEvent(
      makePayload({ event: 'subagent_start', teammate_name: 'fleet-dev' }),
      db,
      sse,
    );

    // SubagentStop — should not crash even without messageSender
    expect(() => {
      processEvent(
        makePayload({ event: 'subagent_stop', teammate_name: 'fleet-dev' }),
        db,
        sse,
      );
    }).not.toThrow();
  });

  it('tracks multiple subagents independently', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const sender = createMockMessageSender();

    // Start two subagents
    processEvent(
      makePayload({ event: 'subagent_start', teammate_name: 'fleet-dev' }),
      db,
      sse,
      sender,
    );
    processEvent(
      makePayload({ event: 'subagent_start', teammate_name: 'fleet-reviewer' }),
      db,
      sse,
      sender,
    );

    // Generate events for fleet-reviewer (enough to be healthy)
    for (let i = 0; i < 6; i++) {
      processEvent(
        makePayload({ event: 'tool_use', teammate_name: 'fleet-reviewer', agent_type: 'fleet-reviewer' }),
        db,
        sse,
        sender,
      );
      resetThrottleState();
    }

    // Stop fleet-dev (crashed — few events)
    processEvent(
      makePayload({ event: 'subagent_stop', teammate_name: 'fleet-dev' }),
      db,
      sse,
      sender,
    );

    // Should have sent crash advisory for fleet-dev
    expect(sender.sendMessage).toHaveBeenCalledWith(
      1,
      expect.stringContaining("'fleet-dev'"),
      'fc',
      'subagent_crash',
    );

    sender.sendMessage.mockClear();

    // Stop fleet-reviewer (healthy — many events)
    processEvent(
      makePayload({ event: 'subagent_stop', teammate_name: 'fleet-reviewer' }),
      db,
      sse,
      sender,
    );

    // Should NOT send crash advisory for fleet-reviewer
    expect(sender.sendMessage).not.toHaveBeenCalled();
  });

  it('cleans up tracker after subagent stop', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const sender = createMockMessageSender();

    // Start and immediately stop
    processEvent(
      makePayload({ event: 'subagent_start', teammate_name: 'fleet-dev' }),
      db,
      sse,
      sender,
    );
    processEvent(
      makePayload({ event: 'subagent_stop', teammate_name: 'fleet-dev' }),
      db,
      sse,
      sender,
    );

    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
    sender.sendMessage.mockClear();

    // Second stop without a start — should not trigger (tracker cleaned up)
    processEvent(
      makePayload({ event: 'subagent_stop', teammate_name: 'fleet-dev' }),
      db,
      sse,
      sender,
    );

    expect(sender.sendMessage).not.toHaveBeenCalled();
  });

  it('includes duration and event count in advisory message', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const sender = createMockMessageSender();

    processEvent(
      makePayload({ event: 'subagent_start', teammate_name: 'fleet-planner' }),
      db,
      sse,
      sender,
    );
    processEvent(
      makePayload({ event: 'subagent_stop', teammate_name: 'fleet-planner' }),
      db,
      sse,
      sender,
    );

    const msg = sender.sendMessage.mock.calls[0][1] as string;
    expect(msg).toContain("Subagent 'fleet-planner' appears to have crashed");
    expect(msg).toContain('s after start');
    expect(msg).toContain('events');
    expect(msg).toContain('Consider respawning');
  });
});

// =============================================================================
// Subagent tracker TTL sweep (Issue #520)
// =============================================================================

describe('Subagent tracker TTL sweep', () => {
  it('should prune subagent trackers older than 30 minutes on subagent_start', () => {
    vi.useFakeTimers();
    try {
      const baseTime = new Date('2026-03-20T12:00:00Z').getTime();
      vi.setSystemTime(baseTime);

      const db = createMockDb();
      const sse = createMockSse();

      // Start a subagent at time T
      processEvent(
        makePayload({ event: 'subagent_start', teammate_name: 'fleet-dev' }),
        db,
        sse,
      );
      expect(getSubagentTrackerSize()).toBe(1);

      // Advance time by 31 minutes
      vi.setSystemTime(baseTime + 31 * 60 * 1000);

      // Start another subagent — should trigger TTL sweep and prune the old one
      processEvent(
        makePayload({ event: 'subagent_start', teammate_name: 'fleet-planner' }),
        db,
        sse,
      );

      // Only the new tracker should remain
      expect(getSubagentTrackerSize()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should NOT prune recent subagent trackers', () => {
    vi.useFakeTimers();
    try {
      const baseTime = new Date('2026-03-20T12:00:00Z').getTime();
      vi.setSystemTime(baseTime);

      const db = createMockDb();
      const sse = createMockSse();

      // Start two subagents at time T (different names)
      processEvent(
        makePayload({ event: 'subagent_start', teammate_name: 'fleet-dev' }),
        db,
        sse,
      );
      processEvent(
        makePayload({ event: 'subagent_start', teammate_name: 'fleet-reviewer' }),
        db,
        sse,
      );
      expect(getSubagentTrackerSize()).toBe(2);

      // Advance time by only 5 minutes
      vi.setSystemTime(baseTime + 5 * 60 * 1000);

      // Start a third subagent
      processEvent(
        makePayload({ event: 'subagent_start', teammate_name: 'fleet-planner' }),
        db,
        sse,
      );

      // All three trackers should still be present
      expect(getSubagentTrackerSize()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

// =============================================================================
// Subagent tracker terminal-state cleanup (Issue #520)
// =============================================================================

describe('Subagent tracker terminal-state cleanup', () => {
  it('should clean subagent trackers when team is in terminal state (done)', () => {
    const db = createMockDb();
    const sse = createMockSse();

    // Start a subagent for the team
    processEvent(
      makePayload({ event: 'subagent_start', teammate_name: 'fleet-dev', team: 'kea-100' }),
      db,
      sse,
    );
    expect(getSubagentTrackerSize()).toBe(1);

    // Now simulate the team being in terminal state 'done'
    const terminalDb = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'done', phase: 'pr' }),
    });

    // Any event for the terminal team should clean up its trackers
    processEvent(
      makePayload({ event: 'tool_use', team: 'kea-100' }),
      terminalDb,
      sse,
    );

    expect(getSubagentTrackerSize()).toBe(0);
  });

  it('should clean subagent trackers when team is in terminal state (failed)', () => {
    const db = createMockDb();
    const sse = createMockSse();

    // Start subagents for the team
    processEvent(
      makePayload({ event: 'subagent_start', teammate_name: 'fleet-dev', team: 'kea-100' }),
      db,
      sse,
    );
    processEvent(
      makePayload({ event: 'subagent_start', teammate_name: 'fleet-planner', team: 'kea-100' }),
      db,
      sse,
    );
    expect(getSubagentTrackerSize()).toBe(2);

    // Simulate the team being in terminal state 'failed'
    const terminalDb = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'failed', phase: 'implementing' }),
    });

    processEvent(
      makePayload({ event: 'tool_use', team: 'kea-100' }),
      terminalDb,
      sse,
    );

    expect(getSubagentTrackerSize()).toBe(0);
  });

  it('should NOT clean trackers for other teams when one team reaches terminal state', () => {
    const db = createMockDb();
    const sse = createMockSse();

    // Start subagents on two different teams
    processEvent(
      makePayload({ event: 'subagent_start', teammate_name: 'fleet-dev', team: 'kea-100' }),
      db,
      sse,
    );
    processEvent(
      makePayload({ event: 'subagent_start', teammate_name: 'fleet-dev', team: 'kea-200' }),
      db,
      sse,
    );
    expect(getSubagentTrackerSize()).toBe(2);

    // Only kea-100 reaches terminal state
    const terminalDb = createMockDb({
      getTeamByWorktree: vi.fn().mockImplementation((worktree: string) => {
        if (worktree === 'kea-100') return { id: 1, status: 'done', phase: 'pr' };
        return { id: 2, status: 'running', phase: 'implementing' };
      }),
    });

    processEvent(
      makePayload({ event: 'tool_use', team: 'kea-100' }),
      terminalDb,
      sse,
    );

    // Only kea-100 trackers should be cleaned; kea-200 should remain
    expect(getSubagentTrackerSize()).toBe(1);
  });
});

// =============================================================================
// cc_stdin payload parsing (Issue #200)
// =============================================================================

describe('buildPayloadFromCcStdin', () => {
  it('extracts all standard CC fields from cc_stdin JSON', () => {
    const ccData = {
      session_id: 'sess-xyz',
      tool_name: 'Bash',
      agent_type: 'coordinator',
      teammate_name: 'dev-ts',
      message: 'Running tests',
      error: 'exit code 1',
      tool_use_id: 'toolu_abc',
      error_details: 'rate_limit',
      last_assistant_message: 'I was about to finish',
    };
    const body = {
      event: 'tool_use',
      team: 'kea-100',
      timestamp: '2026-03-19T00:00:00Z',
      cc_stdin: JSON.stringify(ccData),
    };

    const payload = buildPayloadFromCcStdin(body);

    expect(payload.event).toBe('tool_use');
    expect(payload.team).toBe('kea-100');
    expect(payload.timestamp).toBe('2026-03-19T00:00:00Z');
    expect(payload.cc_stdin).toBe(JSON.stringify(ccData));
    expect(payload.session_id).toBe('sess-xyz');
    expect(payload.tool_name).toBe('Bash');
    expect(payload.agent_type).toBe('coordinator');
    expect(payload.teammate_name).toBe('dev-ts');
    expect(payload.message).toBe('Running tests');
    expect(payload.error).toBe('exit code 1');
    expect(payload.tool_use_id).toBe('toolu_abc');
    expect(payload.error_details).toBe('rate_limit');
    expect(payload.last_assistant_message).toBe('I was about to finish');
  });

  it('extracts tool_input as stringified JSON when CC sends it as object', () => {
    const ccData = {
      session_id: 'sess-1',
      tool_name: 'Bash',
      tool_input: { command: 'npm test', timeout: 60000 },
    };
    const body = {
      event: 'tool_use',
      team: 'kea-100',
      cc_stdin: JSON.stringify(ccData),
    };

    const payload = buildPayloadFromCcStdin(body);

    expect(payload.tool_input).toBe(JSON.stringify({ command: 'npm test', timeout: 60000 }));
  });

  it('extracts tool_input as-is when CC sends it as string', () => {
    const ccData = {
      session_id: 'sess-1',
      tool_name: 'Bash',
      tool_input: '{"command":"npm test"}',
    };
    const body = {
      event: 'tool_use',
      team: 'kea-100',
      cc_stdin: JSON.stringify(ccData),
    };

    const payload = buildPayloadFromCcStdin(body);

    expect(payload.tool_input).toBe('{"command":"npm test"}');
  });

  it('extracts SendMessage routing fields from tool_input object', () => {
    const ccData = {
      session_id: 'sess-1',
      tool_name: 'SendMessage',
      agent_type: 'coordinator',
      tool_input: {
        to: 'dev-typescript',
        summary: 'Review the PR',
        content: 'Full message body here',
      },
    };
    const body = {
      event: 'tool_use',
      team: 'kea-100',
      cc_stdin: JSON.stringify(ccData),
    };

    const payload = buildPayloadFromCcStdin(body);

    expect(payload.tool_name).toBe('SendMessage');
    expect(payload.msg_to).toBe('dev-typescript');
    expect(payload.msg_summary).toBe('Review the PR');
    expect(payload.tool_input).toBe(JSON.stringify(ccData.tool_input));
  });

  it('extracts newly-capturable fields (model, source, notification_type, agent_id, cwd)', () => {
    const ccData = {
      session_id: 'sess-1',
      tool_name: 'Read',
      model: 'claude-sonnet-4-20250514',
      source: 'tool_use',
      notification_type: 'stuck',
      agent_id: 'agent-abc-123',
      cwd: '/home/user/project',
    };
    const body = {
      event: 'tool_use',
      team: 'kea-100',
      cc_stdin: JSON.stringify(ccData),
    };

    const payload = buildPayloadFromCcStdin(body);

    expect(payload.model).toBe('claude-sonnet-4-20250514');
    expect(payload.source).toBe('tool_use');
    expect(payload.notification_type).toBe('stuck');
    expect(payload.agent_id).toBe('agent-abc-123');
    expect(payload.cwd).toBe('/home/user/project');
  });

  it('handles invalid cc_stdin JSON gracefully', () => {
    const body = {
      event: 'tool_use',
      team: 'kea-100',
      cc_stdin: 'not-valid-json{{{',
    };

    const payload = buildPayloadFromCcStdin(body);

    expect(payload.event).toBe('tool_use');
    expect(payload.team).toBe('kea-100');
    expect(payload.cc_stdin).toBe('not-valid-json{{{');
    // No fields should be extracted
    expect(payload.session_id).toBeUndefined();
    expect(payload.tool_name).toBeUndefined();
  });

  it('handles cc_stdin that is an array (not an object)', () => {
    const body = {
      event: 'tool_use',
      team: 'kea-100',
      cc_stdin: JSON.stringify([1, 2, 3]),
    };

    const payload = buildPayloadFromCcStdin(body);

    expect(payload.event).toBe('tool_use');
    expect(payload.cc_stdin).toBe('[1,2,3]');
    // Array is not an object — no fields extracted
    expect(payload.session_id).toBeUndefined();
  });

  it('handles empty cc_stdin object', () => {
    const body = {
      event: 'session_start',
      team: 'kea-100',
      cc_stdin: '{}',
    };

    const payload = buildPayloadFromCcStdin(body);

    expect(payload.event).toBe('session_start');
    expect(payload.session_id).toBeUndefined();
    expect(payload.tool_name).toBeUndefined();
  });

  it('does not extract msg_to/msg_summary for non-SendMessage tools', () => {
    const ccData = {
      tool_name: 'Bash',
      tool_input: { to: 'someone', summary: 'something' },
    };
    const body = {
      event: 'tool_use',
      team: 'kea-100',
      cc_stdin: JSON.stringify(ccData),
    };

    const payload = buildPayloadFromCcStdin(body);

    expect(payload.msg_to).toBeUndefined();
    expect(payload.msg_summary).toBeUndefined();
  });
});

describe('buildPayloadFromLegacy', () => {
  it('extracts all fields from legacy format body', () => {
    const body = {
      event: 'tool_use',
      team: 'kea-100',
      timestamp: '2026-03-19T00:00:00Z',
      session_id: 'sess-abc',
      tool_name: 'Bash',
      agent_type: 'coordinator',
      teammate_name: 'dev-ts',
      message: 'Hello',
      error: 'exit 1',
      tool_use_id: 'toolu_xyz',
      tool_input: '{"command":"ls"}',
      error_details: 'rate_limit',
      last_assistant_message: 'I was running',
      worktree_root: '/path/to/worktree',
      msg_to: 'reviewer',
      msg_summary: 'Ready for review',
    };

    const payload = buildPayloadFromLegacy(body);

    expect(payload.event).toBe('tool_use');
    expect(payload.team).toBe('kea-100');
    expect(payload.session_id).toBe('sess-abc');
    expect(payload.tool_name).toBe('Bash');
    expect(payload.agent_type).toBe('coordinator');
    expect(payload.teammate_name).toBe('dev-ts');
    expect(payload.message).toBe('Hello');
    expect(payload.error).toBe('exit 1');
    expect(payload.tool_use_id).toBe('toolu_xyz');
    expect(payload.tool_input).toBe('{"command":"ls"}');
    expect(payload.error_details).toBe('rate_limit');
    expect(payload.last_assistant_message).toBe('I was running');
    expect(payload.worktree_root).toBe('/path/to/worktree');
    expect(payload.msg_to).toBe('reviewer');
    expect(payload.msg_summary).toBe('Ready for review');
  });

  it('handles missing optional fields gracefully', () => {
    const body = {
      event: 'session_start',
      team: 'kea-200',
    };

    const payload = buildPayloadFromLegacy(body);

    expect(payload.event).toBe('session_start');
    expect(payload.team).toBe('kea-200');
    expect(payload.session_id).toBeUndefined();
    expect(payload.tool_name).toBeUndefined();
    expect(payload.cc_stdin).toBeUndefined();
  });

  it('does not include cc_stdin field', () => {
    const body = {
      event: 'tool_use',
      team: 'kea-100',
      session_id: 'sess-1',
    };

    const payload = buildPayloadFromLegacy(body);

    expect(payload.cc_stdin).toBeUndefined();
  });
});

// =============================================================================
// cc_stdin payloads through processEvent (end-to-end)
// =============================================================================

describe('cc_stdin payloads through processEvent', () => {
  it('stores cc_stdin and new fields in the event payload JSON', () => {
    const db = createMockDb();
    const sse = createMockSse();

    const ccStdin = JSON.stringify({
      session_id: 'sess-new',
      tool_name: 'Edit',
      model: 'claude-sonnet-4-20250514',
      source: 'tool_use',
      agent_id: 'agent-001',
      cwd: '/workdir',
    });

    const payload: EventPayload = {
      event: 'tool_use',
      team: 'kea-100',
      cc_stdin: ccStdin,
      session_id: 'sess-new',
      tool_name: 'Edit',
      model: 'claude-sonnet-4-20250514',
      source: 'tool_use',
      agent_id: 'agent-001',
      cwd: '/workdir',
    };

    const result = processEvent(payload, db, sse);

    expect(result.processed).toBe(true);

    // Verify the stored payload JSON includes cc_stdin and new fields
    const insertCall = (db.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const storedPayload = JSON.parse(insertCall.payload);
    expect(storedPayload.cc_stdin).toBe(ccStdin);
    expect(storedPayload.model).toBe('claude-sonnet-4-20250514');
    expect(storedPayload.source).toBe('tool_use');
    expect(storedPayload.agent_id).toBe('agent-001');
    expect(storedPayload.cwd).toBe('/workdir');
  });

  it('correctly routes SendMessage from cc_stdin-parsed payload', () => {
    const db = createMockDb();
    const sse = createMockSse();

    const payload: EventPayload = {
      event: 'tool_use',
      team: 'kea-100',
      session_id: 'sess-1',
      tool_name: 'SendMessage',
      agent_type: 'coordinator',
      msg_to: 'dev-typescript',
      msg_summary: 'Implement the fix',
      message: 'Full content',
      cc_stdin: JSON.stringify({
        session_id: 'sess-1',
        tool_name: 'SendMessage',
        agent_type: 'coordinator',
        tool_input: { to: 'dev-typescript', summary: 'Implement the fix', content: 'Full content' },
      }),
    };

    processEvent(payload, db, sse);

    expect(db.insertAgentMessage).toHaveBeenCalledWith({
      teamId: 1,
      eventId: 1,
      sender: 'coordinator', // normalized (no fleet- prefix to strip)
      recipient: 'dev-typescript', // normalized (no fleet- prefix to strip)
      summary: 'Implement the fix',
      content: 'Full content',
      sessionId: 'sess-1',
    });
  });

  it('handles nested tool_input with special characters that would break shell regex', () => {
    const db = createMockDb();
    const sse = createMockSse();

    const complexToolInput = {
      command: 'echo "hello {world}" | grep -o "\\w+"',
      nested: { key: 'value with "quotes" and {braces}' },
    };

    const payload: EventPayload = {
      event: 'tool_use',
      team: 'kea-100',
      session_id: 'sess-1',
      tool_name: 'Bash',
      tool_input: JSON.stringify(complexToolInput),
      cc_stdin: JSON.stringify({
        session_id: 'sess-1',
        tool_name: 'Bash',
        tool_input: complexToolInput,
      }),
    };

    const result = processEvent(payload, db, sse);

    expect(result.processed).toBe(true);
    const insertCall = (db.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const storedPayload = JSON.parse(insertCall.payload);
    expect(storedPayload.tool_input).toBe(JSON.stringify(complexToolInput));
  });
});

// =============================================================================
// normalizeAgentName (Issue #178)
// =============================================================================

describe('normalizeAgentName', () => {
  it('strips fleet- prefix', () => {
    expect(normalizeAgentName('fleet-dev')).toBe('dev');
    expect(normalizeAgentName('fleet-planner')).toBe('planner');
    expect(normalizeAgentName('fleet-reviewer')).toBe('reviewer');
  });

  it('maps empty/null/undefined to "team-lead"', () => {
    expect(normalizeAgentName(null)).toBe('team-lead');
    expect(normalizeAgentName(undefined)).toBe('team-lead');
    expect(normalizeAgentName('')).toBe('team-lead');
    expect(normalizeAgentName('  ')).toBe('team-lead');
  });

  it('passes through names without fleet- prefix', () => {
    expect(normalizeAgentName('coordinator')).toBe('coordinator');
    expect(normalizeAgentName('dev-typescript')).toBe('dev-typescript');
    expect(normalizeAgentName('team-lead')).toBe('team-lead');
  });

  it('trims whitespace', () => {
    expect(normalizeAgentName(' fleet-dev ')).toBe('dev');
    expect(normalizeAgentName(' coordinator ')).toBe('coordinator');
  });
});

// =============================================================================
// Agent name normalization in event processing (Issue #178)
// =============================================================================

describe('Agent name normalization in event processing', () => {
  it('normalizes fleet- prefixed agent_type in event insertion', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makePayload({
      event: 'tool_use',
      agent_type: 'fleet-dev',
    });

    processEvent(payload, db, sse);

    expect(db.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'dev', // fleet- prefix stripped
      }),
    );
  });

  it('normalizes fleet- prefixed agent_type in SSE broadcast', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makePayload({
      event: 'session_start',
      agent_type: 'fleet-planner',
    });

    processEvent(payload, db, sse);

    expect(sse.broadcast).toHaveBeenCalledWith(
      'team_event',
      expect.objectContaining({
        agent_name: 'planner', // fleet- prefix stripped
      }),
    );
  });

  it('maps missing agent_type to team-lead in event insertion', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makePayload({
      event: 'session_start',
      agent_type: undefined,
    });

    processEvent(payload, db, sse);

    expect(db.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'team-lead',
      }),
    );
  });

  it('normalizes fleet- prefixed sender and recipient in agent messages', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makePayload({
      event: 'tool_use',
      tool_name: 'SendMessage',
      agent_type: 'fleet-planner',
      msg_to: 'fleet-dev',
      msg_summary: 'Here is the brief',
    });

    processEvent(payload, db, sse);

    expect(db.insertAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: 'planner', // fleet- prefix stripped
        recipient: 'dev',  // fleet- prefix stripped
      }),
    );
  });

  it('normalizes msg_to with fleet- prefix in agent messages', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makePayload({
      event: 'tool_use',
      tool_name: 'SendMessage',
      agent_type: 'coordinator',
      msg_to: 'fleet-reviewer',
      msg_summary: 'Please review',
    });

    processEvent(payload, db, sse);

    expect(db.insertAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: 'coordinator',
        recipient: 'reviewer', // fleet- prefix stripped
      }),
    );
  });
});

// =============================================================================
// Transaction atomicity (Issue #492)
// =============================================================================

describe('Transaction atomicity', () => {
  it('calls processEventTransaction with all operations for a state-transitioning event', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'idle', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'session_start' });

    processEvent(payload, db, sse);

    expect(db.processEventTransaction).toHaveBeenCalledTimes(1);
    const ops = (db.processEventTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];

    // Transition should be populated
    expect(ops.transition).toEqual(
      expect.objectContaining({
        teamId: 1,
        fromStatus: 'idle',
        toStatus: 'running',
        trigger: 'hook',
      }),
    );

    // Status update should be populated
    expect(ops.statusUpdate).toEqual(
      expect.objectContaining({
        teamId: 1,
        fields: { status: 'running' },
      }),
    );

    // Heartbeat always required
    expect(ops.heartbeatUpdate).toEqual(
      expect.objectContaining({
        teamId: 1,
        lastEventAt: expect.any(String),
      }),
    );

    // Event insert always required
    expect(ops.eventInsert).toEqual(
      expect.objectContaining({
        teamId: 1,
        eventType: 'SessionStart',
      }),
    );
  });

  it('calls processEventTransaction without transition for a running team event', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'running', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'tool_use' });

    processEvent(payload, db, sse);

    expect(db.processEventTransaction).toHaveBeenCalledTimes(1);
    const ops = (db.processEventTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];

    // No transition or status update for already-running team
    expect(ops.transition).toBeUndefined();
    expect(ops.statusUpdate).toBeUndefined();

    // Heartbeat and event insert always present
    expect(ops.heartbeatUpdate).toBeDefined();
    expect(ops.eventInsert).toBeDefined();
  });

  it('logs error and re-throws when processEventTransaction fails', () => {
    const txError = new Error('SQLITE_BUSY: database is locked');
    const db = createMockDb({
      processEventTransaction: vi.fn().mockImplementation(() => {
        throw txError;
      }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'session_start' });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => processEvent(payload, db, sse)).toThrow('SQLITE_BUSY');

      // Verify console.error was called with team/event context
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('team=kea-100'),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('event=session_start'),
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('calls processThrottledUpdate for throttled tool_use heartbeat', () => {
    const db = createMockDb();
    const sse = createMockSse();

    // First tool_use goes through the full transaction
    processEvent(makePayload({ event: 'tool_use' }), db, sse);
    expect(db.processEventTransaction).toHaveBeenCalledTimes(1);
    expect(db.processThrottledUpdate).toHaveBeenCalledTimes(0);

    // Second tool_use within throttle window — should call processThrottledUpdate
    const result = processEvent(makePayload({ event: 'tool_use' }), db, sse);
    expect(result.processed).toBe(false);
    expect(db.processEventTransaction).toHaveBeenCalledTimes(1); // still 1
    expect(db.processThrottledUpdate).toHaveBeenCalledTimes(1);

    // Verify the heartbeat was passed through
    const ops = (db.processThrottledUpdate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ops.heartbeatUpdate).toEqual({
      teamId: 1,
      lastEventAt: expect.any(String),
    });
    // No transition or status update for a running team
    expect(ops.transition).toBeUndefined();
    expect(ops.statusUpdate).toBeUndefined();
  });

  it('passes transition data to processThrottledUpdate when idle team receives throttled tool_use', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'idle', phase: 'implementing' }),
    });
    const sse = createMockSse();

    // First tool_use goes through the full transaction (and resets idle -> running)
    processEvent(makePayload({ event: 'tool_use' }), db, sse);
    expect(db.processEventTransaction).toHaveBeenCalledTimes(1);

    // Second tool_use within throttle window — throttled path
    // Team is still reported as 'idle' by the mock, so a transition should occur
    const result = processEvent(makePayload({ event: 'tool_use' }), db, sse);
    expect(result.processed).toBe(false);
    expect(db.processThrottledUpdate).toHaveBeenCalledTimes(1);

    const ops = (db.processThrottledUpdate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ops.transition).toEqual(
      expect.objectContaining({
        teamId: 1,
        fromStatus: 'idle',
        toStatus: 'running',
      }),
    );
    expect(ops.statusUpdate).toEqual(
      expect.objectContaining({
        teamId: 1,
        fields: expect.objectContaining({ status: 'running' }),
      }),
    );
    expect(ops.heartbeatUpdate).toEqual({
      teamId: 1,
      lastEventAt: expect.any(String),
    });
  });

  it('wraps terminal-state event inserts in a transaction (no transition)', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'done', phase: 'done' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'notification' });

    processEvent(payload, db, sse);

    expect(db.processEventTransaction).toHaveBeenCalledTimes(1);
    const ops = (db.processEventTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ops.transition).toBeUndefined();
    expect(ops.statusUpdate).toBeUndefined();
    expect(ops.eventInsert.eventType).toBe('Notification');
  });
});

// =============================================================================
// Agent messages in transaction (Issue #492)
// =============================================================================

describe('Agent messages in transaction', () => {
  it('includes SubagentStart spawn message in transaction agentMessages', () => {
    const db = createMockDb();
    const sse = createMockSse();

    processEvent(
      makePayload({ event: 'subagent_start', teammate_name: 'fleet-dev', agent_type: 'coordinator' }),
      db,
      sse,
    );

    expect(db.processEventTransaction).toHaveBeenCalledTimes(1);
    const ops = (db.processEventTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];

    expect(ops.agentMessages).toBeDefined();
    expect(ops.agentMessages).toHaveLength(1);
    expect(ops.agentMessages[0]).toEqual(
      expect.objectContaining({
        teamId: 1,
        sender: 'team-lead',
        recipient: 'dev',
        summary: 'spawned agent',
      }),
    );
  });

  it('includes SendMessage routing in transaction agentMessages', () => {
    const db = createMockDb();
    const sse = createMockSse();

    processEvent(
      makePayload({
        event: 'tool_use',
        tool_name: 'SendMessage',
        agent_type: 'coordinator',
        msg_to: 'dev-typescript',
        msg_summary: 'Implement the fix',
        message: 'Full content',
        session_id: 'sess-abc',
      }),
      db,
      sse,
    );

    expect(db.processEventTransaction).toHaveBeenCalledTimes(1);
    const ops = (db.processEventTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];

    expect(ops.agentMessages).toBeDefined();
    expect(ops.agentMessages).toHaveLength(1);
    expect(ops.agentMessages[0]).toEqual(
      expect.objectContaining({
        teamId: 1,
        sender: 'coordinator',
        recipient: 'dev-typescript',
        summary: 'Implement the fix',
        content: 'Full content',
        sessionId: 'sess-abc',
      }),
    );
  });

  it('does not include agentMessages when neither SubagentStart nor SendMessage', () => {
    const db = createMockDb();
    const sse = createMockSse();

    processEvent(
      makePayload({ event: 'tool_use', tool_name: 'Bash', agent_type: 'coordinator' }),
      db,
      sse,
    );

    expect(db.processEventTransaction).toHaveBeenCalledTimes(1);
    const ops = (db.processEventTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ops.agentMessages).toBeUndefined();
  });
});

// =============================================================================
// Phase transitions (Issue #494)
// =============================================================================

describe('Phase transitions (Issue #494)', () => {
  it('should advance init -> analyzing on SubagentStart with planner agent', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'running', phase: 'init' }),
    });
    const sse = createMockSse();

    processEvent(
      makePayload({ event: 'subagent_start', teammate_name: 'fleet-planner' }),
      db,
      sse,
    );

    // statusUpdate should include phase: 'analyzing'
    const ops = (db.processEventTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ops.statusUpdate).toBeDefined();
    expect(ops.statusUpdate.fields.phase).toBe('analyzing');

    // SSE should broadcast phase change
    expect(sse.broadcast).toHaveBeenCalledWith(
      'team_status_changed',
      expect.objectContaining({
        team_id: 1,
        phase: 'analyzing',
        previous_phase: 'init',
      }),
      1,
    );
  });

  it('should advance analyzing -> implementing on SubagentStop with planner agent', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'running', phase: 'analyzing' }),
    });
    const sse = createMockSse();

    processEvent(
      makePayload({ event: 'subagent_stop', teammate_name: 'fleet-planner' }),
      db,
      sse,
    );

    const ops = (db.processEventTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ops.statusUpdate).toBeDefined();
    expect(ops.statusUpdate.fields.phase).toBe('implementing');
  });

  it('should advance implementing -> reviewing on SubagentStop with dev agent', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'running', phase: 'implementing' }),
    });
    const sse = createMockSse();

    processEvent(
      makePayload({ event: 'subagent_stop', teammate_name: 'fleet-dev' }),
      db,
      sse,
    );

    const ops = (db.processEventTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ops.statusUpdate).toBeDefined();
    expect(ops.statusUpdate.fields.phase).toBe('reviewing');
  });

  it('should advance reviewing -> pr on SubagentStop with reviewer agent', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'running', phase: 'reviewing' }),
    });
    const sse = createMockSse();

    processEvent(
      makePayload({ event: 'subagent_stop', teammate_name: 'fleet-reviewer' }),
      db,
      sse,
    );

    const ops = (db.processEventTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ops.statusUpdate).toBeDefined();
    expect(ops.statusUpdate.fields.phase).toBe('pr');
  });

  it('should NOT regress phase (implementing -> analyzing on planner SubagentStart)', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'running', phase: 'implementing' }),
    });
    const sse = createMockSse();

    processEvent(
      makePayload({ event: 'subagent_start', teammate_name: 'fleet-planner' }),
      db,
      sse,
    );

    // No statusUpdate for phase should be created (no status transition either)
    const ops = (db.processEventTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ops.statusUpdate).toBeUndefined();

    // SSE should NOT broadcast a phase change
    const statusBroadcasts = (sse.broadcast as ReturnType<typeof vi.fn>).mock.calls
      .filter((call: unknown[]) => call[0] === 'team_status_changed');
    expect(statusBroadcasts.length).toBe(0);
  });

  it('should NOT update phase on terminal team (done)', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'done', phase: 'done' }),
    });
    const sse = createMockSse();

    processEvent(
      makePayload({ event: 'subagent_start', teammate_name: 'fleet-planner' }),
      db,
      sse,
    );

    const ops = (db.processEventTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ops.statusUpdate).toBeUndefined();
  });

  it('should handle variant agent names (csharp-dev maps to dev role)', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'running', phase: 'analyzing' }),
    });
    const sse = createMockSse();

    processEvent(
      makePayload({ event: 'subagent_start', teammate_name: 'csharp-dev' }),
      db,
      sse,
    );

    const ops = (db.processEventTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ops.statusUpdate).toBeDefined();
    expect(ops.statusUpdate.fields.phase).toBe('implementing');
  });

  it('should handle variant agent names (weryfikator maps to reviewer role)', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'running', phase: 'implementing' }),
    });
    const sse = createMockSse();

    processEvent(
      makePayload({ event: 'subagent_start', teammate_name: 'weryfikator' }),
      db,
      sse,
    );

    const ops = (db.processEventTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ops.statusUpdate).toBeDefined();
    expect(ops.statusUpdate.fields.phase).toBe('reviewing');
  });

  it('should handle unknown agent name (no phase change)', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'running', phase: 'init' }),
    });
    const sse = createMockSse();

    processEvent(
      makePayload({ event: 'subagent_start', teammate_name: 'pr-watcher' }),
      db,
      sse,
    );

    const ops = (db.processEventTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // No statusUpdate should exist (no status or phase change)
    expect(ops.statusUpdate).toBeUndefined();
  });

  it('should combine status transition and phase transition in single broadcast', () => {
    // Team is idle, SubagentStart from planner arrives => idle->running + init->analyzing
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'idle', phase: 'init' }),
    });
    const sse = createMockSse();

    processEvent(
      makePayload({ event: 'subagent_start', teammate_name: 'fleet-planner' }),
      db,
      sse,
    );

    // Both status and phase should be in the same statusUpdate
    const ops = (db.processEventTransaction as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ops.statusUpdate).toBeDefined();
    expect(ops.statusUpdate.fields.status).toBe('running');
    expect(ops.statusUpdate.fields.phase).toBe('analyzing');

    // Should emit exactly ONE team_status_changed broadcast with both fields
    const statusBroadcasts = (sse.broadcast as ReturnType<typeof vi.fn>).mock.calls
      .filter((call: unknown[]) => call[0] === 'team_status_changed');
    expect(statusBroadcasts.length).toBe(1);
    expect(statusBroadcasts[0][1]).toEqual(expect.objectContaining({
      team_id: 1,
      status: 'running',
      previous_status: 'idle',
      phase: 'analyzing',
      previous_phase: 'init',
    }));
  });

  describe('classifyAgentRole', () => {
    it('should return planner for planner variants', () => {
      expect(classifyAgentRole('planner')).toBe('planner');
      expect(classifyAgentRole('analyst')).toBe('planner');
      expect(classifyAgentRole('analityk')).toBe('planner');
    });

    it('should return dev for dev variants', () => {
      expect(classifyAgentRole('dev')).toBe('dev');
      expect(classifyAgentRole('csharp-dev')).toBe('dev');
      expect(classifyAgentRole('fsharp-dev')).toBe('dev');
      expect(classifyAgentRole('developer')).toBe('dev');
      expect(classifyAgentRole('implementer')).toBe('dev');
    });

    it('should return reviewer for reviewer variants', () => {
      expect(classifyAgentRole('reviewer')).toBe('reviewer');
      expect(classifyAgentRole('weryfikator')).toBe('reviewer');
      expect(classifyAgentRole('code-review')).toBe('reviewer');
    });

    it('should return null for unknown agents', () => {
      expect(classifyAgentRole('team-lead')).toBeNull();
      expect(classifyAgentRole('pr-watcher')).toBeNull();
      expect(classifyAgentRole('coordinator')).toBeNull();
    });
  });

  describe('shouldAdvancePhase', () => {
    it('should return true for forward transitions', () => {
      expect(shouldAdvancePhase('init', 'analyzing')).toBe(true);
      expect(shouldAdvancePhase('analyzing', 'implementing')).toBe(true);
      expect(shouldAdvancePhase('implementing', 'reviewing')).toBe(true);
      expect(shouldAdvancePhase('reviewing', 'pr')).toBe(true);
      expect(shouldAdvancePhase('pr', 'done')).toBe(true);
    });

    it('should return false for backward transitions', () => {
      expect(shouldAdvancePhase('implementing', 'analyzing')).toBe(false);
      expect(shouldAdvancePhase('reviewing', 'implementing')).toBe(false);
      expect(shouldAdvancePhase('pr', 'reviewing')).toBe(false);
    });

    it('should return false when current phase is done', () => {
      expect(shouldAdvancePhase('done', 'analyzing')).toBe(false);
      expect(shouldAdvancePhase('done', 'implementing')).toBe(false);
    });

    it('should allow forward progression from blocked', () => {
      expect(shouldAdvancePhase('blocked', 'analyzing')).toBe(true);
      expect(shouldAdvancePhase('blocked', 'implementing')).toBe(true);
      expect(shouldAdvancePhase('blocked', 'pr')).toBe(true);
    });
  });
});

// =============================================================================
// Worktree lifecycle events (Issue #512)
// =============================================================================

describe('Worktree lifecycle events (Issue #512)', () => {
  it('worktree_create does NOT transition launching -> running', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'launching', phase: 'init' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'worktree_create' });

    processEvent(payload, db, sse);

    // Should NOT have inserted a transition or changed status
    expect(db.insertTransition).not.toHaveBeenCalled();
    const statusCalls = (db.updateTeam as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).status !== undefined,
    );
    expect(statusCalls).toHaveLength(0);
  });

  it('worktree_remove does NOT transition launching -> running', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'launching', phase: 'init' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'worktree_remove' });

    processEvent(payload, db, sse);

    expect(db.insertTransition).not.toHaveBeenCalled();
    const statusCalls = (db.updateTeam as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).status !== undefined,
    );
    expect(statusCalls).toHaveLength(0);
  });

  it('worktree_create DOES wake idle team to running', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'idle', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'worktree_create' });

    processEvent(payload, db, sse);

    expect(db.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        fromStatus: 'idle',
        toStatus: 'running',
        trigger: 'hook',
      }),
    );
    expect(db.updateTeam).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'running' }),
    );
  });

  it('worktree_remove DOES wake idle team to running', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'idle', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'worktree_remove' });

    processEvent(payload, db, sse);

    expect(db.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        fromStatus: 'idle',
        toStatus: 'running',
        trigger: 'hook',
      }),
    );
    expect(db.updateTeam).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'running' }),
    );
  });

  it('worktree_create DOES wake stuck team to running', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'stuck', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ event: 'worktree_create' });

    processEvent(payload, db, sse);

    expect(db.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        fromStatus: 'stuck',
        toStatus: 'running',
        trigger: 'hook',
      }),
    );
  });

  it('worktree_create stores worktree_path in payload JSON', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makePayload({
      event: 'worktree_create',
      worktree_path: '/path/to/worktree',
    });

    processEvent(payload, db, sse);

    const insertCall = (db.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const storedPayload = JSON.parse(insertCall.payload);
    expect(storedPayload.worktree_path).toBe('/path/to/worktree');
  });

  it('worktree_create is never throttled', () => {
    const db = createMockDb();
    const sse = createMockSse();

    const r1 = processEvent(makePayload({ event: 'worktree_create' }), db, sse);
    const r2 = processEvent(makePayload({ event: 'worktree_create' }), db, sse);
    const r3 = processEvent(makePayload({ event: 'worktree_create' }), db, sse);

    expect(r1.processed).toBe(true);
    expect(r2.processed).toBe(true);
    expect(r3.processed).toBe(true);
  });

  it('worktree_remove is never throttled', () => {
    const db = createMockDb();
    const sse = createMockSse();

    const r1 = processEvent(makePayload({ event: 'worktree_remove' }), db, sse);
    const r2 = processEvent(makePayload({ event: 'worktree_remove' }), db, sse);
    const r3 = processEvent(makePayload({ event: 'worktree_remove' }), db, sse);

    expect(r1.processed).toBe(true);
    expect(r2.processed).toBe(true);
    expect(r3.processed).toBe(true);
  });
});

// =============================================================================
// Worktree payload parsing (Issue #512)
// =============================================================================

describe('Worktree payload parsing (Issue #512)', () => {
  it('buildPayloadFromCcStdin extracts worktree_path', () => {
    const ccData = {
      session_id: 'sess-1',
      worktree_path: '/home/user/project/.worktrees/feat-123',
      teammate_name: 'dev',
    };
    const body = {
      event: 'worktree_create',
      team: 'kea-100',
      cc_stdin: JSON.stringify(ccData),
    };

    const payload = buildPayloadFromCcStdin(body);

    expect(payload.worktree_path).toBe('/home/user/project/.worktrees/feat-123');
    expect(payload.session_id).toBe('sess-1');
    expect(payload.teammate_name).toBe('dev');
  });

  it('buildPayloadFromCcStdin extracts worktree_root', () => {
    const ccData = {
      session_id: 'sess-1',
      worktree_root: '/home/user/project',
    };
    const body = {
      event: 'worktree_create',
      team: 'kea-100',
      cc_stdin: JSON.stringify(ccData),
    };

    const payload = buildPayloadFromCcStdin(body);

    expect(payload.worktree_root).toBe('/home/user/project');
  });

  it('buildPayloadFromLegacy extracts worktree_path', () => {
    const body = {
      event: 'worktree_create',
      team: 'kea-100',
      worktree_path: '/path/to/worktree',
      worktree_root: '/path/to/root',
    };

    const payload = buildPayloadFromLegacy(body);

    expect(payload.worktree_path).toBe('/path/to/worktree');
    expect(payload.worktree_root).toBe('/path/to/root');
  });
});

// =============================================================================
// TaskCreated event processing
// =============================================================================

describe('TaskCreated event processing', () => {
  it('should upsert task and broadcast task_updated SSE event', () => {
    const upsertTeamTask = vi.fn().mockReturnValue({
      id: 1,
      teamId: 1,
      taskId: 'task-1',
      subject: 'Implement feature',
      status: 'in_progress',
      owner: 'team-lead',
    });
    const db = createMockDb({ upsertTeamTask });
    const sse = createMockSse();

    const payload = makePayload({
      event: 'task_created',
      cc_stdin: JSON.stringify({
        task_id: 'task-1',
        subject: 'Implement feature',
        status: 'in_progress',
      }),
    });

    processEvent(payload, db, sse);

    expect(upsertTeamTask).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        taskId: 'task-1',
        subject: 'Implement feature',
        status: 'in_progress',
      }),
    );

    // Verify task_updated SSE broadcast
    const taskBroadcasts = (sse.broadcast as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => call[0] === 'task_updated',
    );
    expect(taskBroadcasts.length).toBe(1);
    expect(taskBroadcasts[0][1]).toMatchObject({
      team_id: 1,
      task_id: 'task-1',
      subject: 'Implement feature',
      status: 'in_progress',
    });
  });

  it('should handle malformed cc_stdin gracefully and use fallback fields', () => {
    const upsertTeamTask = vi.fn().mockReturnValue({
      id: 1,
      teamId: 1,
      taskId: expect.any(String),
      subject: 'Some message',
      status: 'pending',
      owner: 'team-lead',
    });
    const db = createMockDb({ upsertTeamTask });
    const sse = createMockSse();

    const payload = makePayload({
      event: 'task_created',
      cc_stdin: 'not valid json{{{',
      message: 'Some message',
    });

    // Should not throw
    const result = processEvent(payload, db, sse);
    expect(result.processed).toBe(true);

    // Should still call upsertTeamTask with fallback values
    // taskId should be content-based: task-{teamId}-{subjectSlug}
    expect(upsertTeamTask).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        taskId: 'task-1-some-message',
        subject: 'Some message',
        status: 'pending',
      }),
    );
  });

  it('should produce stable taskId across repeated events with same subject but different tool_use_ids', () => {
    const upsertTeamTask = vi.fn().mockReturnValue({
      id: 1,
      teamId: 1,
      taskId: 'task-1-implement-login-page',
      subject: 'Implement login page',
      status: 'in_progress',
      owner: 'team-lead',
    });
    const db = createMockDb({ upsertTeamTask });
    const sse = createMockSse();

    // First event with one tool_use_id
    const payload1 = makePayload({
      event: 'task_created',
      cc_stdin: 'not valid json{{{',
      tool_use_id: 'toolu_abc123',
      message: 'Implement login page',
    });

    // Second event with a different tool_use_id (e.g., after context compaction)
    const payload2 = makePayload({
      event: 'task_created',
      cc_stdin: 'not valid json{{{',
      tool_use_id: 'toolu_def456',
      message: 'Implement login page',
    });

    processEvent(payload1, db, sse);
    processEvent(payload2, db, sse);

    // Both calls should produce the same stable taskId based on content, not tool_use_id
    const call1 = upsertTeamTask.mock.calls[0][0];
    const call2 = upsertTeamTask.mock.calls[1][0];
    expect(call1.taskId).toBe('task-1-implement-login-page');
    expect(call2.taskId).toBe('task-1-implement-login-page');
    expect(call1.taskId).toBe(call2.taskId);
  });

  it('should not throw when upsertTeamTask is not available on db', () => {
    // Simulates an older db that doesn't have the method
    const db = createMockDb();
    // Ensure upsertTeamTask is not set
    delete (db as Record<string, unknown>).upsertTeamTask;
    const sse = createMockSse();

    const payload = makePayload({ event: 'task_created' });

    // Should not throw
    const result = processEvent(payload, db, sse);
    expect(result.processed).toBe(true);
  });

  it('should normalize task_created event type to TaskCreated', () => {
    const db = createMockDb();
    const sse = createMockSse();

    const payload = makePayload({ event: 'task_created' });
    processEvent(payload, db, sse);

    // The event should be stored with normalized type
    const insertCall = db.processEventTransaction.mock.calls[0][0];
    expect(insertCall.eventInsert.eventType).toBe('TaskCreated');
  });
});
