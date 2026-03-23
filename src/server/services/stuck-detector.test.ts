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
      const team = db.insertTeam({
        issueNumber: 100,
        worktreeName: 'kea-100',
        status: 'running',
        phase: 'implementing',
      });
      // Set lastEventAt to 6 minutes ago (> 5 min idle threshold)
      db.updateTeam(team.id, { lastEventAt: minutesAgo(6) });

      stuckDetector.check();

      const result = db.getTeam(team.id)!;
      expect(result.status).toBe('idle');
    });

    it('does NOT transition running -> idle before threshold', () => {
      const db = getDatabase();
      const team = db.insertTeam({
        issueNumber: 101,
        worktreeName: 'kea-101',
        status: 'running',
        phase: 'implementing',
      });
      // Set lastEventAt to 2 minutes ago (< 5 min idle threshold)
      db.updateTeam(team.id, { lastEventAt: minutesAgo(2) });

      stuckDetector.check();

      const result = db.getTeam(team.id)!;
      expect(result.status).toBe('running');
    });

    it('broadcasts SSE event on running -> idle transition', () => {
      const db = getDatabase();
      const team = db.insertTeam({
        issueNumber: 102,
        worktreeName: 'kea-102',
        status: 'running',
        phase: 'implementing',
      });
      db.updateTeam(team.id, { lastEventAt: minutesAgo(6) });

      stuckDetector.check();

      expect(sseBroker.broadcast).toHaveBeenCalledWith(
        'team_status_changed',
        expect.objectContaining({
          team_id: team.id,
          status: 'idle',
          previous_status: 'running',
        }),
        team.id,
      );
    });
  });

  describe('check() — stuck detection', () => {
    it('transitions idle -> stuck after stuck threshold', () => {
      const db = getDatabase();
      const team = db.insertTeam({
        issueNumber: 200,
        worktreeName: 'kea-200',
        status: 'idle',
        phase: 'implementing',
      });
      // Set lastEventAt to 11 minutes ago (> 10 min stuck threshold)
      db.updateTeam(team.id, { lastEventAt: minutesAgo(11) });

      stuckDetector.check();

      const result = db.getTeam(team.id)!;
      expect(result.status).toBe('stuck');
    });

    it('does NOT transition idle -> stuck before threshold', () => {
      const db = getDatabase();
      const team = db.insertTeam({
        issueNumber: 201,
        worktreeName: 'kea-201',
        status: 'idle',
        phase: 'implementing',
      });
      // Set lastEventAt to 7 minutes ago (between 5 min idle and 10 min stuck thresholds)
      db.updateTeam(team.id, { lastEventAt: minutesAgo(7) });

      stuckDetector.check();

      const result = db.getTeam(team.id)!;
      expect(result.status).toBe('idle');
    });

    it('broadcasts SSE event on idle -> stuck transition', () => {
      const db = getDatabase();
      const team = db.insertTeam({
        issueNumber: 202,
        worktreeName: 'kea-202',
        status: 'idle',
        phase: 'implementing',
      });
      db.updateTeam(team.id, { lastEventAt: minutesAgo(12) });

      stuckDetector.check();

      expect(sseBroker.broadcast).toHaveBeenCalledWith(
        'team_status_changed',
        expect.objectContaining({
          team_id: team.id,
          status: 'stuck',
          previous_status: 'idle',
          idle_minutes: 12,
        }),
        team.id,
      );
    });
  });

  describe('check() — edge cases', () => {
    it('skips teams with no lastEventAt', () => {
      const db = getDatabase();
      const team = db.insertTeam({
        issueNumber: 400,
        worktreeName: 'kea-400',
        status: 'running',
        phase: 'analyzing',
      });
      // Don't set lastEventAt — should skip idle/stuck check

      stuckDetector.check();

      const result = db.getTeam(team.id)!;
      expect(result.status).toBe('running');
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

      // Team 1: running, 6 min idle -> should go idle (> 5 min threshold)
      const t1 = db.insertTeam({
        issueNumber: 501,
        worktreeName: 'kea-501',
        status: 'running',
        phase: 'implementing',
      });
      db.updateTeam(t1.id, { lastEventAt: minutesAgo(6) });

      // Team 2: idle, 11 min idle -> should go stuck (> 10 min threshold)
      const t2 = db.insertTeam({
        issueNumber: 502,
        worktreeName: 'kea-502',
        status: 'idle',
        phase: 'implementing',
      });
      db.updateTeam(t2.id, { lastEventAt: minutesAgo(11) });

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

    it('skips running -> idle when PR has pending CI', () => {
      const db = getDatabase();
      // Create a project first (needed for foreign key)
      const project = db.insertProject({
        name: 'test-project',
        repoPath: '/tmp/test-project',
      });
      const team = db.insertTeam({
        issueNumber: 700,
        worktreeName: 'kea-700',
        status: 'running',
        phase: 'pr',
        projectId: project.id,
        prNumber: 700,
      });
      // Set lastEventAt to 6 minutes ago — would normally trigger idle
      db.updateTeam(team.id, { lastEventAt: minutesAgo(6) });

      // Insert a PR with pending CI
      db.insertPullRequest({
        prNumber: 700,
        teamId: team.id,
        title: 'PR #700',
        state: 'open',
        ciStatus: 'pending',
        mergeStatus: 'unknown',
        autoMerge: false,
        ciFailCount: 0,
        checksJson: '[]',
      });

      stuckDetector.check();

      // Team should still be running — CI pending skips the transition
      const result = db.getTeam(team.id)!;
      expect(result.status).toBe('running');
      expect(sseBroker.broadcast).not.toHaveBeenCalled();
    });

    it('skips idle -> stuck when PR has pending CI', () => {
      const db = getDatabase();
      const project = db.insertProject({
        name: 'test-project-2',
        repoPath: '/tmp/test-project-2',
      });
      const team = db.insertTeam({
        issueNumber: 701,
        worktreeName: 'kea-701',
        status: 'idle',
        phase: 'pr',
        projectId: project.id,
        prNumber: 701,
      });
      // Set lastEventAt to 11 minutes ago — would normally trigger stuck
      db.updateTeam(team.id, { lastEventAt: minutesAgo(11) });

      // Insert a PR with pending CI
      db.insertPullRequest({
        prNumber: 701,
        teamId: team.id,
        title: 'PR #701',
        state: 'open',
        ciStatus: 'pending',
        mergeStatus: 'unknown',
        autoMerge: false,
        ciFailCount: 0,
        checksJson: '[]',
      });

      stuckDetector.check();

      // Team should still be idle — CI pending skips the transition
      const result = db.getTeam(team.id)!;
      expect(result.status).toBe('idle');
      expect(sseBroker.broadcast).not.toHaveBeenCalled();
    });

    it('still transitions to idle when PR CI is failing', () => {
      const db = getDatabase();
      const project = db.insertProject({
        name: 'test-project-3',
        repoPath: '/tmp/test-project-3',
      });
      const team = db.insertTeam({
        issueNumber: 702,
        worktreeName: 'kea-702',
        status: 'running',
        phase: 'pr',
        projectId: project.id,
        prNumber: 702,
      });
      // Set lastEventAt to 6 minutes ago — should trigger idle
      db.updateTeam(team.id, { lastEventAt: minutesAgo(6) });

      // Insert a PR with failing CI — should NOT skip the transition
      db.insertPullRequest({
        prNumber: 702,
        teamId: team.id,
        title: 'PR #702',
        state: 'open',
        ciStatus: 'failing',
        mergeStatus: 'unknown',
        autoMerge: false,
        ciFailCount: 1,
        checksJson: '[]',
      });

      stuckDetector.check();

      // Team should be idle — failing CI does not skip transition
      const result = db.getTeam(team.id)!;
      expect(result.status).toBe('idle');
      expect(sseBroker.broadcast).toHaveBeenCalled();
    });

    it('still transitions to idle when PR CI is passing', () => {
      const db = getDatabase();
      const project = db.insertProject({
        name: 'test-project-4',
        repoPath: '/tmp/test-project-4',
      });
      const team = db.insertTeam({
        issueNumber: 703,
        worktreeName: 'kea-703',
        status: 'running',
        phase: 'pr',
        projectId: project.id,
        prNumber: 703,
      });
      // Set lastEventAt to 6 minutes ago
      db.updateTeam(team.id, { lastEventAt: minutesAgo(6) });

      // Insert a PR with passing CI — normal idle rules apply
      db.insertPullRequest({
        prNumber: 703,
        teamId: team.id,
        title: 'PR #703',
        state: 'open',
        ciStatus: 'passing',
        mergeStatus: 'clean',
        autoMerge: false,
        ciFailCount: 0,
        checksJson: '[]',
      });

      stuckDetector.check();

      // Team should be idle — passing CI does not skip transition
      const result = db.getTeam(team.id)!;
      expect(result.status).toBe('idle');
      expect(sseBroker.broadcast).toHaveBeenCalled();
    });

    it('skips teams with no prNumber for CI check', () => {
      const db = getDatabase();
      const team = db.insertTeam({
        issueNumber: 600,
        worktreeName: 'kea-600',
        status: 'running',
        phase: 'implementing',
        // No prNumber set
      });
      db.updateTeam(team.id, { lastEventAt: minutesAgo(1) });

      stuckDetector.check();

      // No broadcast, no errors
      expect(sseBroker.broadcast).not.toHaveBeenCalled();
    });
  });
});
