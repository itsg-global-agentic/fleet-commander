// =============================================================================
// Fleet Commander — Event Collector StopFailure Transition Tests (Issue #727)
// =============================================================================
//
// Tests for the `running -> failed-api` transition driven by the StopFailure
// Claude Code hook. Covers transient/fatal/unknown classification, retry
// suppression for fatal errors, payload truncation, terminal-state guards,
// and SSE broadcast behavior.
//
// The classifyStopFailure helper is also tested directly.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import config from '../../src/server/config.js';
import {
  processEvent,
  classifyStopFailure,
  resetThrottleState,
  resetSubagentTrackers,
  resetPrPollState,
  resetEventDedupState,
  type EventPayload,
  type EventCollectorDb,
  type SseBroker,
  type TeamMessageSender,
} from '../../src/server/services/event-collector.js';

// ---------------------------------------------------------------------------
// Mock factories (inlined from tests/server/event-collector.test.ts so this
// file is independently runnable. Keep in sync if the canonical helpers in the
// sibling file evolve.)
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
    event: 'stop_failure',
    team: 'kea-100',
    timestamp: new Date().toISOString(),
    session_id: 'sess-abc',
    agent_type: 'coordinator',
    ...overrides,
  };
}

function createMockMessageSender(): TeamMessageSender & { sendMessage: ReturnType<typeof vi.fn> } {
  return {
    sendMessage: vi.fn().mockReturnValue(true),
  };
}

beforeEach(() => {
  resetThrottleState();
  resetSubagentTrackers();
  resetPrPollState();
  resetEventDedupState();
});

// =============================================================================
// classifyStopFailure (direct unit tests)
// =============================================================================

describe('classifyStopFailure', () => {
  it('classifies rate_limit as transient', () => {
    expect(classifyStopFailure('rate_limit', undefined)).toBe('transient');
    expect(classifyStopFailure('rate limit exceeded', undefined)).toBe('transient');
  });

  it('classifies HTTP 5xx errors as transient', () => {
    expect(classifyStopFailure('server error 500', undefined)).toBe('transient');
    expect(classifyStopFailure('HTTP 502 bad gateway', undefined)).toBe('transient');
    expect(classifyStopFailure('503 service unavailable', undefined)).toBe('transient');
    expect(classifyStopFailure('504 gateway timeout', undefined)).toBe('transient');
  });

  it('classifies network errors as transient', () => {
    expect(classifyStopFailure('ECONNREFUSED', undefined)).toBe('transient');
    expect(classifyStopFailure('Network unreachable', undefined)).toBe('transient');
    expect(classifyStopFailure('ETIMEDOUT', undefined)).toBe('transient');
    expect(classifyStopFailure('ENOTFOUND api.example.com', undefined)).toBe('transient');
  });

  it('classifies overloaded as transient', () => {
    expect(classifyStopFailure('overloaded', undefined)).toBe('transient');
    expect(classifyStopFailure('temporarily unavailable', undefined)).toBe('transient');
  });

  it('classifies auth errors as fatal', () => {
    expect(classifyStopFailure('Authentication failed', undefined)).toBe('fatal');
    expect(classifyStopFailure('401 Unauthorized', undefined)).toBe('fatal');
    expect(classifyStopFailure('403 Forbidden', undefined)).toBe('fatal');
    expect(classifyStopFailure('Invalid API key', undefined)).toBe('fatal');
    expect(classifyStopFailure('Permission denied', undefined)).toBe('fatal');
  });

  it('classifies unknown strings as unknown', () => {
    expect(classifyStopFailure('something weird happened', undefined)).toBe('unknown');
    expect(classifyStopFailure('xyzzy', undefined)).toBe('unknown');
  });

  it('returns unknown when both error_details and error are empty/missing', () => {
    expect(classifyStopFailure(undefined, undefined)).toBe('unknown');
    expect(classifyStopFailure('', '')).toBe('unknown');
    expect(classifyStopFailure(undefined, '')).toBe('unknown');
  });

  it('falls back to error string when error_details is missing', () => {
    expect(classifyStopFailure(undefined, 'rate_limit')).toBe('transient');
    expect(classifyStopFailure(undefined, '401 Unauthorized')).toBe('fatal');
  });

  it('is case-insensitive', () => {
    expect(classifyStopFailure('RATE_LIMIT', undefined)).toBe('transient');
    expect(classifyStopFailure('Auth', undefined)).toBe('fatal');
    expect(classifyStopFailure('SERVER ERROR', undefined)).toBe('transient');
  });

  it('prefers fatal over transient when both substrings present', () => {
    // 'auth' takes precedence — fatal trumps transient in the iteration order.
    expect(classifyStopFailure('auth rate_limit', undefined)).toBe('fatal');
  });
});

// =============================================================================
// stop_failure -> failed transition
// =============================================================================

describe('stop_failure transition (Issue #727)', () => {
  it('transitions running -> failed on stop_failure with rate_limit (transient)', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'running', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ error_details: 'rate_limit exceeded' });

    processEvent(payload, db, sse);

    // Status update to failed with stoppedAt and pid cleared
    const failedUpdate = (db.updateTeam as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => (call[1] as Record<string, unknown>).status === 'failed',
    );
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate![1]).toMatchObject({
      status: 'failed',
      stoppedAt: expect.any(String),
      pid: null,
    });
    // retryCount must NOT be set for transient classification
    expect(failedUpdate![1]).not.toHaveProperty('retryCount');

    // Transition row
    expect(db.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        fromStatus: 'running',
        toStatus: 'failed',
        trigger: 'hook',
        reason: expect.stringContaining('transient'),
      }),
    );
    // No [no-retry] tag for transient
    const transitionCall = (db.insertTransition as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(transitionCall.reason).not.toContain('[no-retry]');
  });

  it('transitions running -> failed on stop_failure with auth error (fatal)', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'running', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ error_details: '401 Unauthorized — invalid API key' });

    processEvent(payload, db, sse);

    // Fatal classification: retryCount set to config.retryMaxCount
    const failedUpdate = (db.updateTeam as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => (call[1] as Record<string, unknown>).status === 'failed',
    );
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate![1]).toMatchObject({
      status: 'failed',
      stoppedAt: expect.any(String),
      pid: null,
      retryCount: config.retryMaxCount,
    });

    // Reason carries (fatal) and [no-retry]
    expect(db.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        toStatus: 'failed',
        trigger: 'hook',
        reason: expect.stringContaining('(fatal) [no-retry]'),
      }),
    );
  });

  it('transitions idle -> failed on stop_failure', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'idle', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ error_details: 'rate_limit' });

    processEvent(payload, db, sse);

    expect(db.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        fromStatus: 'idle',
        toStatus: 'failed',
        trigger: 'hook',
      }),
    );
    expect(db.updateTeam).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('transitions stuck -> failed on stop_failure', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'stuck', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ error_details: 'rate_limit' });

    processEvent(payload, db, sse);

    expect(db.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        fromStatus: 'stuck',
        toStatus: 'failed',
        trigger: 'hook',
      }),
    );
    expect(db.updateTeam).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('does NOT transition team already in failed state, but still inserts event', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'failed', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ error_details: 'rate_limit' });

    processEvent(payload, db, sse);

    // No transition recorded
    expect(db.insertTransition).not.toHaveBeenCalled();
    // No status updates beyond heartbeat
    const statusCalls = (db.updateTeam as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).status !== undefined,
    );
    expect(statusCalls).toHaveLength(0);
    // But the event itself IS inserted (for forensic visibility)
    expect(db.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'StopFailure' }),
    );
  });

  it('does NOT transition team already in done state, but still inserts event', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'done', phase: 'pr' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ error_details: 'rate_limit' });

    processEvent(payload, db, sse);

    expect(db.insertTransition).not.toHaveBeenCalled();
    const statusCalls = (db.updateTeam as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).status !== undefined,
    );
    expect(statusCalls).toHaveLength(0);
    expect(db.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'StopFailure' }),
    );
  });

  it('falls back to error field when error_details is missing', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'running', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload: EventPayload = {
      event: 'stop_failure',
      team: 'kea-100',
      error: 'API rate limit exceeded',
    };

    processEvent(payload, db, sse);

    // Should still transition to failed, reason should reference rate limit text and classify as transient
    expect(db.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        toStatus: 'failed',
        reason: expect.stringContaining('API rate limit exceeded'),
      }),
    );
    const transitionCall = (db.insertTransition as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(transitionCall.reason).toContain('(transient)');
  });

  it('classifies unknown error strings as unknown but still transitions, no retry suppression', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'running', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ error_details: 'something weird happened' });

    processEvent(payload, db, sse);

    // Transition still fires
    expect(db.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        toStatus: 'failed',
        reason: expect.stringContaining('(unknown)'),
      }),
    );
    // retryCount NOT set for unknown classification
    const failedUpdate = (db.updateTeam as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => (call[1] as Record<string, unknown>).status === 'failed',
    );
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate![1]).not.toHaveProperty('retryCount');
    // No [no-retry] tag for unknown
    const transitionCall = (db.insertTransition as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(transitionCall.reason).not.toContain('[no-retry]');
  });

  it('broadcasts team_stopped SSE event when transitioning to failed', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'running', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ error_details: 'rate_limit' });

    processEvent(payload, db, sse);

    expect(sse.broadcast).toHaveBeenCalledWith(
      'team_stopped',
      { team_id: 1 },
      1,
    );
  });

  it('broadcasts team_status_changed SSE event with correct previous_status', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'running', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ error_details: 'rate_limit' });

    processEvent(payload, db, sse);

    expect(sse.broadcast).toHaveBeenCalledWith(
      'team_status_changed',
      expect.objectContaining({
        team_id: 1,
        status: 'failed',
        previous_status: 'running',
      }),
      1,
    );
  });

  it('inserts StopFailure event with full payload JSON regardless of transition', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'running', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload = makePayload({
      error_details: 'rate_limit',
      last_assistant_message: 'About to run tests when API failed',
    });

    processEvent(payload, db, sse);

    expect(db.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'StopFailure' }),
    );
    const insertCall = (db.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const storedPayload = JSON.parse(insertCall.payload);
    expect(storedPayload.error_details).toBe('rate_limit');
    expect(storedPayload.last_assistant_message).toBe('About to run tests when API failed');
  });

  it('transitions on stop_failure even when both error_details and error are missing', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'running', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const payload: EventPayload = {
      event: 'stop_failure',
      team: 'kea-100',
    };

    processEvent(payload, db, sse);

    // Transition fires with "unknown error" detail and unknown classification
    expect(db.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        toStatus: 'failed',
        reason: expect.stringContaining('unknown error'),
      }),
    );
    const transitionCall = (db.insertTransition as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(transitionCall.reason).toContain('(unknown)');
    expect(transitionCall.reason).not.toContain('[no-retry]');
  });

  it('truncates error_details longer than 500 characters in reason', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'running', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const longDetail = 'x'.repeat(800);
    const payload = makePayload({ error_details: longDetail });

    processEvent(payload, db, sse);

    const transitionCall = (db.insertTransition as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Reason format: "StopFailure: <detail>  (<class>)<tag>" — the detail portion
    // must be capped at 500 chars. We assert the count of 'x' characters in the
    // reason is exactly 500.
    const xCount = (transitionCall.reason.match(/x/g) || []).length;
    expect(xCount).toBe(500);
  });

  it('transitions launching -> failed on stop_failure (records actual fromStatus)', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'launching', phase: 'init' }),
    });
    const sse = createMockSse();
    const payload = makePayload({ error_details: 'rate_limit' });

    processEvent(payload, db, sse);

    // launching -> failed: actual fromStatus is recorded even though canonical
    // state-machine entry shows 'running' as the from.
    expect(db.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        fromStatus: 'launching',
        toStatus: 'failed',
        trigger: 'hook',
      }),
    );
  });

  it('does not invoke messageSender for stop_failure events', () => {
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'running', phase: 'implementing' }),
    });
    const sse = createMockSse();
    const messageSender = createMockMessageSender();
    const payload = makePayload({ error_details: 'rate_limit' });

    processEvent(payload, db, sse, messageSender);

    // stop_failure should not directly trigger any message send (PR poll
    // warning or crash detection paths require different event types).
    expect(messageSender.sendMessage).not.toHaveBeenCalled();
  });
});
