// =============================================================================
// Fleet Commander — CC Query Service Tests
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

// ---------------------------------------------------------------------------
// Mock child_process.spawn before importing the module under test
// ---------------------------------------------------------------------------

const mockSpawn = vi.fn();

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock('../../src/server/config.js', () => ({
  default: {
    ccQueryModel: 'claude-sonnet-4-20250514',
    ccQueryTimeoutMs: 60000,
    ccQueryPrioritizeTimeoutMs: 60000,
  },
}));

vi.mock('../../src/server/utils/resolve-claude-path.js', () => ({
  resolveClaudePath: () => 'claude',
}));

vi.mock('../../src/server/utils/find-git-bash.js', () => ({
  findGitBash: () => null,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: ReturnType<typeof vi.fn> };
  pid: number;
  kill: ReturnType<typeof vi.fn>;
}

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.pid = 12345;
  child.kill = vi.fn();
  return child;
}

function emitStdoutAndClose(child: MockChild, stdout: string, code = 0): void {
  child.stdout.emit('data', Buffer.from(stdout));
  child.emit('close', code);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CCQueryService', () => {
  let CCQueryService: typeof import('../../src/server/services/cc-query.js').CCQueryService;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset the singleton between tests
    const mod = await import('../../src/server/services/cc-query.js');
    CCQueryService = mod.CCQueryService;
    // Clear the singleton instance via private access
    (CCQueryService as unknown as { _instance: null })._instance = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('structured_output parsing', () => {
    it('reads structured_output when present (--json-schema response)', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const service = CCQueryService.getInstance();
      const resultPromise = service.prioritizeIssues([
        { number: 1, title: 'Fix bug' },
      ]);

      const ccResponse = JSON.stringify({
        type: 'result',
        result: '',
        structured_output: {
          items: [
            { number: 1, title: 'Fix bug', priority: 2, category: 'bug', reason: 'Critical' },
          ],
        },
        total_cost_usd: 0.05,
        duration_ms: 1200,
      });

      emitStdoutAndClose(child, ccResponse);

      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.data).toEqual([
        { number: 1, title: 'Fix bug', priority: 2, category: 'bug', reason: 'Critical' },
      ]);
      expect(result.costUsd).toBe(0.05);
    });

    it('falls back to parsing result text when structured_output is absent', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const service = CCQueryService.getInstance();
      const resultPromise = service.estimateComplexity('Fix bug', 'Some body');

      const ccResponse = JSON.stringify({
        type: 'result',
        result: JSON.stringify({
          complexity: 'low',
          estimatedHours: 1,
          reason: 'Simple fix',
          risks: [],
        }),
        total_cost_usd: 0.03,
      });

      emitStdoutAndClose(child, ccResponse);

      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        complexity: 'low',
        estimatedHours: 1,
        reason: 'Simple fix',
        risks: [],
      });
      expect(result.costUsd).toBe(0.03);
    });

    it('returns success:false when result is empty and no structured_output', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const service = CCQueryService.getInstance();
      const resultPromise = service.estimateComplexity('Fix bug', 'Body');

      const ccResponse = JSON.stringify({
        type: 'result',
        result: '',
        total_cost_usd: 0.01,
      });

      emitStdoutAndClose(child, ccResponse);

      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.data).toBeUndefined();
      expect(result.error).toBe('CC returned no structured data');
    });
  });

  describe('cost field parsing', () => {
    it('reads total_cost_usd correctly', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const service = CCQueryService.getInstance();
      const resultPromise = service.estimateComplexity('Test', 'Body');

      const ccResponse = JSON.stringify({
        type: 'result',
        result: '',
        structured_output: {
          complexity: 'low',
          estimatedHours: 1,
          reason: 'Test',
          risks: [],
        },
        total_cost_usd: 0.12,
      });

      emitStdoutAndClose(child, ccResponse);

      const result = await resultPromise;
      expect(result.costUsd).toBe(0.12);
    });

    it('defaults cost to 0 when total_cost_usd is missing', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const service = CCQueryService.getInstance();
      const resultPromise = service.estimateComplexity('Test', 'Body');

      const ccResponse = JSON.stringify({
        type: 'result',
        result: '',
        structured_output: {
          complexity: 'low',
          estimatedHours: 1,
          reason: 'Test',
          risks: [],
        },
      });

      emitStdoutAndClose(child, ccResponse);

      const result = await resultPromise;
      expect(result.costUsd).toBe(0);
    });
  });

  describe('duration_ms from CC response', () => {
    it('uses duration_ms from CC response when present', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const service = CCQueryService.getInstance();
      const resultPromise = service.estimateComplexity('Test', 'Body');

      const ccResponse = JSON.stringify({
        type: 'result',
        result: '',
        structured_output: {
          complexity: 'low',
          estimatedHours: 1,
          reason: 'Test',
          risks: [],
        },
        total_cost_usd: 0.01,
        duration_ms: 5000,
      });

      emitStdoutAndClose(child, ccResponse);

      const result = await resultPromise;
      expect(result.durationMs).toBe(5000);
    });
  });

  describe('error handling', () => {
    it('resolves with error on non-zero exit code', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const service = CCQueryService.getInstance();
      const resultPromise = service.estimateComplexity('Test', 'Body');

      child.stderr.emit('data', Buffer.from('Something went wrong'));
      child.emit('close', 1);

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('CC exited with code 1');
    });

    it('returns success:false when stdout is not valid JSON', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const service = CCQueryService.getInstance();
      const resultPromise = service.estimateComplexity('Test', 'Body');

      emitStdoutAndClose(child, 'Not valid JSON at all');

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.text).toBe('Not valid JSON at all');
      expect(result.data).toBeUndefined();
      expect(result.error).toBe('CC returned no structured data');
    });

    it('returns success:false when CC returns JSON without structured_output', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const service = CCQueryService.getInstance();
      const resultPromise = service.estimateComplexity('Test', 'Body');

      const ccResponse = JSON.stringify({
        type: 'result',
        result: 'Some plain text response',
        total_cost_usd: 0.02,
      });

      emitStdoutAndClose(child, ccResponse);

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('CC returned no structured data');
      expect(result.text).toBe('Some plain text response');
    });
  });

  describe('prioritizeIssues items guard', () => {
    it('returns error when items is not an array', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const service = CCQueryService.getInstance();
      const resultPromise = service.prioritizeIssues([
        { number: 1, title: 'Test issue' },
      ]);

      // CC returns structured_output but items is not an array
      const ccResponse = JSON.stringify({
        type: 'result',
        result: '',
        structured_output: {
          items: 'not an array',
        },
        total_cost_usd: 0.01,
      });

      emitStdoutAndClose(child, ccResponse);

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('CC returned unexpected structure: expected { items: [...] }');
      expect(result.data).toBeUndefined();
    });

    it('returns error when structured_output has no items field', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const service = CCQueryService.getInstance();
      const resultPromise = service.prioritizeIssues([
        { number: 1, title: 'Test issue' },
      ]);

      // CC returns structured_output without items
      const ccResponse = JSON.stringify({
        type: 'result',
        result: '',
        structured_output: {
          something: 'else',
        },
        total_cost_usd: 0.01,
      });

      emitStdoutAndClose(child, ccResponse);

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('CC returned unexpected structure: expected { items: [...] }');
    });

    it('succeeds when items IS a valid array', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const service = CCQueryService.getInstance();
      const resultPromise = service.prioritizeIssues([
        { number: 10, title: 'Add feature' },
        { number: 20, title: 'Fix bug' },
      ]);

      const ccResponse = JSON.stringify({
        type: 'result',
        result: '',
        structured_output: {
          items: [
            { number: 10, title: 'Add feature', priority: 5, category: 'feature', reason: 'Nice to have' },
            { number: 20, title: 'Fix bug', priority: 1, category: 'bug', reason: 'Urgent' },
          ],
        },
        total_cost_usd: 0.04,
        duration_ms: 2000,
      });

      emitStdoutAndClose(child, ccResponse);

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(result.data).toEqual([
        { number: 10, title: 'Add feature', priority: 5, category: 'feature', reason: 'Nice to have' },
        { number: 20, title: 'Fix bug', priority: 1, category: 'bug', reason: 'Urgent' },
      ]);
      expect(result.costUsd).toBe(0.04);
      expect(result.durationMs).toBe(2000);
    });
  });
});
