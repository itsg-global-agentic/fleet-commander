// =============================================================================
// Fleet Commander — Event Collector Tests
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  processEvent,
  resetThrottleState,
  EventCollectorError,
  type EventPayload,
  type EventCollectorDb,
  type SseBroker,
} from '../../src/server/services/event-collector.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockDb(overrides?: Partial<EventCollectorDb>): EventCollectorDb {
  let nextEventId = 1;
  return {
    getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'running', phase: 'implementing' }),
    insertEvent: vi.fn().mockImplementation(() => nextEventId++),
    updateTeam: vi.fn(),
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

beforeEach(() => {
  resetThrottleState();
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
    'subagent_start',
    'subagent_stop',
    'notification',
    'teammate_idle',
    'cost_update',
  ];

  const normalizedTypes: Record<string, string> = {
    tool_use: 'ToolUse',
    session_start: 'SessionStart',
    session_end: 'SessionEnd',
    stop: 'Stop',
    subagent_start: 'SubagentStart',
    subagent_stop: 'SubagentStop',
    notification: 'Notification',
    teammate_idle: 'TeammateIdle',
    cost_update: 'CostUpdate',
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
  it('transitions idle -> running on any event', () => {
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

  it('transitions stuck -> running on any event', () => {
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
    'subagent_start',
    'subagent_stop',
    'notification',
    'teammate_idle',
    'cost_update',
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
        team: 'kea-100',
        event_type: 'SessionStart',
        session_id: 'sess-xyz',
        agent_name: 'kea-coordinator',
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

    expect(db.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        createdAt: expect.any(String),
      }),
    );
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
        agentName: null,
      }),
    );
  });
});
