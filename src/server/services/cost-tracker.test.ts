// =============================================================================
// Fleet Commander — Cost Tracker Service Tests
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getDatabase, closeDatabase } from '../db.js';

// Mock the SSE broker before importing cost-tracker
vi.mock('./sse-broker.js', () => ({
  sseBroker: {
    broadcast: vi.fn(),
  },
}));

// Import after mocking
import { processCostFromEvent } from './cost-tracker.js';
import { sseBroker } from './sse-broker.js';

const TEST_DB_PATH = path.join(process.cwd(), 'test-cost-tracker.db');

function cleanupDb(): void {
  for (const f of [TEST_DB_PATH, TEST_DB_PATH + '-wal', TEST_DB_PATH + '-shm']) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

beforeEach(() => {
  cleanupDb();
  closeDatabase();
  const db = getDatabase(TEST_DB_PATH);
  // Insert a team for cost entries to reference
  db.insertTeam({
    issueNumber: 100,
    worktreeName: 'kea-100',
    status: 'running',
    phase: 'implementing',
  });
  vi.mocked(sseBroker.broadcast).mockClear();
});

afterEach(() => {
  closeDatabase();
  cleanupDb();
});

describe('processCostFromEvent', () => {
  describe('cost extraction from top-level fields', () => {
    it('inserts a cost entry when top-level cost fields are present', () => {
      const db = getDatabase();

      processCostFromEvent(1, 'session-abc', {
        input_tokens: 1000,
        output_tokens: 500,
        cost_usd: 0.05,
      });

      const summary = db.getCostByTeam(1);
      expect(summary.totalCostUsd).toBe(0.05);
      expect(summary.totalInputTokens).toBe(1000);
      expect(summary.totalOutputTokens).toBe(500);
      expect(summary.entryCount).toBe(1);
    });

    it('handles partial top-level cost data (only tokens, no cost)', () => {
      const db = getDatabase();

      processCostFromEvent(1, 'session-abc', {
        input_tokens: 2000,
        output_tokens: 1000,
      });

      const summary = db.getCostByTeam(1);
      expect(summary.totalInputTokens).toBe(2000);
      expect(summary.totalOutputTokens).toBe(1000);
      expect(summary.totalCostUsd).toBe(0);
      expect(summary.entryCount).toBe(1);
    });

    it('handles partial top-level cost data (only cost_usd)', () => {
      const db = getDatabase();

      processCostFromEvent(1, 'session-abc', {
        cost_usd: 0.12,
      });

      const summary = db.getCostByTeam(1);
      expect(summary.totalCostUsd).toBe(0.12);
      expect(summary.totalInputTokens).toBe(0);
      expect(summary.totalOutputTokens).toBe(0);
    });
  });

  describe('cost extraction from nested usage object', () => {
    it('extracts cost from nested usage when top-level fields are absent', () => {
      const db = getDatabase();

      processCostFromEvent(1, 'session-abc', {
        usage: {
          input_tokens: 3000,
          output_tokens: 1500,
          cost_usd: 0.10,
        },
      });

      const summary = db.getCostByTeam(1);
      expect(summary.totalInputTokens).toBe(3000);
      expect(summary.totalOutputTokens).toBe(1500);
      expect(summary.totalCostUsd).toBe(0.10);
    });

    it('prefers top-level fields over nested usage', () => {
      const db = getDatabase();

      processCostFromEvent(1, 'session-abc', {
        input_tokens: 100,
        output_tokens: 50,
        cost_usd: 0.01,
        usage: {
          input_tokens: 9999,
          output_tokens: 9999,
          cost_usd: 9.99,
        },
      });

      const summary = db.getCostByTeam(1);
      // Top-level values should win
      expect(summary.totalInputTokens).toBe(100);
      expect(summary.totalOutputTokens).toBe(50);
      expect(summary.totalCostUsd).toBe(0.01);
    });

    it('mixes top-level and nested fields', () => {
      const db = getDatabase();

      processCostFromEvent(1, 'session-abc', {
        input_tokens: 500,
        // output_tokens missing at top level
        usage: {
          output_tokens: 250,
          cost_usd: 0.03,
        },
      });

      const summary = db.getCostByTeam(1);
      expect(summary.totalInputTokens).toBe(500);
      expect(summary.totalOutputTokens).toBe(250);
      expect(summary.totalCostUsd).toBe(0.03);
    });
  });

  describe('graceful handling of missing cost data', () => {
    it('no-ops when payload has no cost fields at all', () => {
      const db = getDatabase();

      processCostFromEvent(1, 'session-abc', {
        event: 'session_end',
        team: 'kea-100',
      });

      const summary = db.getCostByTeam(1);
      expect(summary.entryCount).toBe(0);
      expect(sseBroker.broadcast).not.toHaveBeenCalled();
    });

    it('no-ops when cost fields are non-numeric', () => {
      const db = getDatabase();

      processCostFromEvent(1, 'session-abc', {
        input_tokens: 'not-a-number',
        output_tokens: null,
        cost_usd: undefined,
      });

      const summary = db.getCostByTeam(1);
      expect(summary.entryCount).toBe(0);
      expect(sseBroker.broadcast).not.toHaveBeenCalled();
    });

    it('no-ops when usage object has non-numeric fields', () => {
      const db = getDatabase();

      processCostFromEvent(1, 'session-abc', {
        usage: {
          input_tokens: 'bad',
          output_tokens: false,
        },
      });

      const summary = db.getCostByTeam(1);
      expect(summary.entryCount).toBe(0);
      expect(sseBroker.broadcast).not.toHaveBeenCalled();
    });

    it('handles empty payload object', () => {
      const db = getDatabase();

      processCostFromEvent(1, 'session-abc', {});

      const summary = db.getCostByTeam(1);
      expect(summary.entryCount).toBe(0);
      expect(sseBroker.broadcast).not.toHaveBeenCalled();
    });
  });

  describe('session ID handling', () => {
    it('uses "unknown" when sessionId is undefined', () => {
      processCostFromEvent(1, undefined, {
        cost_usd: 0.05,
      });

      const db = getDatabase();
      const summary = db.getCostByTeam(1);
      expect(summary.entryCount).toBe(1);
    });

    it('uses "unknown" when sessionId is empty string', () => {
      processCostFromEvent(1, '', {
        cost_usd: 0.05,
      });

      const db = getDatabase();
      const summary = db.getCostByTeam(1);
      expect(summary.entryCount).toBe(1);
    });
  });

  describe('SSE broadcasting', () => {
    it('broadcasts cost_updated event with team totals', () => {
      processCostFromEvent(1, 'session-abc', {
        input_tokens: 1000,
        output_tokens: 500,
        cost_usd: 0.05,
      });

      expect(sseBroker.broadcast).toHaveBeenCalledWith(
        'cost_updated',
        expect.objectContaining({
          team_id: 1,
          total_cost_usd: 0.05,
          total_input_tokens: 1000,
          total_output_tokens: 500,
        }),
        1,
      );
    });

    it('broadcasts cumulative totals after multiple cost entries', () => {
      processCostFromEvent(1, 'session-1', {
        input_tokens: 1000,
        output_tokens: 500,
        cost_usd: 0.05,
      });

      processCostFromEvent(1, 'session-2', {
        input_tokens: 2000,
        output_tokens: 1000,
        cost_usd: 0.10,
      });

      // Second broadcast should have cumulative totals
      expect(sseBroker.broadcast).toHaveBeenCalledTimes(2);
      const lastCall = vi.mocked(sseBroker.broadcast).mock.calls[1]!;
      expect(lastCall[0]).toBe('cost_updated');
      const data = lastCall[1] as Record<string, unknown>;
      expect(data.team_id).toBe(1);
      expect(data.total_input_tokens).toBe(3000);
      expect(data.total_output_tokens).toBe(1500);
      expect(data.total_cost_usd as number).toBeCloseTo(0.15, 10);
      expect(lastCall[2]).toBe(1);
    });

    it('scopes broadcast to the correct team ID', () => {
      processCostFromEvent(1, 'session-abc', {
        cost_usd: 0.05,
      });

      // Third argument to broadcast is the teamId for filtering
      expect(sseBroker.broadcast).toHaveBeenCalledWith(
        'cost_updated',
        expect.anything(),
        1,
      );
    });
  });
});
