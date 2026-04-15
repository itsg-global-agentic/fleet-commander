// =============================================================================
// Fleet Commander — Duration fix for completed teams
// =============================================================================
// Verifies that completed (done/failed) teams use stopped_at rather than
// current time when computing duration_min and idle_min.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FleetDatabase } from '../../src/server/db.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: FleetDatabase;
let dbPath: string;

function createTempDb(): FleetDatabase {
  dbPath = path.join(os.tmpdir(), `fleet-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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
// v_team_dashboard — duration_min for completed teams
// =============================================================================

describe('v_team_dashboard duration_min for completed teams', () => {
  it('uses stopped_at for done teams instead of current time', () => {
    // Team launched 120 minutes ago, stopped 90 minutes ago => duration ~30 min
    const launchedAt = minutesAgo(120);
    const stoppedAt = minutesAgo(90);

    db.insertTeam({
      issueNumber: 200,
      worktreeName: 'proj-200',
      status: 'done',
      phase: 'done',
      launchedAt,
    });
    db.updateTeam(1, {
      stoppedAt,
      lastEventAt: minutesAgo(95),
    });

    const rows = db.getTeamDashboard();
    expect(rows).toHaveLength(1);

    const row = rows[0];
    // duration_min should be ~30 (launched 120 ago, stopped 90 ago)
    // NOT ~120 (which would happen if it used current time)
    expect(row.durationMin).toBeGreaterThanOrEqual(28);
    expect(row.durationMin).toBeLessThanOrEqual(32);
  });

  it('uses stopped_at for failed teams instead of current time', () => {
    // Team launched 60 minutes ago, stopped 50 minutes ago => duration ~10 min
    const launchedAt = minutesAgo(60);
    const stoppedAt = minutesAgo(50);

    db.insertTeam({
      issueNumber: 201,
      worktreeName: 'proj-201',
      status: 'failed',
      phase: 'implementing',
      launchedAt,
    });
    db.updateTeam(1, {
      stoppedAt,
      lastEventAt: minutesAgo(52),
    });

    const rows = db.getTeamDashboard();
    expect(rows).toHaveLength(1);

    const row = rows[0];
    // duration_min should be ~10 (launched 60 ago, stopped 50 ago)
    // NOT ~60 (which would happen if it used current time)
    expect(row.durationMin).toBeGreaterThanOrEqual(8);
    expect(row.durationMin).toBeLessThanOrEqual(12);
  });

  it('still uses current time for running teams (no stopped_at)', () => {
    // Team launched 30 minutes ago, still running
    const launchedAt = minutesAgo(30);

    db.insertTeam({
      issueNumber: 202,
      worktreeName: 'proj-202',
      status: 'running',
      phase: 'implementing',
      launchedAt,
    });
    db.updateTeam(1, {
      lastEventAt: minutesAgo(1),
    });

    const rows = db.getTeamDashboard();
    expect(rows).toHaveLength(1);

    const row = rows[0];
    // duration_min should be ~30 (launched 30 ago, no stopped_at => uses now)
    expect(row.durationMin).toBeGreaterThanOrEqual(28);
    expect(row.durationMin).toBeLessThanOrEqual(32);
  });
});

// =============================================================================
// v_team_dashboard — idle_min for completed teams
// =============================================================================

describe('v_team_dashboard idle_min for completed teams', () => {
  it('returns null idle_min for done teams (issue #690)', () => {
    // Terminal teams have no meaningful idleMin — lastEventAt can land
    // slightly after stoppedAt due to late finalization hooks, producing
    // negative values. The view reports null for done/failed.
    const launchedAt = minutesAgo(120);
    const lastEventAt = minutesAgo(100);
    const stoppedAt = minutesAgo(90);

    db.insertTeam({
      issueNumber: 300,
      worktreeName: 'proj-300',
      status: 'done',
      phase: 'done',
      launchedAt,
    });
    db.updateTeam(1, {
      stoppedAt,
      lastEventAt,
    });

    const rows = db.getTeamDashboard();
    expect(rows).toHaveLength(1);
    expect(rows[0].idleMin).toBeNull();
  });

  it('returns null idle_min for failed teams (issue #690)', () => {
    db.insertTeam({
      issueNumber: 301,
      worktreeName: 'proj-301',
      status: 'failed',
      phase: 'implementing',
      launchedAt: minutesAgo(60),
    });
    db.updateTeam(1, {
      stoppedAt: minutesAgo(50),
      lastEventAt: minutesAgo(52),
    });

    const rows = db.getTeamDashboard();
    expect(rows).toHaveLength(1);
    expect(rows[0].idleMin).toBeNull();
  });

  it('clamps idle_min to >= 0 for active teams with clock skew (issue #690)', () => {
    // Simulate clock skew: last_event_at slightly in the future relative to now
    db.insertTeam({
      issueNumber: 302,
      worktreeName: 'proj-302',
      status: 'running',
      phase: 'implementing',
      launchedAt: minutesAgo(5),
    });
    // lastEventAt 1 min in the future
    db.updateTeam(1, {
      lastEventAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const rows = db.getTeamDashboard();
    expect(rows).toHaveLength(1);
    // Clamped to 0, never negative
    expect(rows[0].idleMin).not.toBeNull();
    expect(rows[0].idleMin!).toBeGreaterThanOrEqual(0);
  });
});
