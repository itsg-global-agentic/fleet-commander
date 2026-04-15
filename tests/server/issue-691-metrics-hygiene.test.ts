// =============================================================================
// Fleet Commander — Issue #691 metrics hygiene tests
// =============================================================================
// Covers three independent fixes from issue #691:
//   A) durationMin uses started_at, not launched_at (queue-wait excluded)
//   B) Epic pre-flight: skip launch when all sub-issues already closed
//   C) Hook shutdown-event dedup
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FleetDatabase } from '../../src/server/db.js';
import {
  processEvent,
  resetEventDedupState,
  resetThrottleState,
  resetPrPollState,
  resetSubagentTrackers,
  type EventPayload,
  type EventCollectorDb,
  type SseBroker,
} from '../../src/server/services/event-collector.js';

// ---------------------------------------------------------------------------
// Shared DB helpers
// ---------------------------------------------------------------------------

let db: FleetDatabase;
let dbPath: string;

function createTempDb(): FleetDatabase {
  dbPath = path.join(
    os.tmpdir(),
    `fleet-691-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const database = new FleetDatabase(dbPath);
  database.initSchema();
  return database;
}

function cleanupDb(): void {
  try {
    db.close();
  } catch {
    // already closed
  }
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      // best effort
    }
  }
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

beforeEach(() => {
  db = createTempDb();
});

afterEach(() => {
  cleanupDb();
});

// =============================================================================
// Fix A — durationMin uses started_at, not launched_at
// =============================================================================

describe('Fix A: duration_min excludes queue-wait', () => {
  it('computes duration from started_at when populated (queue-wait excluded)', () => {
    // Team was queued 2 hours ago, started running 2 min ago, stopped now.
    // True run time ≈ 2 min — NOT 120 min.
    db.insertTeam({
      issueNumber: 691_001,
      worktreeName: 'proj-691-001',
      status: 'done',
      phase: 'done',
      launchedAt: minutesAgo(120),
    });
    db.updateTeam(1, {
      startedAt: minutesAgo(2),
      stoppedAt: new Date().toISOString(),
      lastEventAt: minutesAgo(1),
    });

    const rows = db.getTeamDashboard();
    expect(rows).toHaveLength(1);
    // Allow ±1 min rounding tolerance.
    expect(rows[0].durationMin).toBeGreaterThanOrEqual(1);
    expect(rows[0].durationMin).toBeLessThanOrEqual(3);
  });

  it('reports 0 minutes for teams still in queued status', () => {
    db.insertTeam({
      issueNumber: 691_002,
      worktreeName: 'proj-691-002',
      status: 'queued',
      phase: 'init',
      launchedAt: minutesAgo(60),
    });

    const rows = db.getTeamDashboard();
    expect(rows).toHaveLength(1);
    expect(rows[0].durationMin).toBe(0);
  });

  it('falls back to launched_at when started_at is NULL (legacy rows)', () => {
    // Legacy team: status=done, launched_at=30min ago, stopped_at=now,
    // started_at never populated.
    db.insertTeam({
      issueNumber: 691_003,
      worktreeName: 'proj-691-003',
      status: 'done',
      phase: 'done',
      launchedAt: minutesAgo(30),
    });
    db.updateTeam(1, {
      stoppedAt: new Date().toISOString(),
    });

    // Confirm started_at is still NULL
    const team = db.getTeam(1)!;
    expect(team.startedAt).toBeNull();

    const rows = db.getTeamDashboard();
    expect(rows).toHaveLength(1);
    expect(rows[0].durationMin).toBeGreaterThanOrEqual(29);
    expect(rows[0].durationMin).toBeLessThanOrEqual(31);
  });

  it('COALESCE prevents later heartbeats from overwriting started_at', () => {
    const first = minutesAgo(5);
    const later = minutesAgo(1);

    db.insertTeam({
      issueNumber: 691_004,
      worktreeName: 'proj-691-004',
      status: 'running',
      phase: 'implementing',
      launchedAt: minutesAgo(10),
    });

    // First set should take effect.
    db.updateTeam(1, { startedAt: first });
    expect(db.getTeam(1)!.startedAt).toBe(first);

    // Second set should be a no-op because of the COALESCE in updateTeamSilent.
    db.updateTeam(1, { startedAt: later });
    expect(db.getTeam(1)!.startedAt).toBe(first);
  });
});

// =============================================================================
// Fix C — Shutdown hook event dedup
// =============================================================================

function createMockDb(): EventCollectorDb {
  let nextEventId = 1;
  return {
    getTeamByWorktree: vi.fn().mockReturnValue({ id: 1, status: 'running', phase: 'implementing' }),
    insertEvent: vi.fn(() => ({ id: nextEventId++ })),
    updateTeam: vi.fn(),
    updateTeamSilent: vi.fn(),
    insertTransition: vi.fn(),
    insertAgentMessage: vi.fn(() => ({ id: 1 })),
    processEventTransaction: vi.fn(() => ({ eventId: nextEventId++ })),
    processThrottledUpdate: vi.fn(),
  };
}

function createMockSse(): SseBroker {
  return { broadcast: vi.fn() };
}

describe('Fix C: shutdown event dedup', () => {
  beforeEach(() => {
    resetEventDedupState();
    resetThrottleState();
    resetPrPollState();
    resetSubagentTrackers();
  });

  it('drops two identical shutdown events submitted within 200ms', () => {
    const mockDb = createMockDb();
    const sse = createMockSse();

    const payload: EventPayload = {
      event: 'stop',
      team: 'kea-100',
      timestamp: '2026-04-15T12:00:00.000Z',
      session_id: 'sess-abc',
      agent_type: 'coordinator',
    };

    const r1 = processEvent(payload, mockDb, sse);
    const r2 = processEvent(payload, mockDb, sse);

    expect(r1.processed).toBe(true);
    expect(r2.processed).toBe(false);

    // Only one row should have been inserted.
    expect(mockDb.processEventTransaction).toHaveBeenCalledTimes(1);
  });

  it('keeps two different shutdown events (distinct payloads)', () => {
    const mockDb = createMockDb();
    const sse = createMockSse();

    // Different session_ids → different payloads → different fingerprints.
    const p1: EventPayload = {
      event: 'stop',
      team: 'kea-100',
      timestamp: '2026-04-15T12:00:00.000Z',
      session_id: 'sess-a',
      agent_type: 'coordinator',
    };
    const p2: EventPayload = { ...p1, session_id: 'sess-b' };

    const r1 = processEvent(p1, mockDb, sse);
    const r2 = processEvent(p2, mockDb, sse);

    expect(r1.processed).toBe(true);
    expect(r2.processed).toBe(true);
    expect(mockDb.processEventTransaction).toHaveBeenCalledTimes(2);
  });

  it('does not dedup non-shutdown events (e.g. session_start)', () => {
    const mockDb = createMockDb();
    const sse = createMockSse();

    const payload: EventPayload = {
      event: 'session_start',
      team: 'kea-100',
      timestamp: '2026-04-15T12:00:00.000Z',
      session_id: 'sess-abc',
      agent_type: 'coordinator',
    };

    const r1 = processEvent(payload, mockDb, sse);
    const r2 = processEvent(payload, mockDb, sse);

    // session_start is outside the shutdown dedup scope — both go through.
    expect(r1.processed).toBe(true);
    expect(r2.processed).toBe(true);
  });
});
