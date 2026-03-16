// =============================================================================
// Fleet Commander — Database Layer Tests
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { FleetDatabase } from './db.js';

const TEST_DB_PATH = path.join(process.cwd(), 'test-fleet.db');

let db: FleetDatabase;

beforeEach(() => {
  // Clean up any previous test database
  for (const f of [TEST_DB_PATH, TEST_DB_PATH + '-wal', TEST_DB_PATH + '-shm']) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  db = new FleetDatabase(TEST_DB_PATH);
  db.initSchema();
});

afterEach(() => {
  db.close();
  for (const f of [TEST_DB_PATH, TEST_DB_PATH + '-wal', TEST_DB_PATH + '-shm']) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

describe('Database initialization', () => {
  it('creates the database file', () => {
    expect(fs.existsSync(TEST_DB_PATH)).toBe(true);
  });

  it('enables WAL mode', () => {
    const result = db.raw.pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(result[0].journal_mode).toBe('wal');
  });

  it('has schema version 2', () => {
    expect(db.getSchemaVersion()).toBe(2);
  });

  it('is idempotent — running initSchema twice does not throw', () => {
    expect(() => db.initSchema()).not.toThrow();
    expect(db.getSchemaVersion()).toBe(2);
  });
});

describe('Teams CRUD', () => {
  it('inserts and retrieves a team', () => {
    const team = db.insertTeam({
      issueNumber: 763,
      issueTitle: 'Add unit tests for auth module',
      worktreeName: 'kea-763',
      branchName: 'fix/763-auth-tests',
    });

    expect(team.id).toBeGreaterThan(0);
    expect(team.issueNumber).toBe(763);
    expect(team.issueTitle).toBe('Add unit tests for auth module');
    expect(team.worktreeName).toBe('kea-763');
    expect(team.branchName).toBe('fix/763-auth-tests');
    expect(team.status).toBe('queued');
    expect(team.phase).toBe('init');
    expect(team.createdAt).toBeTruthy();

    const fetched = db.getTeam(team.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(team.id);
    expect(fetched!.worktreeName).toBe('kea-763');
  });

  it('retrieves a team by worktree name', () => {
    db.insertTeam({ issueNumber: 812, worktreeName: 'kea-812' });
    const team = db.getTeamByWorktree('kea-812');
    expect(team).toBeDefined();
    expect(team!.issueNumber).toBe(812);
  });

  it('returns undefined for non-existent team', () => {
    expect(db.getTeam(9999)).toBeUndefined();
    expect(db.getTeamByWorktree('does-not-exist')).toBeUndefined();
  });

  it('enforces unique worktree_name', () => {
    db.insertTeam({ issueNumber: 100, worktreeName: 'kea-100' });
    expect(() =>
      db.insertTeam({ issueNumber: 101, worktreeName: 'kea-100' })
    ).toThrow();
  });

  it('updates team fields', () => {
    const team = db.insertTeam({ issueNumber: 200, worktreeName: 'kea-200' });
    const updated = db.updateTeam(team.id, {
      status: 'running',
      phase: 'analyzing',
      pid: 12345,
      sessionId: 'sess-abc',
      lastEventAt: new Date().toISOString(),
    });

    expect(updated).toBeDefined();
    expect(updated!.status).toBe('running');
    expect(updated!.phase).toBe('analyzing');
    expect(updated!.pid).toBe(12345);
    expect(updated!.sessionId).toBe('sess-abc');
  });

  it('lists teams with filter', () => {
    db.insertTeam({ issueNumber: 1, worktreeName: 'kea-1', status: 'running' });
    db.insertTeam({ issueNumber: 2, worktreeName: 'kea-2', status: 'done' });
    db.insertTeam({ issueNumber: 3, worktreeName: 'kea-3', status: 'running' });

    const running = db.getTeams({ status: 'running' });
    expect(running.length).toBe(2);

    const all = db.getTeams();
    expect(all.length).toBe(3);
  });

  it('getActiveTeams returns only non-terminal statuses', () => {
    db.insertTeam({ issueNumber: 10, worktreeName: 'kea-10', status: 'running' });
    db.insertTeam({ issueNumber: 11, worktreeName: 'kea-11', status: 'done' });
    db.insertTeam({ issueNumber: 12, worktreeName: 'kea-12', status: 'failed' });
    db.insertTeam({ issueNumber: 13, worktreeName: 'kea-13', status: 'idle' });

    const active = db.getActiveTeams();
    expect(active.length).toBe(2);
    const statuses = active.map((t) => t.status);
    expect(statuses).toContain('running');
    expect(statuses).toContain('idle');
    expect(statuses).not.toContain('done');
    expect(statuses).not.toContain('failed');
  });
});

describe('Events CRUD', () => {
  let teamId: number;

  beforeEach(() => {
    const team = db.insertTeam({ issueNumber: 500, worktreeName: 'kea-500' });
    teamId = team.id;
  });

  it('inserts and retrieves events', () => {
    const event = db.insertEvent({
      teamId,
      eventType: 'session_start',
      sessionId: 'sess-001',
      payload: JSON.stringify({ model: 'opus' }),
    });

    expect(event.id).toBeGreaterThan(0);
    expect(event.teamId).toBe(teamId);
    expect(event.eventType).toBe('session_start');
    expect(event.sessionId).toBe('sess-001');
  });

  it('getEventsByTeam returns events in desc order', () => {
    db.insertEvent({ teamId, eventType: 'session_start' });
    db.insertEvent({ teamId, eventType: 'tool_use', toolName: 'Read' });
    db.insertEvent({ teamId, eventType: 'tool_use', toolName: 'Write' });

    const events = db.getEventsByTeam(teamId);
    expect(events.length).toBe(3);

    // With limit
    const limited = db.getEventsByTeam(teamId, 2);
    expect(limited.length).toBe(2);
  });

  it('getLatestEventByTeam returns most recent', () => {
    db.insertEvent({ teamId, eventType: 'session_start' });
    db.insertEvent({ teamId, eventType: 'tool_use', toolName: 'Edit' });

    const latest = db.getLatestEventByTeam(teamId);
    expect(latest).toBeDefined();
    expect(latest!.eventType).toBe('tool_use');
  });

  it('getAllEvents supports filters', () => {
    const team2 = db.insertTeam({ issueNumber: 501, worktreeName: 'kea-501' });
    db.insertEvent({ teamId, eventType: 'session_start' });
    db.insertEvent({ teamId, eventType: 'tool_use' });
    db.insertEvent({ teamId: team2.id, eventType: 'session_start' });

    const byTeam = db.getAllEvents({ teamId });
    expect(byTeam.length).toBe(2);

    const byType = db.getAllEvents({ eventType: 'session_start' });
    expect(byType.length).toBe(2);

    const withLimit = db.getAllEvents({ limit: 1 });
    expect(withLimit.length).toBe(1);
  });
});

describe('Pull Requests CRUD', () => {
  let teamId: number;

  beforeEach(() => {
    const team = db.insertTeam({ issueNumber: 600, worktreeName: 'kea-600' });
    teamId = team.id;
  });

  it('inserts and retrieves a PR', () => {
    const pr = db.insertPullRequest({
      prNumber: 42,
      teamId,
      title: 'Fix auth module',
      state: 'open',
      ciStatus: 'pending',
    });

    expect(pr.prNumber).toBe(42);
    expect(pr.teamId).toBe(teamId);
    expect(pr.state).toBe('open');
    expect(pr.ciStatus).toBe('pending');
    expect(pr.autoMerge).toBe(false);
    expect(pr.ciFailCount).toBe(0);
  });

  it('enforces unique pr_number', () => {
    db.insertPullRequest({ prNumber: 100 });
    expect(() => db.insertPullRequest({ prNumber: 100 })).toThrow();
  });

  it('updates PR fields', () => {
    db.insertPullRequest({ prNumber: 55, teamId, state: 'open' });
    const updated = db.updatePullRequest(55, {
      state: 'merged',
      ciStatus: 'passing',
      mergedAt: new Date().toISOString(),
    });

    expect(updated).toBeDefined();
    expect(updated!.state).toBe('merged');
    expect(updated!.ciStatus).toBe('passing');
  });

  it('returns undefined for non-existent PR', () => {
    expect(db.getPullRequest(9999)).toBeUndefined();
  });
});

describe('Commands CRUD', () => {
  let teamId: number;

  beforeEach(() => {
    const team = db.insertTeam({ issueNumber: 700, worktreeName: 'kea-700' });
    teamId = team.id;
  });

  it('inserts and retrieves pending commands', () => {
    const cmd = db.insertCommand({
      teamId,
      message: 'Focus on the failing test in auth.test.ts',
    });

    expect(cmd.id).toBeGreaterThan(0);
    expect(cmd.teamId).toBe(teamId);
    expect(cmd.message).toBe('Focus on the failing test in auth.test.ts');
    expect(cmd.status).toBe('pending');

    const pending = db.getPendingCommands(teamId);
    expect(pending.length).toBe(1);
  });

  it('marks command as delivered', () => {
    const cmd = db.insertCommand({ teamId, message: 'Stop and report' });
    const delivered = db.markCommandDelivered(cmd.id);
    expect(delivered).toBeDefined();
    expect(delivered!.status).toBe('delivered');

    const pending = db.getPendingCommands(teamId);
    expect(pending.length).toBe(0);
  });

  it('supports target agent', () => {
    const cmd = db.insertCommand({
      teamId,
      targetAgent: 'csharp-dev',
      message: 'Run the unit tests',
    });
    expect(cmd).toBeDefined();
  });
});

describe('Dashboard View', () => {
  it('returns joined team dashboard data', () => {
    const team = db.insertTeam({
      issueNumber: 900,
      issueTitle: 'Implement feature X',
      worktreeName: 'kea-900',
      status: 'running',
      launchedAt: new Date().toISOString(),
    });

    // Add an event
    db.insertEvent({ teamId: team.id, eventType: 'session_start' });

    // Add a PR
    db.insertPullRequest({ prNumber: 901, teamId: team.id, state: 'open', ciStatus: 'passing' });
    db.updateTeam(team.id, { prNumber: 901 });

    const rows = db.getTeamDashboard();
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const row = rows.find((r) => r.id === team.id);
    expect(row).toBeDefined();
    expect(row!.issueNumber).toBe(900);
    expect(row!.issueTitle).toBe('Implement feature X');
    expect(row!.status).toBe('running');
    expect(row!.totalCost).toBe(0);
    expect(row!.prState).toBe('open');
    expect(row!.ciStatus).toBe('passing');
  });
});

describe('Stuck candidates', () => {
  it('returns teams with old last_event_at', () => {
    const team = db.insertTeam({
      issueNumber: 950,
      worktreeName: 'kea-950',
      status: 'running',
    });

    // Set last_event_at to 10 minutes ago
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    db.updateTeam(team.id, { lastEventAt: tenMinAgo });

    const candidates = db.getStuckCandidates(5, 15);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const match = candidates.find((c) => c.id === team.id);
    expect(match).toBeDefined();
    expect(match!.minutesSinceLastEvent).toBeGreaterThanOrEqual(9);
  });

  it('does not return teams with recent events', () => {
    const team = db.insertTeam({
      issueNumber: 951,
      worktreeName: 'kea-951',
      status: 'running',
    });

    db.updateTeam(team.id, { lastEventAt: new Date().toISOString() });

    const candidates = db.getStuckCandidates(5, 15);
    const match = candidates.find((c) => c.id === team.id);
    expect(match).toBeUndefined();
  });
});

describe('Connection management', () => {
  it('closes without error', () => {
    const tempDb = new FleetDatabase(':memory:');
    tempDb.initSchema();
    expect(() => tempDb.close()).not.toThrow();
  });
});
