// =============================================================================
// Fleet Commander — Database Layer Tests
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
// Schema creation
// =============================================================================

describe('Schema', () => {
  it('creates all tables on fresh DB', () => {
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const names = tables.map((t) => t.name);
    expect(names).toContain('teams');
    expect(names).toContain('events');
    expect(names).toContain('pull_requests');
    expect(names).toContain('commands');
    expect(names).toContain('cost_entries');
    expect(names).toContain('schema_version');
  });

  it('creates v_team_dashboard view', () => {
    const views = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='view'")
      .all() as { name: string }[];

    const names = views.map((v) => v.name);
    expect(names).toContain('v_team_dashboard');
  });

  it('is idempotent (can run initSchema twice)', () => {
    expect(() => db.initSchema()).not.toThrow();
  });

  it('sets schema version to 1', () => {
    expect(db.getSchemaVersion()).toBe(1);
  });
});

// =============================================================================
// Teams CRUD
// =============================================================================

describe('Teams CRUD', () => {
  it('inserts a team with defaults', () => {
    const team = db.insertTeam({
      issueNumber: 100,
      worktreeName: 'kea-100',
    });

    expect(team.id).toBe(1);
    expect(team.issueNumber).toBe(100);
    expect(team.worktreeName).toBe('kea-100');
    expect(team.status).toBe('queued');
    expect(team.phase).toBe('init');
    expect(team.pid).toBeNull();
    expect(team.sessionId).toBeNull();
    expect(team.prNumber).toBeNull();
    expect(team.createdAt).toBeTruthy();
  });

  it('inserts a team with all fields', () => {
    const team = db.insertTeam({
      issueNumber: 200,
      worktreeName: 'kea-200',
      issueTitle: 'Fix the thing',
      branchName: 'fix/thing',
      status: 'launching',
      phase: 'analyzing',
      pid: 12345,
      sessionId: 'sess-abc',
      prNumber: 42,
      launchedAt: '2025-01-01T00:00:00.000Z',
    });

    expect(team.issueNumber).toBe(200);
    expect(team.issueTitle).toBe('Fix the thing');
    expect(team.branchName).toBe('fix/thing');
    expect(team.status).toBe('launching');
    expect(team.phase).toBe('analyzing');
    expect(team.pid).toBe(12345);
    expect(team.sessionId).toBe('sess-abc');
    expect(team.prNumber).toBe(42);
    expect(team.launchedAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('gets a team by id', () => {
    db.insertTeam({ issueNumber: 100, worktreeName: 'kea-100' });
    const team = db.getTeam(1);

    expect(team).toBeDefined();
    expect(team!.worktreeName).toBe('kea-100');
  });

  it('returns undefined for nonexistent team id', () => {
    const team = db.getTeam(999);
    expect(team).toBeUndefined();
  });

  it('gets a team by worktree name', () => {
    db.insertTeam({ issueNumber: 100, worktreeName: 'kea-100' });
    const team = db.getTeamByWorktree('kea-100');

    expect(team).toBeDefined();
    expect(team!.issueNumber).toBe(100);
  });

  it('returns undefined for nonexistent worktree name', () => {
    const team = db.getTeamByWorktree('kea-nonexistent');
    expect(team).toBeUndefined();
  });

  it('updates a team', () => {
    db.insertTeam({ issueNumber: 100, worktreeName: 'kea-100' });
    const updated = db.updateTeam(1, {
      status: 'running',
      phase: 'implementing',
      pid: 9999,
      sessionId: 'sess-xyz',
    });

    expect(updated).toBeDefined();
    expect(updated!.status).toBe('running');
    expect(updated!.phase).toBe('implementing');
    expect(updated!.pid).toBe(9999);
    expect(updated!.sessionId).toBe('sess-xyz');
  });

  it('update with no fields returns unchanged team', () => {
    const original = db.insertTeam({ issueNumber: 100, worktreeName: 'kea-100' });
    const same = db.updateTeam(original.id, {});

    expect(same).toBeDefined();
    expect(same!.status).toBe(original.status);
  });

  it('lists all teams', () => {
    db.insertTeam({ issueNumber: 100, worktreeName: 'kea-100', status: 'running' });
    db.insertTeam({ issueNumber: 200, worktreeName: 'kea-200', status: 'done' });
    db.insertTeam({ issueNumber: 300, worktreeName: 'kea-300', status: 'running' });

    const all = db.getTeams();
    expect(all).toHaveLength(3);
  });

  it('lists teams filtered by status', () => {
    db.insertTeam({ issueNumber: 100, worktreeName: 'kea-100', status: 'running' });
    db.insertTeam({ issueNumber: 200, worktreeName: 'kea-200', status: 'done' });
    db.insertTeam({ issueNumber: 300, worktreeName: 'kea-300', status: 'running' });

    const running = db.getTeams({ status: 'running' });
    expect(running).toHaveLength(2);
    expect(running.every((t) => t.status === 'running')).toBe(true);
  });

  it('lists teams filtered by issueNumber', () => {
    db.insertTeam({ issueNumber: 100, worktreeName: 'kea-100' });
    db.insertTeam({ issueNumber: 200, worktreeName: 'kea-200' });

    const filtered = db.getTeams({ issueNumber: 100 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].issueNumber).toBe(100);
  });

  it('gets active teams (excludes done/failed)', () => {
    db.insertTeam({ issueNumber: 100, worktreeName: 'kea-100', status: 'running' });
    db.insertTeam({ issueNumber: 200, worktreeName: 'kea-200', status: 'done' });
    db.insertTeam({ issueNumber: 300, worktreeName: 'kea-300', status: 'idle' });
    db.insertTeam({ issueNumber: 400, worktreeName: 'kea-400', status: 'failed' });

    const active = db.getActiveTeams();
    expect(active).toHaveLength(2);
    expect(active.map((t) => t.worktreeName).sort()).toEqual(['kea-100', 'kea-300']);
  });

  it('enforces unique worktree_name', () => {
    db.insertTeam({ issueNumber: 100, worktreeName: 'kea-100' });
    expect(() => {
      db.insertTeam({ issueNumber: 101, worktreeName: 'kea-100' });
    }).toThrow();
  });
});

// =============================================================================
// Events CRUD
// =============================================================================

describe('Events CRUD', () => {
  beforeEach(() => {
    db.insertTeam({ issueNumber: 100, worktreeName: 'kea-100' });
  });

  it('inserts an event', () => {
    const event = db.insertEvent({
      teamId: 1,
      eventType: 'SessionStart',
      sessionId: 'sess-1',
      agentName: 'coordinator',
    });

    expect(event.id).toBe(1);
    expect(event.teamId).toBe(1);
    expect(event.hookType).toBe('SessionStart');
    expect(event.sessionId).toBe('sess-1');
    expect(event.agentType).toBe('coordinator');
    expect(event.createdAt).toBeTruthy();
  });

  it('inserts an event with minimal fields', () => {
    const event = db.insertEvent({
      teamId: 1,
      eventType: 'ToolUse',
    });

    expect(event.hookType).toBe('ToolUse');
    expect(event.sessionId).toBeNull();
    expect(event.toolName).toBeNull();
    expect(event.agentType).toBeNull();
  });

  it('inserts an event with tool_name and payload', () => {
    const event = db.insertEvent({
      teamId: 1,
      eventType: 'ToolUse',
      toolName: 'Bash',
      payload: '{"command": "ls"}',
    });

    expect(event.toolName).toBe('Bash');
    expect(event.payload).toBe('{"command": "ls"}');
  });

  it('gets events by team', () => {
    db.insertEvent({ teamId: 1, eventType: 'SessionStart' });
    db.insertEvent({ teamId: 1, eventType: 'ToolUse' });
    db.insertEvent({ teamId: 1, eventType: 'SessionEnd' });

    const events = db.getEventsByTeam(1);
    expect(events).toHaveLength(3);
  });

  it('gets events by team with limit', () => {
    db.insertEvent({ teamId: 1, eventType: 'SessionStart' });
    db.insertEvent({ teamId: 1, eventType: 'ToolUse' });
    db.insertEvent({ teamId: 1, eventType: 'SessionEnd' });

    const events = db.getEventsByTeam(1, 2);
    expect(events).toHaveLength(2);
  });

  it('gets latest event by team', () => {
    db.insertEvent({ teamId: 1, eventType: 'SessionStart' });
    db.insertEvent({ teamId: 1, eventType: 'ToolUse' });
    db.insertEvent({ teamId: 1, eventType: 'SessionEnd' });

    const latest = db.getLatestEventByTeam(1);
    expect(latest).toBeDefined();
    expect(latest!.hookType).toBe('SessionEnd');
  });

  it('returns undefined for latest event when no events exist', () => {
    const latest = db.getLatestEventByTeam(1);
    expect(latest).toBeUndefined();
  });

  it('gets all events with filters', () => {
    db.insertTeam({ issueNumber: 200, worktreeName: 'kea-200' });
    db.insertEvent({ teamId: 1, eventType: 'SessionStart' });
    db.insertEvent({ teamId: 1, eventType: 'ToolUse' });
    db.insertEvent({ teamId: 2, eventType: 'SessionStart' });

    // Filter by teamId
    const team1Events = db.getAllEvents({ teamId: 1 });
    expect(team1Events).toHaveLength(2);

    // Filter by eventType
    const toolUseEvents = db.getAllEvents({ eventType: 'ToolUse' });
    expect(toolUseEvents).toHaveLength(1);

    // Filter with limit
    const limited = db.getAllEvents({ limit: 1 });
    expect(limited).toHaveLength(1);
  });
});

// =============================================================================
// Pull Requests CRUD
// =============================================================================

describe('Pull Requests CRUD', () => {
  beforeEach(() => {
    db.insertTeam({ issueNumber: 100, worktreeName: 'kea-100' });
  });

  it('inserts a pull request', () => {
    const pr = db.insertPullRequest({
      prNumber: 42,
      teamId: 1,
      title: 'Fix stuff',
      state: 'open',
      ciStatus: 'pending',
    });

    expect(pr.prNumber).toBe(42);
    expect(pr.teamId).toBe(1);
    expect(pr.state).toBe('open');
    expect(pr.ciStatus).toBe('pending');
    expect(pr.autoMerge).toBe(false);
    expect(pr.ciFailCount).toBe(0);
  });

  it('inserts a pull request with all fields', () => {
    const checksJson = JSON.stringify([{ name: 'build', status: 'completed', conclusion: 'success' }]);
    const pr = db.insertPullRequest({
      prNumber: 99,
      teamId: 1,
      title: 'Big feature',
      state: 'open',
      ciStatus: 'passing',
      mergeState: 'clean',
      autoMerge: true,
      ciFailCount: 1,
      checksJson,
    });

    expect(pr.prNumber).toBe(99);
    expect(pr.autoMerge).toBe(true);
    expect(pr.ciFailCount).toBe(1);
    expect(pr.checksJson).toBe(checksJson);
  });

  it('gets a pull request by number', () => {
    db.insertPullRequest({ prNumber: 42, teamId: 1 });
    const pr = db.getPullRequest(42);

    expect(pr).toBeDefined();
    expect(pr!.prNumber).toBe(42);
  });

  it('returns undefined for nonexistent PR', () => {
    const pr = db.getPullRequest(999);
    expect(pr).toBeUndefined();
  });

  it('updates a pull request', () => {
    db.insertPullRequest({ prNumber: 42, teamId: 1, state: 'open' });

    const updated = db.updatePullRequest(42, {
      state: 'merged',
      ciStatus: 'passing',
      mergeState: 'clean',
      mergedAt: '2025-01-01T12:00:00.000Z',
    });

    expect(updated).toBeDefined();
    expect(updated!.state).toBe('merged');
    expect(updated!.ciStatus).toBe('passing');
    expect(updated!.mergeStatus).toBe('clean');
  });

  it('updates autoMerge flag', () => {
    db.insertPullRequest({ prNumber: 42, teamId: 1 });

    const updated = db.updatePullRequest(42, { autoMerge: true });
    expect(updated!.autoMerge).toBe(true);

    const updated2 = db.updatePullRequest(42, { autoMerge: false });
    expect(updated2!.autoMerge).toBe(false);
  });

  it('updates ciFailCount', () => {
    db.insertPullRequest({ prNumber: 42, teamId: 1 });

    const updated = db.updatePullRequest(42, { ciFailCount: 3 });
    expect(updated!.ciFailCount).toBe(3);
  });

  it('enforces unique pr_number', () => {
    db.insertPullRequest({ prNumber: 42, teamId: 1 });
    expect(() => {
      db.insertPullRequest({ prNumber: 42, teamId: 1 });
    }).toThrow();
  });
});

// =============================================================================
// Commands CRUD + mark delivered
// =============================================================================

describe('Commands CRUD', () => {
  beforeEach(() => {
    db.insertTeam({ issueNumber: 100, worktreeName: 'kea-100' });
  });

  it('inserts a command', () => {
    const cmd = db.insertCommand({
      teamId: 1,
      message: 'Focus on the login page',
    });

    expect(cmd.id).toBe(1);
    expect(cmd.teamId).toBe(1);
    expect(cmd.message).toBe('Focus on the login page');
    expect(cmd.delivered).toBe(false);
    expect(cmd.sentAt).toBeTruthy();
  });

  it('inserts a command with target agent', () => {
    const cmd = db.insertCommand({
      teamId: 1,
      targetAgent: 'kea-csharp-dev',
      message: 'Fix the null reference',
    });

    expect(cmd.teamId).toBe(1);
    expect(cmd.message).toBe('Fix the null reference');
  });

  it('gets pending commands for a team', () => {
    db.insertCommand({ teamId: 1, message: 'First' });
    db.insertCommand({ teamId: 1, message: 'Second' });

    const pending = db.getPendingCommands(1);
    expect(pending).toHaveLength(2);
    // Should be in ASC order (oldest first)
    expect(pending[0].message).toBe('First');
    expect(pending[1].message).toBe('Second');
  });

  it('marks a command as delivered', () => {
    db.insertCommand({ teamId: 1, message: 'Do the thing' });

    const delivered = db.markCommandDelivered(1);
    expect(delivered).toBeDefined();
    expect(delivered!.delivered).toBe(true);
  });

  it('delivered commands are not returned by getPendingCommands', () => {
    db.insertCommand({ teamId: 1, message: 'First' });
    db.insertCommand({ teamId: 1, message: 'Second' });

    db.markCommandDelivered(1);

    const pending = db.getPendingCommands(1);
    expect(pending).toHaveLength(1);
    expect(pending[0].message).toBe('Second');
  });

  it('returns empty array when no pending commands', () => {
    const pending = db.getPendingCommands(1);
    expect(pending).toHaveLength(0);
  });
});

// =============================================================================
// Cost Entries CRUD
// =============================================================================

describe('Cost Entries CRUD', () => {
  beforeEach(() => {
    db.insertTeam({ issueNumber: 100, worktreeName: 'kea-100' });
  });

  it('inserts a cost entry', () => {
    const entry = db.insertCostEntry({
      teamId: 1,
      sessionId: 'sess-1',
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.05,
    });

    expect(entry.id).toBe(1);
    expect(entry.teamId).toBe(1);
    expect(entry.sessionId).toBe('sess-1');
    expect(entry.inputTokens).toBe(1000);
    expect(entry.outputTokens).toBe(500);
    expect(entry.costUsd).toBe(0.05);
    expect(entry.recordedAt).toBeTruthy();
  });

  it('inserts a cost entry with defaults', () => {
    const entry = db.insertCostEntry({ teamId: 1 });

    expect(entry.inputTokens).toBe(0);
    expect(entry.outputTokens).toBe(0);
    expect(entry.costUsd).toBe(0);
  });

  it('gets cost summary by team', () => {
    db.insertCostEntry({ teamId: 1, inputTokens: 1000, outputTokens: 500, costUsd: 0.05 });
    db.insertCostEntry({ teamId: 1, inputTokens: 2000, outputTokens: 1000, costUsd: 0.10 });

    const summary = db.getCostByTeam(1);
    expect(summary.totalInputTokens).toBe(3000);
    expect(summary.totalOutputTokens).toBe(1500);
    expect(summary.totalCostUsd).toBeCloseTo(0.15);
    expect(summary.entryCount).toBe(2);
  });

  it('returns zero summary for team with no cost entries', () => {
    const summary = db.getCostByTeam(1);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.entryCount).toBe(0);
  });

  it('gets overall cost summary', () => {
    db.insertTeam({ issueNumber: 200, worktreeName: 'kea-200' });
    db.insertCostEntry({ teamId: 1, costUsd: 0.10 });
    db.insertCostEntry({ teamId: 2, costUsd: 0.20 });

    const summary = db.getCostSummary();
    expect(summary.totalCostUsd).toBeCloseTo(0.30);
    expect(summary.entryCount).toBe(2);
  });

  it('gets cost breakdown by team', () => {
    db.insertTeam({ issueNumber: 200, worktreeName: 'kea-200' });
    db.insertCostEntry({ teamId: 1, costUsd: 0.10 });
    db.insertCostEntry({ teamId: 1, costUsd: 0.05 });
    db.insertCostEntry({ teamId: 2, costUsd: 0.20 });

    const breakdown = db.getCostByTeamBreakdown();
    expect(breakdown).toHaveLength(2);
    // Ordered by cost DESC
    expect(breakdown[0].worktreeName).toBe('kea-200');
    expect(breakdown[0].totalCostUsd).toBeCloseTo(0.20);
    expect(breakdown[1].worktreeName).toBe('kea-100');
    expect(breakdown[1].totalCostUsd).toBeCloseTo(0.15);
  });
});

// =============================================================================
// v_team_dashboard view
// =============================================================================

describe('v_team_dashboard view', () => {
  it('returns aggregated dashboard data', () => {
    db.insertTeam({
      issueNumber: 100,
      worktreeName: 'kea-100',
      status: 'running',
      phase: 'implementing',
      launchedAt: minutesAgo(30),
    });

    db.updateTeam(1, { lastEventAt: minutesAgo(2) });

    db.insertCostEntry({ teamId: 1, costUsd: 0.10, sessionId: 'sess-1' });
    db.insertCostEntry({ teamId: 1, costUsd: 0.05, sessionId: 'sess-2' });

    db.insertEvent({ teamId: 1, eventType: 'SessionStart' });
    db.insertEvent({ teamId: 1, eventType: 'ToolUse' });

    const rows = db.getTeamDashboard();
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.id).toBe(1);
    expect(row.issueNumber).toBe(100);
    expect(row.worktreeName).toBe('kea-100');
    expect(row.status).toBe('running');
    expect(row.phase).toBe('implementing');
    expect(row.totalCost).toBeCloseTo(0.15);
    expect(row.sessionCount).toBe(2);
  });

  it('includes PR info when associated', () => {
    db.insertTeam({
      issueNumber: 100,
      worktreeName: 'kea-100',
      status: 'running',
      phase: 'pr',
      prNumber: 42,
    });
    db.insertPullRequest({
      prNumber: 42,
      teamId: 1,
      state: 'open',
      ciStatus: 'passing',
      mergeState: 'clean',
    });

    const rows = db.getTeamDashboard();
    expect(rows).toHaveLength(1);
    expect(rows[0].prState).toBe('open');
    expect(rows[0].ciStatus).toBe('passing');
    expect(rows[0].mergeStatus).toBe('clean');
  });

  it('handles teams with no PRs or costs', () => {
    db.insertTeam({
      issueNumber: 100,
      worktreeName: 'kea-100',
      status: 'running',
      phase: 'analyzing',
    });

    const rows = db.getTeamDashboard();
    expect(rows).toHaveLength(1);
    expect(rows[0].totalCost).toBe(0);
    expect(rows[0].prState).toBeNull();
  });
});

// =============================================================================
// getStuckCandidates
// =============================================================================

describe('getStuckCandidates', () => {
  it('returns teams idle beyond the threshold', () => {
    db.insertTeam({
      issueNumber: 100,
      worktreeName: 'kea-100',
      status: 'running',
      phase: 'implementing',
    });
    db.updateTeam(1, { lastEventAt: minutesAgo(10) });

    const candidates = db.getStuckCandidates(5);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].worktreeName).toBe('kea-100');
    expect(candidates[0].minutesSinceLastEvent).toBeGreaterThanOrEqual(9);
  });

  it('does not return teams below the threshold', () => {
    db.insertTeam({
      issueNumber: 100,
      worktreeName: 'kea-100',
      status: 'running',
      phase: 'implementing',
    });
    db.updateTeam(1, { lastEventAt: minutesAgo(3) });

    const candidates = db.getStuckCandidates(5);
    expect(candidates).toHaveLength(0);
  });

  it('does not return teams with null lastEventAt', () => {
    db.insertTeam({
      issueNumber: 100,
      worktreeName: 'kea-100',
      status: 'running',
      phase: 'implementing',
    });
    // lastEventAt is not set

    const candidates = db.getStuckCandidates(5);
    expect(candidates).toHaveLength(0);
  });

  it('only includes running and idle teams', () => {
    // running team, 10 min idle
    db.insertTeam({ issueNumber: 100, worktreeName: 'kea-100', status: 'running' });
    db.updateTeam(1, { lastEventAt: minutesAgo(10) });

    // done team, 20 min idle (should not appear)
    db.insertTeam({ issueNumber: 200, worktreeName: 'kea-200', status: 'done' });
    db.updateTeam(2, { lastEventAt: minutesAgo(20) });

    // idle team, 10 min idle
    db.insertTeam({ issueNumber: 300, worktreeName: 'kea-300', status: 'idle' });
    db.updateTeam(3, { lastEventAt: minutesAgo(10) });

    const candidates = db.getStuckCandidates(5);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.worktreeName).sort()).toEqual(['kea-100', 'kea-300']);
  });

  it('respects custom threshold', () => {
    db.insertTeam({ issueNumber: 100, worktreeName: 'kea-100', status: 'running' });
    db.updateTeam(1, { lastEventAt: minutesAgo(8) });

    // With threshold of 10, this team should NOT be returned
    const candidates10 = db.getStuckCandidates(10);
    expect(candidates10).toHaveLength(0);

    // With threshold of 5, it should be returned
    const candidates5 = db.getStuckCandidates(5);
    expect(candidates5).toHaveLength(1);
  });

  it('orders by minutes since last event descending', () => {
    db.insertTeam({ issueNumber: 100, worktreeName: 'kea-100', status: 'running' });
    db.updateTeam(1, { lastEventAt: minutesAgo(10) });

    db.insertTeam({ issueNumber: 200, worktreeName: 'kea-200', status: 'running' });
    db.updateTeam(2, { lastEventAt: minutesAgo(20) });

    db.insertTeam({ issueNumber: 300, worktreeName: 'kea-300', status: 'idle' });
    db.updateTeam(3, { lastEventAt: minutesAgo(15) });

    const candidates = db.getStuckCandidates(5);
    expect(candidates).toHaveLength(3);
    // Ordered by minutes DESC: kea-200 (20), kea-300 (15), kea-100 (10)
    expect(candidates[0].worktreeName).toBe('kea-200');
    expect(candidates[1].worktreeName).toBe('kea-300');
    expect(candidates[2].worktreeName).toBe('kea-100');
  });
});

// =============================================================================
// Connection management
// =============================================================================

describe('Connection management', () => {
  it('closes the database', () => {
    db.close();
    // After closing, operations should throw
    expect(() => db.getTeams()).toThrow();
  });

  it('reports database file size', () => {
    const size = db.getDbFileSize();
    expect(size).toBeGreaterThan(0);
  });
});
