// =============================================================================
// Fleet Commander — CC Query Service Tests
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import os from 'os';
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
    ccQueryPrioritizeTimeoutMs: 300000,
    ccQueryMaxRetries: 2,
    ccQueryMaxTurns: 4,
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
  pid: number;
  kill: ReturnType<typeof vi.fn>;
}

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 12345;
  child.kill = vi.fn();
  return child;
}

function emitStdoutAndClose(child: MockChild, stdout: string, code = 0): void {
  child.stdout.emit('data', Buffer.from(stdout));
  child.emit('close', code);
}

/**
 * Set up mockSpawn to return a fresh child for each call, and automatically
 * emit the given stdout + close with the given exit code after a short delay.
 * Returns the list of created children for inspection.
 */
function mockSpawnWithAutoResponse(
  stdout: string,
  code = 0,
  maxCalls = 5,
): MockChild[] {
  const children: MockChild[] = [];
  mockSpawn.mockImplementation(() => {
    const child = createMockChild();
    children.push(child);
    // Emit response asynchronously so the caller can set up listeners first
    setImmediate(() => {
      if (code !== 0) {
        child.stderr.emit('data', Buffer.from(stdout));
        child.emit('close', code);
      } else {
        emitStdoutAndClose(child, stdout, code);
      }
    });
    return child;
  });
  return children;
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

  describe('spawn options', () => {
    it('spawns with stdio: [ignore, pipe, pipe] (no stdin pipe)', async () => {
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
      });

      emitStdoutAndClose(child, ccResponse);
      await resultPromise;

      const spawnCall = mockSpawn.mock.calls[0];
      const spawnOpts = spawnCall[2];
      expect(spawnOpts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    });

    it('spawns with cwd set to os.tmpdir()', async () => {
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
      });

      emitStdoutAndClose(child, ccResponse);
      await resultPromise;

      const spawnCall = mockSpawn.mock.calls[0];
      const spawnOpts = spawnCall[2];
      expect(spawnOpts.cwd).toBe(os.tmpdir());
    });

    it('uses config ccQueryMaxTurns for --max-turns arg', async () => {
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
      });

      emitStdoutAndClose(child, ccResponse);
      await resultPromise;

      const spawnCall = mockSpawn.mock.calls[0];
      const args: string[] = spawnCall[1];
      const maxTurnsIdx = args.indexOf('--max-turns');
      expect(maxTurnsIdx).toBeGreaterThan(-1);
      expect(args[maxTurnsIdx + 1]).toBe('4');
    });
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
      const failResponse = JSON.stringify({
        type: 'result',
        result: '',
        total_cost_usd: 0.01,
      });

      // Auto-respond for all retry attempts
      mockSpawnWithAutoResponse(failResponse);

      const service = CCQueryService.getInstance();
      const result = await service.estimateComplexity('Fix bug', 'Body');

      expect(result.success).toBe(false);
      expect(result.data).toBeUndefined();
      expect(result.error).toContain('CC returned no structured data');
    }, 15000);
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
      // Use auto-response since retries will fire for this transient failure
      mockSpawnWithAutoResponse('Not valid JSON at all');

      const service = CCQueryService.getInstance();
      const result = await service.estimateComplexity('Test', 'Body');

      expect(result.success).toBe(false);
      expect(result.text).toBe('Not valid JSON at all');
      expect(result.data).toBeUndefined();
      expect(result.error).toContain('CC returned no structured data');
    }, 15000);

    it('returns success:false when CC returns JSON without structured_output', async () => {
      const failResponse = JSON.stringify({
        type: 'result',
        result: 'Some plain text response',
        total_cost_usd: 0.02,
      });

      mockSpawnWithAutoResponse(failResponse);

      const service = CCQueryService.getInstance();
      const result = await service.estimateComplexity('Test', 'Body');

      expect(result.success).toBe(false);
      expect(result.error).toContain('CC returned no structured data');
      expect(result.text).toBe('Some plain text response');
    }, 15000);
  });

  describe('JSON prefix stripping', () => {
    it('strips non-JSON prefix lines before parsing', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const service = CCQueryService.getInstance();
      const resultPromise = service.estimateComplexity('Test', 'Body');

      const jsonPayload = JSON.stringify({
        type: 'result',
        result: '',
        structured_output: {
          complexity: 'medium',
          estimatedHours: 3,
          reason: 'Moderate complexity',
          risks: ['risk1'],
        },
        total_cost_usd: 0.05,
      });

      // Simulate CC emitting warning text before the JSON
      const stdoutWithPrefix = 'Warning: some debug output\nAnother line\n' + jsonPayload;

      emitStdoutAndClose(child, stdoutWithPrefix);

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        complexity: 'medium',
        estimatedHours: 3,
        reason: 'Moderate complexity',
        risks: ['risk1'],
      });
    });

    it('handles stdout that is entirely non-JSON (no brace found)', async () => {
      mockSpawnWithAutoResponse('Just plain text with no JSON');

      const service = CCQueryService.getInstance();
      const result = await service.estimateComplexity('Test', 'Body');

      expect(result.success).toBe(false);
      expect(result.error).toContain('CC returned no structured data');
    }, 15000);
  });

  describe('retry logic', () => {
    it('retries on transient "no structured data" failure and succeeds', async () => {
      const failResponse = JSON.stringify({
        type: 'result',
        result: '',
        total_cost_usd: 0.01,
      });

      const successResponse = JSON.stringify({
        type: 'result',
        result: '',
        structured_output: {
          complexity: 'high',
          estimatedHours: 8,
          reason: 'Complex',
          risks: ['many risks'],
        },
        total_cost_usd: 0.03,
      });

      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        callCount++;
        const child = createMockChild();
        setImmediate(() => {
          if (callCount === 1) {
            emitStdoutAndClose(child, failResponse);
          } else {
            emitStdoutAndClose(child, successResponse);
          }
        });
        return child;
      });

      const service = CCQueryService.getInstance();
      const result = await service.estimateComplexity('Test', 'Body');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        complexity: 'high',
        estimatedHours: 8,
        reason: 'Complex',
        risks: ['many risks'],
      });
      expect(callCount).toBe(2);
    }, 15000);

    it('does NOT retry on non-zero exit code', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const service = CCQueryService.getInstance();
      const resultPromise = service.estimateComplexity('Test', 'Body');

      child.stderr.emit('data', Buffer.from('error'));
      child.emit('close', 1);

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('CC exited with code 1');
      // Should only have spawned once — no retry on non-zero exit
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry on spawn errors', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const service = CCQueryService.getInstance();
      const resultPromise = service.estimateComplexity('Test', 'Body');

      // Simulate spawn error
      child.emit('error', new Error('ENOENT'));

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to spawn CC');
      // Should only have spawned once — no retry on spawn error
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('exhausts retries and returns last failure', async () => {
      const failResponse = JSON.stringify({
        type: 'result',
        result: '',
        total_cost_usd: 0.01,
      });

      const children = mockSpawnWithAutoResponse(failResponse);

      const service = CCQueryService.getInstance();
      const result = await service.estimateComplexity('Test', 'Body');

      expect(result.success).toBe(false);
      expect(result.error).toContain('CC returned no structured data');
      // 1 initial + 2 retries = 3 total
      expect(mockSpawn).toHaveBeenCalledTimes(3);
    }, 15000);
  });

  describe('improved error diagnostics', () => {
    it('includes subtype and stop_reason in error for no structured data', async () => {
      const ccResponse = JSON.stringify({
        type: 'result',
        subtype: 'max_turns',
        stop_reason: 'max_turns_reached',
        result: 'Some text but no structured output',
        total_cost_usd: 0.02,
      });

      mockSpawnWithAutoResponse(ccResponse);

      const service = CCQueryService.getInstance();
      const result = await service.estimateComplexity('Test', 'Body');

      expect(result.success).toBe(false);
      expect(result.error).toContain('subtype=max_turns');
      expect(result.error).toContain('stop_reason=max_turns_reached');
    }, 15000);

    it('includes stdout snippet in error message', async () => {
      const ccResponse = JSON.stringify({
        type: 'result',
        result: '',
        total_cost_usd: 0.01,
      });

      mockSpawnWithAutoResponse(ccResponse);

      const service = CCQueryService.getInstance();
      const result = await service.estimateComplexity('Test', 'Body');

      expect(result.success).toBe(false);
      expect(result.error).toContain('stdout=');
    }, 15000);

    it('includes stdout snippet in error when JSON parsing fails', async () => {
      mockSpawnWithAutoResponse('Completely invalid output');

      const service = CCQueryService.getInstance();
      const result = await service.estimateComplexity('Test', 'Body');

      expect(result.success).toBe(false);
      expect(result.error).toContain('stdout=');
      expect(result.error).toContain('Completely invalid output');
    }, 15000);
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
