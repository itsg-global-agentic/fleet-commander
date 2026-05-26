// =============================================================================
// Fleet Commander — Event Collector effort.level capture tests
// =============================================================================
// Issue #733: CC 2.1.133+ emits `effort.level` on every hook stdin payload.
// EventCollector diffs the value against the stored teams.effort row and
// writes + emits `effort_changed` only when it actually changes. No-op events
// (missing/invalid effort, same as stored) must NOT touch the DB or SSE.
//
// Covers:
//   - extraction via buildPayloadFromCcStdin (route layer)
//   - normalizeEffortLevel unit cases
//   - persistence path: diff against stored, write effort + emit SSE
//   - no-op cases: missing, invalid, same-as-stored
//   - first-event (previous_effort=null) emission
//   - throttled tool_use path still applies effort change
//   - sequential mid-session changes
//   - DB-layer round trip (real SQLite)
// =============================================================================

import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

import {
  processEvent,
  normalizeEffortLevel,
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

interface MockTeam {
  id: number;
  status: 'queued' | 'launching' | 'running' | 'idle' | 'stuck' | 'done' | 'failed';
  phase: string;
  effort: string | null;
}

function createMockDb(
  team: MockTeam = { id: 7, status: 'running', phase: 'implementing', effort: null },
  overrides?: Partial<EventCollectorDb>,
): EventCollectorDb {
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
    getTeamByWorktree: vi.fn().mockReturnValue(team),
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
// normalizeEffortLevel — unit cases
// =============================================================================

describe('normalizeEffortLevel', () => {
  it('accepts the 4 canonical CC levels lowercase', () => {
    expect(normalizeEffortLevel('low')).toBe('low');
    expect(normalizeEffortLevel('medium')).toBe('medium');
    expect(normalizeEffortLevel('high')).toBe('high');
    expect(normalizeEffortLevel('xhigh')).toBe('xhigh');
  });

  it('lowercases mixed-case input before validating', () => {
    expect(normalizeEffortLevel('HIGH')).toBe('high');
    expect(normalizeEffortLevel('XHigh')).toBe('xhigh');
    expect(normalizeEffortLevel('Medium')).toBe('medium');
  });

  it('trims surrounding whitespace before validating', () => {
    expect(normalizeEffortLevel('  high  ')).toBe('high');
    expect(normalizeEffortLevel('\thigh\n')).toBe('high');
  });

  it('returns null for the legacy "max" level (removed in CC 2.1.68)', () => {
    expect(normalizeEffortLevel('max')).toBeNull();
    expect(normalizeEffortLevel('MAX')).toBeNull();
  });

  it('returns null for unrecognized strings', () => {
    expect(normalizeEffortLevel('extreme')).toBeNull();
    expect(normalizeEffortLevel('huge')).toBeNull();
    expect(normalizeEffortLevel('default')).toBeNull();
  });

  it('returns null for missing/empty input', () => {
    expect(normalizeEffortLevel(undefined)).toBeNull();
    expect(normalizeEffortLevel(null)).toBeNull();
    expect(normalizeEffortLevel('')).toBeNull();
    expect(normalizeEffortLevel('   ')).toBeNull();
  });

  it('returns null for non-string input (defensive)', () => {
    // The type signature accepts string | undefined | null, but real-world
    // payloads may bypass the contract (e.g. malformed cc_stdin).
    expect(normalizeEffortLevel(42 as unknown as string)).toBeNull();
    expect(normalizeEffortLevel({} as unknown as string)).toBeNull();
    expect(normalizeEffortLevel([] as unknown as string)).toBeNull();
  });
});

// =============================================================================
// processEvent — effort write + SSE emit
// =============================================================================

describe('EventCollector — effort change detection (issue #733)', () => {
  it('writes effort and emits effort_changed when payload differs from stored', () => {
    const db = createMockDb({ id: 7, status: 'running', phase: 'implementing', effort: 'medium' });
    const sse = createMockSse();
    const payload: EventPayload = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      session_id: 'sess-1',
      tool_name: 'Bash',
      effort: 'high',
    };

    processEvent(payload, db, sse);

    // Verify the statusUpdate carried effort: 'high'
    const transactionMock = db.processEventTransaction as ReturnType<typeof vi.fn>;
    const ops = transactionMock.mock.calls[0]![0] as { statusUpdate?: { fields: Record<string, unknown> } };
    expect(ops.statusUpdate).toBeDefined();
    expect(ops.statusUpdate!.fields.effort).toBe('high');

    // Verify SSE broadcast
    expect(sse.broadcast).toHaveBeenCalledWith(
      'effort_changed',
      {
        team_id: 7,
        effort: 'high',
        previous_effort: 'medium',
      },
      7,
    );
  });

  it('emits previous_effort: null when stored effort was null (first observation)', () => {
    const db = createMockDb({ id: 7, status: 'running', phase: 'implementing', effort: null });
    const sse = createMockSse();
    const payload: EventPayload = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      session_id: 'sess-1',
      tool_name: 'Bash',
      effort: 'xhigh',
    };

    processEvent(payload, db, sse);

    expect(sse.broadcast).toHaveBeenCalledWith(
      'effort_changed',
      {
        team_id: 7,
        effort: 'xhigh',
        previous_effort: null,
      },
      7,
    );
  });

  it('does NOT write or emit when payload effort matches stored', () => {
    const db = createMockDb({ id: 7, status: 'running', phase: 'implementing', effort: 'high' });
    const sse = createMockSse();
    const payload: EventPayload = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      session_id: 'sess-1',
      tool_name: 'Bash',
      effort: 'high',
    };

    processEvent(payload, db, sse);

    // statusUpdate should be undefined (no fields to set besides the
    // status-machine fields which don't fire on a plain running->running
    // tool_use). Verify effort field never showed up.
    const transactionMock = db.processEventTransaction as ReturnType<typeof vi.fn>;
    const ops = transactionMock.mock.calls[0]![0] as { statusUpdate?: { fields: Record<string, unknown> } };
    if (ops.statusUpdate) {
      expect(ops.statusUpdate.fields.effort).toBeUndefined();
    }

    // No SSE broadcast for effort_changed
    const sseMock = sse.broadcast as ReturnType<typeof vi.fn>;
    const effortBroadcasts = sseMock.mock.calls.filter((c) => c[0] === 'effort_changed');
    expect(effortBroadcasts).toHaveLength(0);
  });

  it('does NOT write or emit when payload effort is missing', () => {
    const db = createMockDb({ id: 7, status: 'running', phase: 'implementing', effort: 'medium' });
    const sse = createMockSse();
    const payload: EventPayload = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      session_id: 'sess-1',
      tool_name: 'Bash',
      // effort omitted
    };

    processEvent(payload, db, sse);

    const transactionMock = db.processEventTransaction as ReturnType<typeof vi.fn>;
    const ops = transactionMock.mock.calls[0]![0] as { statusUpdate?: { fields: Record<string, unknown> } };
    if (ops.statusUpdate) {
      expect(ops.statusUpdate.fields.effort).toBeUndefined();
    }

    const sseMock = sse.broadcast as ReturnType<typeof vi.fn>;
    const effortBroadcasts = sseMock.mock.calls.filter((c) => c[0] === 'effort_changed');
    expect(effortBroadcasts).toHaveLength(0);
  });

  it('does NOT write or emit when payload effort is invalid', () => {
    const db = createMockDb({ id: 7, status: 'running', phase: 'implementing', effort: 'medium' });
    const sse = createMockSse();
    const payload: EventPayload = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      session_id: 'sess-1',
      tool_name: 'Bash',
      effort: 'extreme', // not in the canonical set
    };

    processEvent(payload, db, sse);

    const transactionMock = db.processEventTransaction as ReturnType<typeof vi.fn>;
    const ops = transactionMock.mock.calls[0]![0] as { statusUpdate?: { fields: Record<string, unknown> } };
    if (ops.statusUpdate) {
      expect(ops.statusUpdate.fields.effort).toBeUndefined();
    }

    const sseMock = sse.broadcast as ReturnType<typeof vi.fn>;
    const effortBroadcasts = sseMock.mock.calls.filter((c) => c[0] === 'effort_changed');
    expect(effortBroadcasts).toHaveLength(0);
  });

  it("rejects the legacy 'max' effort level (CC 2.1.68 removed it)", () => {
    const db = createMockDb({ id: 7, status: 'running', phase: 'implementing', effort: 'high' });
    const sse = createMockSse();
    const payload: EventPayload = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      session_id: 'sess-1',
      tool_name: 'Bash',
      effort: 'max',
    };

    processEvent(payload, db, sse);

    const transactionMock = db.processEventTransaction as ReturnType<typeof vi.fn>;
    const ops = transactionMock.mock.calls[0]![0] as { statusUpdate?: { fields: Record<string, unknown> } };
    if (ops.statusUpdate) {
      expect(ops.statusUpdate.fields.effort).toBeUndefined();
    }
    const sseMock = sse.broadcast as ReturnType<typeof vi.fn>;
    const effortBroadcasts = sseMock.mock.calls.filter((c) => c[0] === 'effort_changed');
    expect(effortBroadcasts).toHaveLength(0);
  });

  it('does NOT write or emit when team is terminal (done)', () => {
    const db = createMockDb({ id: 7, status: 'done', phase: 'done', effort: 'medium' });
    const sse = createMockSse();
    const payload: EventPayload = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      session_id: 'sess-1',
      tool_name: 'Bash',
      effort: 'high',
    };

    processEvent(payload, db, sse);

    const sseMock = sse.broadcast as ReturnType<typeof vi.fn>;
    const effortBroadcasts = sseMock.mock.calls.filter((c) => c[0] === 'effort_changed');
    expect(effortBroadcasts).toHaveLength(0);
  });

  it('applies effort change on the throttled tool_use path', () => {
    const db = createMockDb({ id: 7, status: 'running', phase: 'implementing', effort: 'low' });
    const sse = createMockSse();
    const basePayload: EventPayload = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      session_id: 'sess-1',
      tool_name: 'Bash',
    };

    // First event lands outside the throttle window — primes the timestamp.
    processEvent({ ...basePayload, effort: 'low' }, db, sse);
    // Clear broadcast history so we only see the second event's emissions.
    (sse.broadcast as ReturnType<typeof vi.fn>).mockClear();

    // Second event arrives immediately — inside the throttle window. Carries
    // a new effort. processThrottledUpdate (not processEventTransaction) must
    // commit the effort and SSE must still emit.
    processEvent({ ...basePayload, effort: 'xhigh' }, db, sse);

    // Verify the throttled path was hit (no insertEvent on the second call)
    // and the statusUpdate carried effort: 'xhigh'.
    const throttledMock = db.processThrottledUpdate as ReturnType<typeof vi.fn>;
    expect(throttledMock).toHaveBeenCalled();
    const throttledOps = throttledMock.mock.calls[0]![0] as { statusUpdate?: { fields: Record<string, unknown> } };
    expect(throttledOps.statusUpdate).toBeDefined();
    expect(throttledOps.statusUpdate!.fields.effort).toBe('xhigh');

    // SSE broadcast still fires
    expect(sse.broadcast).toHaveBeenCalledWith(
      'effort_changed',
      {
        team_id: 7,
        effort: 'xhigh',
        previous_effort: 'low',
      },
      7,
    );
  });

  it('handles two sequential mid-session changes correctly', () => {
    // Stored effort starts at 'low'. Two distinct events arrive carrying
    // 'medium' and then 'high'. Both should emit; payload2 must NOT see
    // payload1's previous_effort.
    const sse = createMockSse();

    // First call: stored=low -> medium
    const db1 = createMockDb({ id: 7, status: 'running', phase: 'implementing', effort: 'low' });
    processEvent(
      {
        event: 'subagent_start',
        team: 'proj-100',
        timestamp: new Date().toISOString(),
        session_id: 'sess-1',
        effort: 'medium',
      },
      db1,
      sse,
    );

    // Second call: stored=medium (mock updated) -> high
    const db2 = createMockDb({ id: 7, status: 'running', phase: 'implementing', effort: 'medium' });
    processEvent(
      {
        event: 'subagent_start',
        team: 'proj-100',
        timestamp: new Date().toISOString(),
        session_id: 'sess-1',
        effort: 'high',
      },
      db2,
      sse,
    );

    const sseMock = sse.broadcast as ReturnType<typeof vi.fn>;
    const effortBroadcasts = sseMock.mock.calls.filter((c) => c[0] === 'effort_changed');
    expect(effortBroadcasts).toHaveLength(2);
    // Both broadcasts must use the correct previous values.
    expect(effortBroadcasts[0]![1]).toMatchObject({ effort: 'medium', previous_effort: 'low' });
    expect(effortBroadcasts[1]![1]).toMatchObject({ effort: 'high', previous_effort: 'medium' });
  });
});

// =============================================================================
// Route builders — extraction path
// =============================================================================

describe('buildPayloadFromCcStdin — effort.level extraction (issue #733)', () => {
  it('extracts effort.level from a nested cc.effort object', () => {
    const ccStdin = JSON.stringify({
      session_id: 'sess-1',
      tool_name: 'Bash',
      effort: { level: 'xhigh', remaining_budget: 100 },
    });
    const body = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      cc_stdin: ccStdin,
    };

    const payload = buildPayloadFromCcStdin(body);

    expect(payload.effort).toBe('xhigh');
  });

  it('returns undefined effort when cc_stdin omits the field', () => {
    const ccStdin = JSON.stringify({
      session_id: 'sess-1',
      tool_name: 'Bash',
      // no effort
    });
    const body = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      cc_stdin: ccStdin,
    };

    const payload = buildPayloadFromCcStdin(body);

    expect(payload.effort).toBeUndefined();
  });

  it('returns undefined effort when cc.effort is a string instead of an object', () => {
    const ccStdin = JSON.stringify({
      session_id: 'sess-1',
      tool_name: 'Bash',
      effort: 'high', // wrong shape — should be { level: 'high' }
    });
    const body = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      cc_stdin: ccStdin,
    };

    const payload = buildPayloadFromCcStdin(body);

    expect(payload.effort).toBeUndefined();
  });

  it('returns undefined effort when cc.effort is an array', () => {
    const ccStdin = JSON.stringify({
      session_id: 'sess-1',
      tool_name: 'Bash',
      effort: ['high'], // arrays don't match the { level: string } shape
    });
    const body = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      cc_stdin: ccStdin,
    };

    const payload = buildPayloadFromCcStdin(body);

    expect(payload.effort).toBeUndefined();
  });

  it('returns undefined effort when cc.effort.level is not a string', () => {
    const ccStdin = JSON.stringify({
      session_id: 'sess-1',
      tool_name: 'Bash',
      effort: { level: 5 }, // wrong type — should be a string
    });
    const body = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      cc_stdin: ccStdin,
    };

    const payload = buildPayloadFromCcStdin(body);

    expect(payload.effort).toBeUndefined();
  });

  it('extracts effort.level alongside other CC fields without interference', () => {
    const ccStdin = JSON.stringify({
      session_id: 'sess-1',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      duration_ms: 1234,
      model: 'opus',
      effort: { level: 'high' },
    });
    const body = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      cc_stdin: ccStdin,
    };

    const payload = buildPayloadFromCcStdin(body);

    expect(payload.effort).toBe('high');
    expect(payload.duration_ms).toBe(1234);
    expect(payload.model).toBe('opus');
    expect(payload.tool_name).toBe('Bash');
  });

  it('replays a realistic cc_stdin payload carrying effort.level=xhigh', () => {
    // Sanity check: the canonical CC 2.1.133+ payload shape carrying every
    // field EventCollector touches alongside the new effort.level.
    const ccStdin = JSON.stringify({
      session_id: 'sess-abc',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
      duration_ms: 850,
      cwd: '/tmp/wt',
      worktree_path: '/tmp/wt',
      effort: { level: 'xhigh', remaining_budget: 42 },
    });
    const body = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      cc_stdin: ccStdin,
    };

    const payload = buildPayloadFromCcStdin(body);

    expect(payload.effort).toBe('xhigh');
  });
});

describe('buildPayloadFromLegacy — effort extraction (issue #733)', () => {
  it('extracts effort from a legacy body field', () => {
    const body = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      tool_name: 'Bash',
      effort: 'high',
    };

    const payload = buildPayloadFromLegacy(body);

    expect(payload.effort).toBe('high');
  });

  it('returns undefined effort when legacy body omits it', () => {
    const body = {
      event: 'tool_use',
      team: 'proj-100',
      timestamp: new Date().toISOString(),
      tool_name: 'Bash',
    };

    const payload = buildPayloadFromLegacy(body);

    expect(payload.effort).toBeUndefined();
  });
});

// =============================================================================
// DB-layer round-trip — real SQLite instance
// =============================================================================

describe('Database — teams.effort persistence and v_team_dashboard exposure (issue #733)', () => {
  let dbPath: string;
  let teamId: number;
  let projectId: number;

  beforeAll(() => {
    dbPath = path.join(
      os.tmpdir(),
      `fleet-evt-effort-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );

    closeDatabase();
    process.env['FLEET_DB_PATH'] = dbPath;
    const db = getDatabase(dbPath);

    // Project carries a spawn-time effort that the team inherits when not
    // overridden. Tests below verify both the inherited and overridden paths.
    const project = db.insertProject({
      name: `evt-effort-project`,
      repoPath: `C:/fake/evt-effort-repo-${Date.now()}`,
      effort: 'medium',
    });
    projectId = project.id;
    const team = db.insertTeam({
      issueNumber: 733,
      worktreeName: `evt-effort-${Date.now()}`,
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

  it('persists effort=NULL by default on a freshly inserted team', () => {
    const db = getDatabase();
    const team = db.getTeam(teamId);
    expect(team).toBeDefined();
    expect(team!.effort).toBeNull();
  });

  it('writes and reads back effort via updateTeam', () => {
    const db = getDatabase();
    db.updateTeam(teamId, { effort: 'high' });
    const team = db.getTeam(teamId);
    expect(team!.effort).toBe('high');
  });

  it('rejects invalid effort values via the CHECK constraint', () => {
    const db = getDatabase();
    // 'max' was removed in CC 2.1.68 and is now disallowed.
    expect(() => db.updateTeam(teamId, { effort: 'max' })).toThrow();
    // Unknown values are also rejected.
    expect(() => db.updateTeam(teamId, { effort: 'extreme' })).toThrow();
  });

  it('exposes effort and team_effort on v_team_dashboard with COALESCE fallback', () => {
    const db = getDatabase();

    // Set team to 'low' first; resolved effort should be 'low' (team wins).
    db.updateTeam(teamId, { effort: 'low' });
    let row = db.getTeamDashboard().find((r) => r.id === teamId);
    expect(row).toBeDefined();
    expect(row!.effort).toBe('low');
    expect(row!.effortInherited).toBe(false);

    // Clear the team effort; resolved should fall back to the project's
    // 'medium', and effortInherited should flip to true.
    db.updateTeam(teamId, { effort: null });
    row = db.getTeamDashboard().find((r) => r.id === teamId);
    expect(row!.effort).toBe('medium');
    expect(row!.effortInherited).toBe(true);
  });

  it('keeps projectId reachable for verification', () => {
    expect(projectId).toBeGreaterThan(0);
  });
});
