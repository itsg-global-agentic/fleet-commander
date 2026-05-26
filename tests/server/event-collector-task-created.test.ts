// =============================================================================
// Fleet Commander — Event Collector: TaskCreated Hook Tests (Issue #728)
// =============================================================================
// Focused tests for the TaskCreated hook handler in event-collector.ts.
// Covers CC 2.1.143+ native fields (`owner`, `agent_id`), owner priority chain,
// dedup recording, terminal-state cleanup, and edge cases.

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
} from '../../src/server/services/event-collector.js';
import {
  recordHookTaskId,
  wasTaskSeenByHook,
  clearHookTaskIdsForTeam,
  resetTaskDedupState,
} from '../../src/server/services/task-dedup.js';

// ---------------------------------------------------------------------------
// Mock factories (mirrors event-collector.test.ts conventions)
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
      if (ops.transition) insertTransition(ops.transition);
      if (ops.statusUpdate) updateTeam(ops.statusUpdate.teamId, ops.statusUpdate.fields);
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
      if (ops.transition) insertTransition(ops.transition);
      if (ops.statusUpdate) updateTeam(ops.statusUpdate.teamId, ops.statusUpdate.fields);
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
  return { broadcast: vi.fn() };
}

function makePayload(overrides?: Partial<EventPayload>): EventPayload {
  return {
    event: 'task_created',
    team: 'kea-100',
    timestamp: new Date().toISOString(),
    session_id: 'sess-abc',
    ...overrides,
  };
}

// Default upsertTeamTask that echoes its input fields. The handler reads
// `task.taskId`, `task.subject`, `task.status`, `task.owner` from the return
// value when broadcasting the SSE, so the mock must mirror the input.
function makeUpsertTeamTask() {
  return vi.fn().mockImplementation((data: {
    teamId: number;
    taskId: string;
    subject: string;
    description?: string | null;
    status: string;
    owner: string;
  }) => ({
    id: 1,
    teamId: data.teamId,
    taskId: data.taskId,
    subject: data.subject,
    status: data.status,
    owner: data.owner,
  }));
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetThrottleState();
  resetSubagentTrackers();
  resetPrPollState();
  resetEventDedupState();
  resetTaskDedupState();
});

// =============================================================================
// TaskCreated hook handler
// =============================================================================

describe('TaskCreated hook handler', () => {
  it('processes TaskCreated hook with full CC 2.1.143 payload', () => {
    const upsertTeamTask = makeUpsertTeamTask();
    const db = createMockDb({ upsertTeamTask });
    const sse = createMockSse();

    const payload = makePayload({
      cc_stdin: JSON.stringify({
        task_id: 'task-abc',
        subject: 'Implement the foo widget',
        description: 'Build foo and wire it up to bar',
        status: 'in_progress',
        owner: 'planner',
        agent_id: 'fleet-planner',
      }),
    });

    processEvent(payload, db, sse);

    expect(upsertTeamTask).toHaveBeenCalledTimes(1);
    expect(upsertTeamTask).toHaveBeenCalledWith({
      teamId: 1,
      taskId: 'task-abc',
      subject: 'Implement the foo widget',
      description: 'Build foo and wire it up to bar',
      status: 'in_progress',
      owner: 'planner',
    });

    const taskBroadcasts = (sse.broadcast as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => call[0] === 'task_updated',
    );
    expect(taskBroadcasts).toHaveLength(1);
    expect(taskBroadcasts[0][1]).toMatchObject({
      team_id: 1,
      task_id: 'task-abc',
      subject: 'Implement the foo widget',
      status: 'in_progress',
      owner: 'planner',
    });
  });

  it('attributes task to subagent when agent_id is set and owner is absent', () => {
    const upsertTeamTask = makeUpsertTeamTask();
    const db = createMockDb({ upsertTeamTask });
    const sse = createMockSse();

    const payload = makePayload({
      cc_stdin: JSON.stringify({
        task_id: 'task-1',
        subject: 'A task',
        status: 'pending',
        agent_id: 'fleet-dev',
      }),
    });
    // Simulate buildPayloadFromCcStdin extracting agent_id
    payload.agent_id = 'fleet-dev';

    processEvent(payload, db, sse);

    expect(upsertTeamTask).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'dev' }),
    );
  });

  it('attributes task to team-lead when neither owner nor agent_id is set', () => {
    const upsertTeamTask = makeUpsertTeamTask();
    const db = createMockDb({ upsertTeamTask });
    const sse = createMockSse();

    const payload = makePayload({
      cc_stdin: JSON.stringify({
        task_id: 'task-1',
        subject: 'A task',
        status: 'pending',
      }),
    });
    // agent_type intentionally not set (TL emits with no agent_type)

    processEvent(payload, db, sse);

    expect(upsertTeamTask).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'team-lead' }),
    );
  });

  it('prefers owner over agent_id when both present', () => {
    const upsertTeamTask = makeUpsertTeamTask();
    const db = createMockDb({ upsertTeamTask });
    const sse = createMockSse();

    const payload = makePayload({
      cc_stdin: JSON.stringify({
        task_id: 'task-1',
        subject: 'A task',
        status: 'pending',
        owner: 'planner',
        agent_id: 'fleet-dev',
      }),
    });
    payload.owner = 'planner';
    payload.agent_id = 'fleet-dev';

    processEvent(payload, db, sse);

    expect(upsertTeamTask).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'planner' }),
    );
  });

  it('records taskId in hook dedup set after successful upsert', () => {
    const upsertTeamTask = makeUpsertTeamTask();
    const db = createMockDb({ upsertTeamTask });
    const sse = createMockSse();

    const payload = makePayload({
      cc_stdin: JSON.stringify({
        task_id: 'task-xyz',
        subject: 'Hooked task',
        status: 'pending',
      }),
    });

    processEvent(payload, db, sse);

    expect(wasTaskSeenByHook(1, 'task-xyz')).toBe(true);
  });

  it('does NOT record taskId when upsertTeamTask is missing on db', () => {
    const db = createMockDb();
    // Simulate older db without upsertTeamTask
    delete (db as Record<string, unknown>).upsertTeamTask;
    const sse = createMockSse();

    const payload = makePayload({
      cc_stdin: JSON.stringify({
        task_id: 'task-no-upsert',
        subject: 'A task',
        status: 'pending',
      }),
    });

    processEvent(payload, db, sse);

    expect(wasTaskSeenByHook(1, 'task-no-upsert')).toBe(false);
  });

  it('clears dedup set when team enters terminal state', () => {
    // Pre-seed dedup state for team 1
    recordHookTaskId(1, 'task-old');
    expect(wasTaskSeenByHook(1, 'task-old')).toBe(true);

    // Process any event for a team that is now in terminal status.
    // The terminal-state cleanup path runs `clearHookTaskIdsForTeam(teamId)`.
    const db = createMockDb({
      getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'done', phase: 'done' }),
    });
    const sse = createMockSse();

    const payload = makePayload({ event: 'stop' });
    processEvent(payload, db, sse);

    expect(wasTaskSeenByHook(1, 'task-old')).toBe(false);
  });

  it('handles malformed cc_stdin gracefully with content-based stable taskId', () => {
    const upsertTeamTask = makeUpsertTeamTask();
    const db = createMockDb({ upsertTeamTask });
    const sse = createMockSse();

    const payload = makePayload({
      cc_stdin: 'not valid json{{{',
      message: 'Some subject',
    });

    const result = processEvent(payload, db, sse);
    expect(result.processed).toBe(true);

    expect(upsertTeamTask).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        taskId: 'task-1-some-subject',
        subject: 'Some subject',
        // Description must NOT echo the payload.message — subject already
        // came from it, so description stays null.
        description: null,
        status: 'pending',
      }),
    );
  });

  it('falls back to ccData.description when subject came from cc_stdin', () => {
    const upsertTeamTask = makeUpsertTeamTask();
    const db = createMockDb({ upsertTeamTask });
    const sse = createMockSse();

    const payload = makePayload({
      cc_stdin: JSON.stringify({
        task_id: 'task-1',
        subject: 'A',
        description: 'B',
        status: 'pending',
      }),
    });

    processEvent(payload, db, sse);

    expect(upsertTeamTask).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'A',
        description: 'B',
      }),
    );
  });

  it('produces stable taskId across compaction events with same subject', () => {
    const upsertTeamTask = makeUpsertTeamTask();
    const db = createMockDb({ upsertTeamTask });
    const sse = createMockSse();

    // Two events: same subject, different tool_use_ids (post-compaction).
    // Both should derive identical taskId from subject content.
    const payload1 = makePayload({
      cc_stdin: 'malformed{{{',
      message: 'Implement login page',
      tool_use_id: 'toolu_abc',
    });
    const payload2 = makePayload({
      cc_stdin: 'malformed{{{',
      message: 'Implement login page',
      tool_use_id: 'toolu_def',
    });

    processEvent(payload1, db, sse);
    processEvent(payload2, db, sse);

    expect(upsertTeamTask.mock.calls[0][0].taskId).toBe('task-1-implement-login-page');
    expect(upsertTeamTask.mock.calls[1][0].taskId).toBe('task-1-implement-login-page');
  });

  it('normalizes raw agent_type owner via normalizeAgentName', () => {
    // No cc_stdin owner/agent_id — falls through to payload.agent_type.
    // payload.agent_type='fleet-reviewer' should become owner='reviewer'.
    const upsertTeamTask = makeUpsertTeamTask();
    const db = createMockDb({ upsertTeamTask });
    const sse = createMockSse();

    const payload = makePayload({
      agent_type: 'fleet-reviewer',
      cc_stdin: JSON.stringify({
        task_id: 'task-1',
        subject: 'A task',
        status: 'pending',
      }),
    });

    processEvent(payload, db, sse);

    expect(upsertTeamTask).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'reviewer' }),
    );
  });
});

// =============================================================================
// task-dedup module
// =============================================================================

describe('task-dedup module', () => {
  it('recordHookTaskId then wasTaskSeenByHook returns true', () => {
    recordHookTaskId(42, 'task-foo');
    expect(wasTaskSeenByHook(42, 'task-foo')).toBe(true);
  });

  it('wasTaskSeenByHook returns false for unknown team', () => {
    expect(wasTaskSeenByHook(999, 'task-foo')).toBe(false);
  });

  it('wasTaskSeenByHook returns false for unknown taskId on known team', () => {
    recordHookTaskId(42, 'task-foo');
    expect(wasTaskSeenByHook(42, 'task-bar')).toBe(false);
  });

  it('clearHookTaskIdsForTeam removes only that team', () => {
    recordHookTaskId(1, 'task-1');
    recordHookTaskId(2, 'task-2');
    clearHookTaskIdsForTeam(1);
    expect(wasTaskSeenByHook(1, 'task-1')).toBe(false);
    expect(wasTaskSeenByHook(2, 'task-2')).toBe(true);
  });

  it('caps each team set at 256 entries', () => {
    // Insert 300 ids — older ones should be evicted.
    for (let i = 0; i < 300; i++) {
      recordHookTaskId(1, `task-${i}`);
    }
    // First 44 (300-256) should be evicted.
    expect(wasTaskSeenByHook(1, 'task-0')).toBe(false);
    expect(wasTaskSeenByHook(1, 'task-43')).toBe(false);
    // Last 256 should be retained.
    expect(wasTaskSeenByHook(1, 'task-44')).toBe(true);
    expect(wasTaskSeenByHook(1, 'task-299')).toBe(true);
  });

  it('resetTaskDedupState clears all teams', () => {
    recordHookTaskId(1, 'task-1');
    recordHookTaskId(2, 'task-2');
    resetTaskDedupState();
    expect(wasTaskSeenByHook(1, 'task-1')).toBe(false);
    expect(wasTaskSeenByHook(2, 'task-2')).toBe(false);
  });
});
