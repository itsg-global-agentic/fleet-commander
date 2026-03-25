// =============================================================================
// Fleet Commander — Data Retention Tests
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
  dbPath = path.join(
    os.tmpdir(),
    `fleet-retention-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
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

/** Insert a project and team for FK constraints. Returns the team ID. */
function insertProjectAndTeam(): number {
  db.raw.prepare(
    `INSERT INTO projects (name, repo_path, github_repo, status)
     VALUES ('test-proj', '/tmp/test-proj', 'org/test-proj', 'active')`
  ).run();
  const projectId = db.raw.prepare('SELECT id FROM projects ORDER BY id DESC LIMIT 1').get() as { id: number };

  db.raw.prepare(
    `INSERT INTO teams (issue_number, project_id, worktree_name, status, phase)
     VALUES (1, @projectId, 'test-proj-1', 'done', 'done')`
  ).run({ projectId: projectId.id });
  const teamRow = db.raw.prepare('SELECT id FROM teams ORDER BY id DESC LIMIT 1').get() as { id: number };
  return teamRow.id;
}

/** Insert an event with a specific created_at timestamp. */
function insertEventAt(teamId: number, createdAt: string): void {
  db.raw.prepare(
    `INSERT INTO events (team_id, event_type, created_at) VALUES (?, 'tool_use', ?)`
  ).run(teamId, createdAt);
}

/** Insert a usage_snapshot with a specific recorded_at timestamp. */
function insertUsageAt(recordedAt: string): void {
  db.raw.prepare(
    `INSERT INTO usage_snapshots (daily_percent, weekly_percent, recorded_at)
     VALUES (10, 20, ?)`
  ).run(recordedAt);
}

/** Insert a command with a specific created_at timestamp. */
function insertCommandAt(teamId: number, createdAt: string): void {
  db.raw.prepare(
    `INSERT INTO commands (team_id, message, created_at) VALUES (?, 'test msg', ?)`
  ).run(teamId, createdAt);
}

/** Insert a team_transition with a specific created_at timestamp. */
function insertTransitionAt(teamId: number, createdAt: string): void {
  db.raw.prepare(
    `INSERT INTO team_transitions (team_id, from_status, to_status, created_at)
     VALUES (?, 'running', 'idle', ?)`
  ).run(teamId, createdAt);
}

/** Insert an agent_message with a specific created_at timestamp. */
function insertAgentMessageAt(teamId: number, createdAt: string): void {
  db.raw.prepare(
    `INSERT INTO agent_messages (team_id, sender, recipient, content, created_at)
     VALUES (?, 'dev', 'tl', 'hello', ?)`
  ).run(teamId, createdAt);
}

function daysAgo(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  // Format as SQLite datetime: YYYY-MM-DD HH:MM:SS
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function countRows(table: string): number {
  const row = db.raw.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as { cnt: number };
  return row.cnt;
}

beforeEach(() => {
  db = createTempDb();
});

afterEach(() => {
  cleanupDb();
});

// =============================================================================
// purgeOldEvents
// =============================================================================

describe('purgeOldEvents', () => {
  it('should delete events older than retention period', () => {
    const teamId = insertProjectAndTeam();

    // Insert old events (100 days ago)
    insertEventAt(teamId, daysAgo(100));
    insertEventAt(teamId, daysAgo(95));

    // Insert recent events (10 days ago)
    insertEventAt(teamId, daysAgo(10));
    insertEventAt(teamId, daysAgo(5));

    expect(countRows('events')).toBe(4);

    const deleted = db.purgeOldEvents(90);

    expect(deleted).toBe(2);
    expect(countRows('events')).toBe(2);
  });

  it('should keep events within retention period', () => {
    const teamId = insertProjectAndTeam();

    insertEventAt(teamId, daysAgo(30));
    insertEventAt(teamId, daysAgo(10));
    insertEventAt(teamId, daysAgo(1));

    const deleted = db.purgeOldEvents(90);

    expect(deleted).toBe(0);
    expect(countRows('events')).toBe(3);
  });

  it('should handle empty events table gracefully', () => {
    const deleted = db.purgeOldEvents(90);
    expect(deleted).toBe(0);
  });

  it('should use batched deletes', () => {
    const teamId = insertProjectAndTeam();

    // Insert 12 old events (use small batch size to test batching)
    for (let i = 0; i < 12; i++) {
      insertEventAt(teamId, daysAgo(100));
    }

    const deleted = db.purgeOldEvents(90, 5); // batch size of 5

    expect(deleted).toBe(12);
    expect(countRows('events')).toBe(0);
  });
});

// =============================================================================
// purgeOldUsageSnapshots
// =============================================================================

describe('purgeOldUsageSnapshots', () => {
  it('should delete usage snapshots older than retention period', () => {
    // Insert old snapshots (40 days ago)
    insertUsageAt(daysAgo(40));
    insertUsageAt(daysAgo(35));

    // Insert recent snapshots (10 days ago)
    insertUsageAt(daysAgo(10));

    expect(countRows('usage_snapshots')).toBe(3);

    const deleted = db.purgeOldUsageSnapshots(30);

    expect(deleted).toBe(2);
    expect(countRows('usage_snapshots')).toBe(1);
  });

  it('should keep snapshots within retention period', () => {
    insertUsageAt(daysAgo(15));
    insertUsageAt(daysAgo(5));

    const deleted = db.purgeOldUsageSnapshots(30);

    expect(deleted).toBe(0);
    expect(countRows('usage_snapshots')).toBe(2);
  });

  it('should handle empty usage_snapshots table gracefully', () => {
    const deleted = db.purgeOldUsageSnapshots(30);
    expect(deleted).toBe(0);
  });
});

// =============================================================================
// purgeOldCommands
// =============================================================================

describe('purgeOldCommands', () => {
  it('should delete commands older than retention period', () => {
    const teamId = insertProjectAndTeam();

    insertCommandAt(teamId, daysAgo(100));
    insertCommandAt(teamId, daysAgo(5));

    const deleted = db.purgeOldCommands(90);

    expect(deleted).toBe(1);
    expect(countRows('commands')).toBe(1);
  });

  it('should handle empty commands table gracefully', () => {
    const deleted = db.purgeOldCommands(90);
    expect(deleted).toBe(0);
  });
});

// =============================================================================
// purgeOldTeamTransitions
// =============================================================================

describe('purgeOldTeamTransitions', () => {
  it('should delete transitions older than retention period', () => {
    const teamId = insertProjectAndTeam();

    insertTransitionAt(teamId, daysAgo(100));
    insertTransitionAt(teamId, daysAgo(5));

    const deleted = db.purgeOldTeamTransitions(90);

    expect(deleted).toBe(1);
    expect(countRows('team_transitions')).toBe(1);
  });

  it('should handle empty team_transitions table gracefully', () => {
    const deleted = db.purgeOldTeamTransitions(90);
    expect(deleted).toBe(0);
  });
});

// =============================================================================
// purgeOldAgentMessages
// =============================================================================

describe('purgeOldAgentMessages', () => {
  it('should delete agent messages older than retention period', () => {
    const teamId = insertProjectAndTeam();

    insertAgentMessageAt(teamId, daysAgo(100));
    insertAgentMessageAt(teamId, daysAgo(5));

    const deleted = db.purgeOldAgentMessages(90);

    expect(deleted).toBe(1);
    expect(countRows('agent_messages')).toBe(1);
  });

  it('should handle empty agent_messages table gracefully', () => {
    const deleted = db.purgeOldAgentMessages(90);
    expect(deleted).toBe(0);
  });
});

// =============================================================================
// purgeOldStreamEvents
// =============================================================================

describe('purgeOldStreamEvents', () => {
  it('should delete stream_events for teams stopped beyond retention period', () => {
    const teamId = insertProjectAndTeam();

    // Mark the team as stopped 100 days ago
    db.raw.prepare(
      `UPDATE teams SET stopped_at = ? WHERE id = ?`
    ).run(daysAgo(100), teamId);

    // Insert stream events for that team
    db.raw.prepare(
      `INSERT INTO stream_events (team_id, event_data) VALUES (?, '[]')`
    ).run(teamId);

    expect(countRows('stream_events')).toBe(1);

    const deleted = db.purgeOldStreamEvents(90);

    expect(deleted).toBe(1);
    expect(countRows('stream_events')).toBe(0);
  });

  it('should keep stream_events for recently stopped teams', () => {
    const teamId = insertProjectAndTeam();

    db.raw.prepare(
      `UPDATE teams SET stopped_at = ? WHERE id = ?`
    ).run(daysAgo(10), teamId);

    db.raw.prepare(
      `INSERT INTO stream_events (team_id, event_data) VALUES (?, '[]')`
    ).run(teamId);

    const deleted = db.purgeOldStreamEvents(90);

    expect(deleted).toBe(0);
    expect(countRows('stream_events')).toBe(1);
  });

  it('should keep stream_events for teams that are still running (no stopped_at)', () => {
    const teamId = insertProjectAndTeam();

    // Team is still running (no stopped_at)
    db.raw.prepare(
      `UPDATE teams SET status = 'running', stopped_at = NULL WHERE id = ?`
    ).run(teamId);

    db.raw.prepare(
      `INSERT INTO stream_events (team_id, event_data) VALUES (?, '[]')`
    ).run(teamId);

    const deleted = db.purgeOldStreamEvents(90);

    expect(deleted).toBe(0);
    expect(countRows('stream_events')).toBe(1);
  });

  it('should handle empty stream_events table gracefully', () => {
    const deleted = db.purgeOldStreamEvents(90);
    expect(deleted).toBe(0);
  });
});

// =============================================================================
// Configurable retention periods
// =============================================================================

describe('Configurable retention periods', () => {
  it('should respect different retention periods for events vs usage_snapshots', () => {
    const teamId = insertProjectAndTeam();

    // Insert events and usage at 45 days ago
    insertEventAt(teamId, daysAgo(45));
    insertUsageAt(daysAgo(45));

    // With 90-day events retention, the event should survive
    const eventsDeleted = db.purgeOldEvents(90);
    expect(eventsDeleted).toBe(0);

    // With 30-day usage retention, the snapshot should be deleted
    const usageDeleted = db.purgeOldUsageSnapshots(30);
    expect(usageDeleted).toBe(1);
  });

  it('should allow very short retention periods (1 day)', () => {
    const teamId = insertProjectAndTeam();

    // Insert events from 2 days ago
    insertEventAt(teamId, daysAgo(2));

    const deleted = db.purgeOldEvents(1);
    expect(deleted).toBe(1);
  });
});
