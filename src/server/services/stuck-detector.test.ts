// =============================================================================
// Fleet Commander — Stuck Detector Service Tests
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { FleetDatabase, getDatabase, closeDatabase } from '../db.js';

// We need to mock the SSE broker before importing stuck-detector
vi.mock('./sse-broker.js', () => ({
  sseBroker: {
    broadcast: vi.fn(),
  },
}));

// Import after mocking
import { stuckDetector } from './stuck-detector.js';
import { sseBroker } from './sse-broker.js';

const TEST_DB_PATH = path.join(process.cwd(), 'test-stuck-detector.db');

function cleanupDb(): void {
  for (const f of [TEST_DB_PATH, TEST_DB_PATH + '-wal', TEST_DB_PATH + '-shm']) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

beforeEach(() => {
  cleanupDb();
  // Initialize the singleton database with our test path
  closeDatabase();
  const db = getDatabase(TEST_DB_PATH);
  vi.mocked(sseBroker.broadcast).mockClear();
});

afterEach(() => {
  stuckDetector.stop();
  closeDatabase();
  cleanupDb();
});

describe('StuckDetector', () => {
  describe('start/stop', () => {
    it('starts and stops without error', () => {
      stuckDetector.start();
      stuckDetector.stop();
    });

    it('calling start twice does not create duplicate intervals', () => {
      stuckDetector.start();
      stuckDetector.start(); // should be a no-op
      stuckDetector.stop();
    });

    it('calling stop when not started is safe', () => {
      stuckDetector.stop(); // should not throw
    });
  });

  describe('check() — idle detection', () => {
    it('transitions running -> idle after idle threshold', () => {
      const db = getDatabase();
      db.insertTeam({
        issueNumber: 100,
        worktreeName: 'kea-100',
        status: 'running',
        phase: 'implementing',
      });
      // Set lastEventAt to 6 minutes ago (> 5 min idle threshold)
      db.updateTeam(1, { lastEventAt: minutesAgo(6) });

      stuckDetector.check();

      const team = db.getTeam(1)!;
      expect(team.status).toBe('idle');
    });

    it('does NOT transition running -> idle before threshold', () => {
      const db = getDatabase();
      db.insertTeam({
        issueNumber: 101,
        worktreeName: 'kea-101',
        status: 'running',
        phase: 'implementing',
      });
      // Set lastEventAt to 3 minutes ago (< 5 min idle threshold)
      db.updateTeam(1, { lastEventAt: minutesAgo(3) });

      stuckDetector.check();

      const team = db.getTeam(1)!;
      expect(team.status).toBe('running');
    });

    it('broadcasts SSE event on running -> idle transition', () => {
      const db = getDatabase();
      db.insertTeam({
        issueNumber: 102,
        worktreeName: 'kea-102',
        status: 'running',
        phase: 'implementing',
      });
      db.updateTeam(1, { lastEventAt: minutesAgo(7) });

      stuckDetector.check();

      expect(sseBroker.broadcast).toHaveBeenCalledWith(
        'team_status_changed',
        expect.objectContaining({
          team_id: 1,
          status: 'idle',
          previous_status: 'running',
        }),
        1,
      );
    });
  });

  describe('check() — stuck detection', () => {
    it('transitions idle -> stuck after stuck threshold', () => {
      const db = getDatabase();
      db.insertTeam({
        issueNumber: 200,
        worktreeName: 'kea-200',
        status: 'idle',
        phase: 'implementing',
      });
      // Set lastEventAt to 16 minutes ago (> 15 min stuck threshold)
      db.updateTeam(1, { lastEventAt: minutesAgo(16) });

      stuckDetector.check();

      const team = db.getTeam(1)!;
      expect(team.status).toBe('stuck');
    });

    it('does NOT transition idle -> stuck before threshold', () => {
      const db = getDatabase();
      db.insertTeam({
        issueNumber: 201,
        worktreeName: 'kea-201',
        status: 'idle',
        phase: 'implementing',
      });
      // Set lastEventAt to 10 minutes ago (between idle and stuck thresholds)
      db.updateTeam(1, { lastEventAt: minutesAgo(10) });

      stuckDetector.check();

      const team = db.getTeam(1)!;
      expect(team.status).toBe('idle');
    });

    it('broadcasts SSE event on idle -> stuck transition', () => {
      const db = getDatabase();
      db.insertTeam({
        issueNumber: 202,
        worktreeName: 'kea-202',
        status: 'idle',
        phase: 'implementing',
      });
      db.updateTeam(1, { lastEventAt: minutesAgo(20) });

      stuckDetector.check();

      expect(sseBroker.broadcast).toHaveBeenCalledWith(
        'team_status_changed',
        expect.objectContaining({
          team_id: 1,
          status: 'stuck',
          previous_status: 'idle',
          idle_minutes: 20,
        }),
        1,
      );
    });
  });

  describe('check() — CI failure threshold -> blocked phase', () => {
    it('marks team phase as blocked when CI failures >= threshold', () => {
      const db = getDatabase();
      db.insertTeam({
        issueNumber: 300,
        worktreeName: 'kea-300',
        status: 'running',
        phase: 'pr',
        prNumber: 42,
      });
      // Set lastEventAt to recent so we don't trigger idle
      db.updateTeam(1, { lastEventAt: minutesAgo(1) });

      // Create a PR with 3 CI failures (>= maxUniqueCiFailures)
      db.insertPullRequest({
        prNumber: 42,
        teamId: 1,
        ciFailCount: 3,
      });

      stuckDetector.check();

      const team = db.getTeam(1)!;
      expect(team.phase).toBe('blocked');
    });

    it('does NOT mark as blocked when CI failures < threshold', () => {
      const db = getDatabase();
      db.insertTeam({
        issueNumber: 301,
        worktreeName: 'kea-301',
        status: 'running',
        phase: 'pr',
        prNumber: 43,
      });
      db.updateTeam(1, { lastEventAt: minutesAgo(1) });

      db.insertPullRequest({
        prNumber: 43,
        teamId: 1,
        ciFailCount: 2,
      });

      stuckDetector.check();

      const team = db.getTeam(1)!;
      expect(team.phase).toBe('pr');
    });

    it('does NOT re-mark phase if already blocked', () => {
      const db = getDatabase();
      db.insertTeam({
        issueNumber: 302,
        worktreeName: 'kea-302',
        status: 'running',
        phase: 'blocked',
        prNumber: 44,
      });
      db.updateTeam(1, { lastEventAt: minutesAgo(1) });

      db.insertPullRequest({
        prNumber: 44,
        teamId: 1,
        ciFailCount: 5,
      });

      stuckDetector.check();

      // Should NOT broadcast since phase was already 'blocked'
      expect(sseBroker.broadcast).not.toHaveBeenCalled();
    });

    it('broadcasts SSE event on phase -> blocked transition', () => {
      const db = getDatabase();
      db.insertTeam({
        issueNumber: 303,
        worktreeName: 'kea-303',
        status: 'running',
        phase: 'pr',
        prNumber: 45,
      });
      db.updateTeam(1, { lastEventAt: minutesAgo(1) });

      db.insertPullRequest({
        prNumber: 45,
        teamId: 1,
        ciFailCount: 4,
      });

      stuckDetector.check();

      expect(sseBroker.broadcast).toHaveBeenCalledWith(
        'team_status_changed',
        expect.objectContaining({
          team_id: 1,
          phase: 'blocked',
          reason: '4 unique CI failures',
        }),
        1,
      );
    });
  });

  describe('check() — edge cases', () => {
    it('skips teams with no lastEventAt', () => {
      const db = getDatabase();
      db.insertTeam({
        issueNumber: 400,
        worktreeName: 'kea-400',
        status: 'running',
        phase: 'analyzing',
      });
      // Don't set lastEventAt — should skip idle/stuck check

      stuckDetector.check();

      const team = db.getTeam(1)!;
      expect(team.status).toBe('running');
      expect(sseBroker.broadcast).not.toHaveBeenCalled();
    });

    it('skips done/failed teams (not active)', () => {
      const db = getDatabase();
      // Insert a team and mark as done
      const team = db.insertTeam({
        issueNumber: 401,
        worktreeName: 'kea-401',
        status: 'done',
        phase: 'done',
      });
      db.updateTeam(team.id, { lastEventAt: minutesAgo(30) });

      stuckDetector.check();

      const result = db.getTeam(team.id)!;
      expect(result.status).toBe('done');
      expect(sseBroker.broadcast).not.toHaveBeenCalled();
    });

    it('handles multiple teams in a single check', () => {
      const db = getDatabase();

      // Team 1: running, 7 min idle -> should go idle
      const t1 = db.insertTeam({
        issueNumber: 501,
        worktreeName: 'kea-501',
        status: 'running',
        phase: 'implementing',
      });
      db.updateTeam(t1.id, { lastEventAt: minutesAgo(7) });

      // Team 2: idle, 20 min idle -> should go stuck
      const t2 = db.insertTeam({
        issueNumber: 502,
        worktreeName: 'kea-502',
        status: 'idle',
        phase: 'implementing',
      });
      db.updateTeam(t2.id, { lastEventAt: minutesAgo(20) });

      // Team 3: running, 2 min idle -> should stay running
      const t3 = db.insertTeam({
        issueNumber: 503,
        worktreeName: 'kea-503',
        status: 'running',
        phase: 'analyzing',
      });
      db.updateTeam(t3.id, { lastEventAt: minutesAgo(2) });

      stuckDetector.check();

      expect(db.getTeam(t1.id)!.status).toBe('idle');
      expect(db.getTeam(t2.id)!.status).toBe('stuck');
      expect(db.getTeam(t3.id)!.status).toBe('running');

      // Two broadcasts: one for t1, one for t2
      expect(sseBroker.broadcast).toHaveBeenCalledTimes(2);
    });

    it('skips teams with no prNumber for CI check', () => {
      const db = getDatabase();
      db.insertTeam({
        issueNumber: 600,
        worktreeName: 'kea-600',
        status: 'running',
        phase: 'implementing',
        // No prNumber set
      });
      db.updateTeam(1, { lastEventAt: minutesAgo(1) });

      stuckDetector.check();

      // No broadcast, no errors
      expect(sseBroker.broadcast).not.toHaveBeenCalled();
    });
  });
});
