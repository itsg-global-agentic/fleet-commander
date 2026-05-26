// =============================================================================
// Fleet Commander — Event Collector duration_ms capture tests
// =============================================================================
// Issue #732: CC 2.1.119+ emits `duration_ms` on PostToolUse / PostToolUseFailure
// hook input. EventCollector forwards this value to the DB layer via
// `eventInsert.durationMs` so the "slowest tool calls" panel can rank
// tool executions by execution time.
//
// Covers extraction (route builders), persistence (processEvent ->
// eventInsert.durationMs), defensive coercion (non-numeric / missing /
// NaN / Infinity), and DB-layer round-trip via getSlowestToolEvents.
// =============================================================================

import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

import {
  processEvent,
  resetThrottleState,
  resetSubagentTrackers,
  resetPrPollState,
  resetEventDedupState,
  type EventPayload,
  type EventCollectorDb,
  type SseBroker,
} from '../../../src/server/services/event-collector.js';
import {
  buildPayloadFromCcStdin,
  buildPayloadFromLegacy,
} from '../../../src/server/routes/events.js';
import { getDatabase, closeDatabase } from '../../../src/server/db.js';

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

  const processEventTransaction = vi.fn().mockImplementation(
    (ops: {
      transition?: { teamId: number; fromStatus: string; toStatus: string; trigger: string; reason: string };
      statusUpdate?: { teamId: number; fields: Record<string, unknown> };
      heartbeatUpdate: { teamId: number; lastEventAt: string };
      eventInsert: { teamId: number; sessionId: string | null; agentName: string | null; eventType: string; toolName?: string | null; payload: string; durationMs?: number | null };
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
    getTeamByWorktree: vi
      .fn()
      .mockReturnValue({ id: 7, status: 'running', phase: 'implementing' }),
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

// ---------------------------------------------------------------------------
// Reset state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetThrottleState();
  resetSubagentTrackers();
  resetPrPollState();
  resetEventDedupState();
});

// =============================================================================
// processEvent — persistence path
// =============================================================================

describe('EventCollector — duration_ms persistence (issue #732)', () => {
  it('records duration_ms on a PostToolUse (tool_use) payload', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload: EventPayload = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      session_id: 'sess-1',
      tool_name: 'Bash',
      duration_ms: 1234,
    };

    processEvent(payload, db, sse);

    expect(db.insertEvent).toHaveBeenCalledTimes(1);
    expect(db.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ToolUse',
        toolName: 'Bash',
        durationMs: 1234,
      }),
    );
  });

  it('records duration_ms on a PostToolUseFailure (tool_error) payload', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload: EventPayload = {
      event: 'tool_error',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      session_id: 'sess-1',
      tool_name: 'Bash',
      error: 'command failed',
      duration_ms: 9876,
    };

    processEvent(payload, db, sse);

    expect(db.insertEvent).toHaveBeenCalledTimes(1);
    expect(db.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ToolError',
        toolName: 'Bash',
        durationMs: 9876,
      }),
    );
  });

  it('records durationMs=null when duration_ms is missing from the payload', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload: EventPayload = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      session_id: 'sess-1',
      tool_name: 'Read',
      // duration_ms omitted (older CC versions, non-PostToolUse hooks)
    };

    processEvent(payload, db, sse);

    expect(db.insertEvent).toHaveBeenCalledTimes(1);
    expect(db.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ToolUse',
        durationMs: null,
      }),
    );
  });

  it('records durationMs=null when duration_ms is a non-finite number (NaN)', () => {
    const db = createMockDb();
    const sse = createMockSse();
    // NaN slips through the EventPayload number type but must be rejected
    // by the defensive coercion guard in processEvent.
    const payload: EventPayload = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      session_id: 'sess-1',
      tool_name: 'Bash',
      duration_ms: Number.NaN,
    };

    processEvent(payload, db, sse);

    expect(db.insertEvent).toHaveBeenCalledTimes(1);
    expect(db.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: null }),
    );
  });

  it('records durationMs=null when duration_ms is Infinity', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload: EventPayload = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      session_id: 'sess-1',
      tool_name: 'Bash',
      duration_ms: Number.POSITIVE_INFINITY,
    };

    processEvent(payload, db, sse);

    expect(db.insertEvent).toHaveBeenCalledTimes(1);
    expect(db.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: null }),
    );
  });

  it('records durationMs=null when duration_ms is a string (defensive coercion)', () => {
    const db = createMockDb();
    const sse = createMockSse();
    // The EventPayload interface declares `duration_ms?: number`, but we
    // simulate a path where the type contract was bypassed (e.g. a custom
    // hook shell forwards a string). processEvent must reject it.
    const payload = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      session_id: 'sess-1',
      tool_name: 'Bash',
      duration_ms: '1234',
    } as unknown as EventPayload;

    processEvent(payload, db, sse);

    expect(db.insertEvent).toHaveBeenCalledTimes(1);
    expect(db.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: null }),
    );
  });

  it('still persists duration_ms inside events.payload JSON for forensic replay', () => {
    const db = createMockDb();
    const sse = createMockSse();
    const payload: EventPayload = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      session_id: 'sess-1',
      tool_name: 'Bash',
      duration_ms: 555,
    };

    processEvent(payload, db, sse);

    const call = (db.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      payload: string;
    };
    const storedPayload = JSON.parse(call.payload) as { duration_ms?: number };
    expect(storedPayload.duration_ms).toBe(555);
  });
});

// =============================================================================
// Route builders — extraction path
// =============================================================================

describe('buildPayloadFromCcStdin — duration_ms extraction (issue #732)', () => {
  it('extracts duration_ms from raw CC stdin JSON', () => {
    const ccStdin = JSON.stringify({
      session_id: 'sess-1',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      duration_ms: 4321,
    });
    const body = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      cc_stdin: ccStdin,
    };

    const payload = buildPayloadFromCcStdin(body);

    expect(payload.duration_ms).toBe(4321);
  });

  it('returns undefined duration_ms when CC stdin omits the field', () => {
    const ccStdin = JSON.stringify({
      session_id: 'sess-1',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      // no duration_ms
    });
    const body = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      cc_stdin: ccStdin,
    };

    const payload = buildPayloadFromCcStdin(body);

    expect(payload.duration_ms).toBeUndefined();
  });

  it('returns undefined duration_ms when CC stdin field is a string', () => {
    const ccStdin = JSON.stringify({
      session_id: 'sess-1',
      tool_name: 'Bash',
      duration_ms: '4321', // wrong type
    });
    const body = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      cc_stdin: ccStdin,
    };

    const payload = buildPayloadFromCcStdin(body);

    expect(payload.duration_ms).toBeUndefined();
  });

  it('returns undefined duration_ms when CC stdin field is NaN', () => {
    // JSON cannot represent NaN. Test the equivalent path via Object.assign.
    const cc = {
      session_id: 'sess-1',
      tool_name: 'Bash',
      duration_ms: Number.NaN,
    };
    // Manually serialize: JSON.stringify replaces NaN with null, so we need to
    // hand-roll a string that parses back to NaN-equivalent. The simpler
    // assertion is via processEvent above; here we cover the type guard alone.
    const ccStdinWithNaN = JSON.stringify(cc).replace('null', 'NaN');
    // Verify our hand-rolled string actually contains NaN (defensive).
    expect(ccStdinWithNaN).toContain('NaN');
    const body = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      cc_stdin: ccStdinWithNaN,
    };

    const payload = buildPayloadFromCcStdin(body);

    // NaN literal is not valid JSON, so parsing should fail and the entire
    // CC field extraction should be skipped — duration_ms therefore stays
    // undefined.
    expect(payload.duration_ms).toBeUndefined();
  });
});

describe('buildPayloadFromLegacy — duration_ms extraction (issue #732)', () => {
  it('extracts duration_ms from a numeric body field', () => {
    const body = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      tool_name: 'Bash',
      duration_ms: 2500,
    };

    const payload = buildPayloadFromLegacy(body);

    expect(payload.duration_ms).toBe(2500);
  });

  it('extracts duration_ms from a stringified number (legacy shell forwarding)', () => {
    const body = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      tool_name: 'Bash',
      duration_ms: '3500',
    };

    const payload = buildPayloadFromLegacy(body);

    expect(payload.duration_ms).toBe(3500);
  });

  it('returns undefined duration_ms when body omits the field', () => {
    const body = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      tool_name: 'Bash',
    };

    const payload = buildPayloadFromLegacy(body);

    expect(payload.duration_ms).toBeUndefined();
  });

  it('returns undefined duration_ms when body field is non-numeric garbage', () => {
    const body = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      tool_name: 'Bash',
      duration_ms: 'not a number',
    };

    const payload = buildPayloadFromLegacy(body);

    expect(payload.duration_ms).toBeUndefined();
  });

  it('returns undefined duration_ms when body field is explicitly null', () => {
    const body = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      tool_name: 'Bash',
      duration_ms: null,
    };

    const payload = buildPayloadFromLegacy(body);

    expect(payload.duration_ms).toBeUndefined();
  });
});

// =============================================================================
// DB-layer round-trip — real SQLite instance
// =============================================================================

describe('Database — duration_ms persistence and getSlowestToolEvents (issue #732)', () => {
  let dbPath: string;
  let teamId: number;

  beforeAll(() => {
    dbPath = path.join(
      os.tmpdir(),
      `fleet-evt-duration-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );

    closeDatabase();
    process.env['FLEET_DB_PATH'] = dbPath;
    const db = getDatabase(dbPath);

    // Seed a single project and team — enough state for the events table FK.
    const project = db.insertProject({
      name: `evt-duration-project`,
      repoPath: `C:/fake/evt-duration-repo-${Date.now()}`,
    });
    const team = db.insertTeam({
      issueNumber: 732,
      worktreeName: `evt-duration-${Date.now()}`,
      status: 'running',
      phase: 'implementing',
      projectId: project.id,
      launchedAt: new Date().toISOString(),
    });
    teamId = team.id;
  });

  afterAll(() => {
    closeDatabase();

    for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        // best-effort cleanup
      }
    }

    delete process.env['FLEET_DB_PATH'];
  });

  it('persists durationMs through insertEvent and exposes it via mapEventRow', () => {
    const db = getDatabase();

    const evt = db.insertEvent({
      teamId,
      sessionId: 'sess-1',
      agentName: 'team-lead',
      eventType: 'ToolUse',
      toolName: 'Bash',
      payload: JSON.stringify({ tool_input: { command: 'echo hello' } }),
      durationMs: 1500,
    });

    expect(evt.durationMs).toBe(1500);
    expect(evt.toolName).toBe('Bash');
  });

  it('persists NULL durationMs when the field is omitted', () => {
    const db = getDatabase();

    const evt = db.insertEvent({
      teamId,
      sessionId: 'sess-1',
      agentName: 'team-lead',
      eventType: 'ToolUse',
      toolName: 'Read',
      payload: JSON.stringify({ tool_input: { file_path: '/tmp/x' } }),
      // durationMs omitted
    });

    expect(evt.durationMs).toBeNull();
  });

  it('persists NULL durationMs when the field is explicitly null', () => {
    const db = getDatabase();

    const evt = db.insertEvent({
      teamId,
      sessionId: 'sess-1',
      agentName: 'team-lead',
      eventType: 'ToolUse',
      toolName: 'Edit',
      payload: JSON.stringify({ tool_input: { file_path: '/tmp/x' } }),
      durationMs: null,
    });

    expect(evt.durationMs).toBeNull();
  });

  it('returns the top-N events sorted by durationMs DESC, excluding NULLs', () => {
    const db = getDatabase();

    // Insert a spread of events with mixed durations, including NULLs.
    const inserts = [
      { toolName: 'Bash', durationMs: 100 },
      { toolName: 'Bash', durationMs: 5000 },
      { toolName: 'Read', durationMs: null }, // excluded
      { toolName: 'Edit', durationMs: 2000 },
      { toolName: 'Bash', durationMs: 250 },
      { toolName: 'Grep', durationMs: 8000 },
      { toolName: 'Glob', durationMs: 50 },
      { toolName: 'Write', durationMs: null }, // excluded
    ];

    for (const e of inserts) {
      db.insertEvent({
        teamId,
        sessionId: 'sess-2',
        agentName: 'team-lead',
        eventType: 'ToolUse',
        toolName: e.toolName,
        payload: JSON.stringify({}),
        durationMs: e.durationMs,
      });
    }

    const slowest = db.getSlowestToolEvents(teamId, 5);

    expect(slowest).toHaveLength(5);
    // Sorted descending by durationMs; NULLs excluded.
    const durations = slowest.map((e) => e.durationMs);
    // Descending order check (allows for prior events from earlier tests
    // such as durationMs=1500 to also land in the top 5).
    for (let i = 0; i < durations.length - 1; i++) {
      const a = durations[i];
      const b = durations[i + 1];
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a as number).toBeGreaterThanOrEqual(b as number);
    }
    // Top entry must be the 8000ms Grep call.
    expect(slowest[0]!.durationMs).toBe(8000);
    expect(slowest[0]!.toolName).toBe('Grep');
    // No NULLs leaked into the result.
    expect(slowest.every((e) => e.durationMs !== null)).toBe(true);
  });

  it('returns an empty array when no team events have a recorded duration', () => {
    const db = getDatabase();
    // Insert a fresh team with only NULL-duration events.
    const project = db.insertProject({
      name: `evt-null-only-project`,
      repoPath: `C:/fake/evt-null-only-repo-${Date.now()}`,
    });
    const team = db.insertTeam({
      issueNumber: 9999,
      worktreeName: `evt-null-only-${Date.now()}`,
      status: 'running',
      phase: 'implementing',
      projectId: project.id,
      launchedAt: new Date().toISOString(),
    });

    db.insertEvent({
      teamId: team.id,
      sessionId: 'sess-null',
      agentName: 'team-lead',
      eventType: 'ToolUse',
      toolName: 'Read',
      payload: JSON.stringify({}),
      // durationMs omitted — stored as NULL
    });

    const slowest = db.getSlowestToolEvents(team.id, 5);
    expect(slowest).toEqual([]);
  });
});
