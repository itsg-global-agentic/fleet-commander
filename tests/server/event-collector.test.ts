// =============================================================================
// Fleet Commander — Event Collector Tests
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  processEvent,
  resetThrottleState,
  resetSubagentTrackers,
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
  return {
    getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'running', phase: 'implementing' }),
    insertEvent: vi.fn().mockImplementation(() => ({ id: nextEventId++ })),
    updateTeam: vi.fn(),
    insertTransition: vi.fn(),
    insertAgentMessage: vi.fn().mockImplementation(() => ({ id: nextMsgId++ })),
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
    'cost_update',
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
        agentName: null,
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
      sender: 'coordinator',
      recipient: 'dev-typescript',
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
        recipient: '*',
        content: 'Team-wide broadcast',
      }),
    );
  });

  it('uses "unknown" as sender when agent_type is missing', () => {
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
        sender: 'unknown',
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
      makePayload({ event: 'subagent_start', teammate_name: 'fleet-analyst' }),
      db,
      sse,
      sender,
    );
    processEvent(
      makePayload({ event: 'subagent_stop', teammate_name: 'fleet-analyst' }),
      db,
      sse,
      sender,
    );

    const msg = sender.sendMessage.mock.calls[0][1] as string;
    expect(msg).toContain("Subagent 'fleet-analyst' appears to have crashed");
    expect(msg).toContain('s after start');
    expect(msg).toContain('events');
    expect(msg).toContain('Consider respawning');
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
      sender: 'coordinator',
      recipient: 'dev-typescript',
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
