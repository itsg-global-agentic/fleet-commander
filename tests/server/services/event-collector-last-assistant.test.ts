// =============================================================================
// Fleet Commander — Event Collector last_assistant_message capture tests
// =============================================================================
// Issue #729: CC 2.1.46+ emits `last_assistant_message` on Stop / SubagentStop
// / StopFailure hook input. EventCollector forwards this value to TeamManager
// via the optional `LastAssistantMessageSink` so the merge-claim cross-check
// can use it as the authoritative source (with parsedEvents extraction as
// fallback). These tests cover all gating conditions on the capture path.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  processEvent,
  resetThrottleState,
  resetSubagentTrackers,
  resetPrPollState,
  resetEventDedupState,
  type EventPayload,
  type EventCollectorDb,
  type SseBroker,
  type LastAssistantMessageSink,
} from '../../../src/server/services/event-collector.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockDb(overrides?: Partial<EventCollectorDb>): EventCollectorDb {
  let nextEventId = 1;
  let nextMsgId = 1;

  const insertEvent = vi.fn().mockImplementation(() => ({ id: nextEventId++ }));
  const updateTeam = vi.fn();
  const insertTransition = vi.fn();
  const insertAgentMessage = vi.fn().mockImplementation(() => ({ id: nextMsgId++ }));

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
    getTeamByWorktree: vi.fn().mockReturnValue({ id: 42, status: 'running', phase: 'implementing' }),
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

function createMockSink(): LastAssistantMessageSink & {
  noteLastAssistantMessage: ReturnType<typeof vi.fn>;
} {
  return {
    noteLastAssistantMessage: vi.fn(),
  };
}

function makeStopPayload(overrides?: Partial<EventPayload>): EventPayload {
  // Default: a TL `stop` event with last_assistant_message. agent_type is left
  // undefined so normalizeAgentName() returns 'team-lead'.
  return {
    event: 'stop',
    team: 'proj-100',
    timestamp: new Date().toISOString(),
    session_id: 'sess-abc',
    last_assistant_message: 'PR #42 merged, issue #10 closed. Team done.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetThrottleState();
  resetSubagentTrackers();
  resetPrPollState();
  resetEventDedupState();
});

// =============================================================================
// Capture path — happy cases
// =============================================================================

describe('EventCollector — last_assistant_message capture (issue #729)', () => {
  it('captures last_assistant_message on stop event from team-lead', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const sink = createMockSink();
    const payload = makeStopPayload({
      event: 'stop',
      last_assistant_message: 'All phases complete, PR merged.',
    });

    processEvent(payload, db, sse, undefined, sink);

    expect(sink.noteLastAssistantMessage).toHaveBeenCalledTimes(1);
    expect(sink.noteLastAssistantMessage).toHaveBeenCalledWith(
      42,
      'All phases complete, PR merged.',
    );
  });

  it('captures last_assistant_message on subagent_stop event from team-lead', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const sink = createMockSink();
    // SubagentStop fired by the TL (main agent has no agent_type, normalizes
    // to 'team-lead'). Mirrors what CC 2.1.46+ emits when a subagent finishes.
    const payload = makeStopPayload({
      event: 'subagent_stop',
      last_assistant_message: 'Subagent dev returned successfully.',
    });

    processEvent(payload, db, sse, undefined, sink);

    expect(sink.noteLastAssistantMessage).toHaveBeenCalledTimes(1);
    expect(sink.noteLastAssistantMessage).toHaveBeenCalledWith(
      42,
      'Subagent dev returned successfully.',
    );
  });

  it('captures last_assistant_message on stop_failure event from team-lead', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const sink = createMockSink();
    const payload = makeStopPayload({
      event: 'stop_failure',
      error_details: 'rate_limit',
      last_assistant_message: 'About to verify PR merge state.',
    });

    processEvent(payload, db, sse, undefined, sink);

    expect(sink.noteLastAssistantMessage).toHaveBeenCalledTimes(1);
    expect(sink.noteLastAssistantMessage).toHaveBeenCalledWith(
      42,
      'About to verify PR merge state.',
    );
  });

  // =============================================================================
  // Negative cases — capture is filtered out
  // =============================================================================

  it('does NOT capture from a non-team-lead agent (subagent stop attributed to dev)', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const sink = createMockSink();
    // SubagentStop attributed to a subagent (agent_type='fleet-dev' normalizes
    // to 'dev', not 'team-lead'). The cross-check only inspects the TL's
    // shutdown reason — subagent chatter must not shadow it.
    const payload = makeStopPayload({
      event: 'subagent_stop',
      agent_type: 'fleet-dev',
      last_assistant_message: 'Dev finished implementing the feature.',
    });

    processEvent(payload, db, sse, undefined, sink);

    expect(sink.noteLastAssistantMessage).not.toHaveBeenCalled();
  });

  it('does NOT capture from non-terminal events (tool_use)', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const sink = createMockSink();
    const payload: EventPayload = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      tool_name: 'Bash',
      last_assistant_message: 'Running the tests now.', // Present but should be ignored
    };

    processEvent(payload, db, sse, undefined, sink);

    expect(sink.noteLastAssistantMessage).not.toHaveBeenCalled();
  });

  it('does NOT capture when last_assistant_message is an empty string', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const sink = createMockSink();
    const payload = makeStopPayload({
      event: 'stop',
      last_assistant_message: '',
    });

    processEvent(payload, db, sse, undefined, sink);

    expect(sink.noteLastAssistantMessage).not.toHaveBeenCalled();
  });

  it('does NOT capture when last_assistant_message is missing', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const sink = createMockSink();
    // Stop event with no last_assistant_message field at all (older CC version).
    const payload: EventPayload = {
      event: 'stop',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
    };

    processEvent(payload, db, sse, undefined, sink);

    expect(sink.noteLastAssistantMessage).not.toHaveBeenCalled();
  });

  // =============================================================================
  // Sink absence and error handling
  // =============================================================================

  it('does not throw when sink is not provided', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload = makeStopPayload({
      event: 'stop',
      last_assistant_message: 'PR merged.',
    });

    // No sink argument — capture path should be a no-op.
    expect(() => processEvent(payload, db, sse)).not.toThrow();
    // Event still processed normally.
    expect(db.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'Stop' }),
    );
  });

  it('catches sink errors and logs a warning without breaking event processing', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const sink: LastAssistantMessageSink = {
      noteLastAssistantMessage: vi.fn().mockImplementation(() => {
        throw new Error('sink exploded');
      }),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const payload = makeStopPayload({
      event: 'stop',
      last_assistant_message: 'PR merged.',
    });

    // processEvent must NOT propagate sink errors.
    expect(() => processEvent(payload, db, sse, undefined, sink)).not.toThrow();

    expect(sink.noteLastAssistantMessage).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('noteLastAssistantMessage failed'),
    );
    // Event was still inserted (capture failure is non-critical).
    expect(db.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'Stop' }),
    );

    warnSpy.mockRestore();
  });

  // =============================================================================
  // Persistence — payload regression check
  // =============================================================================

  it('still persists last_assistant_message inside events.payload JSON (no regression)', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const sink = createMockSink();
    const payload = makeStopPayload({
      event: 'stop',
      last_assistant_message: 'PR #42 merged, issue closed.',
    });

    processEvent(payload, db, sse, undefined, sink);

    const insertCall = (db.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const storedPayload = JSON.parse(insertCall.payload) as { last_assistant_message?: string };
    expect(storedPayload.last_assistant_message).toBe('PR #42 merged, issue closed.');
  });
});
