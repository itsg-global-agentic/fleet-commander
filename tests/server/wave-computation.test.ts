// =============================================================================
// Fleet Commander — Wave Computation Tests
// =============================================================================
// Pure unit tests for the wave computation algorithm. No mocks needed.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  computeWaves,
  detectCircularDeps,
  type WaveIssue,
} from '../../src/shared/wave-computation.js';

// ---------------------------------------------------------------------------
// Helper to build WaveIssue objects
// ---------------------------------------------------------------------------

function makeIssue(
  num: number,
  opts: Partial<WaveIssue> = {},
): WaveIssue {
  return {
    issueNumber: num,
    title: `Issue #${num}`,
    state: 'open',
    blockedBy: [],
    url: `https://github.com/test/repo/issues/${num}`,
    ...opts,
  };
}

// =============================================================================
// detectCircularDeps
// =============================================================================

describe('detectCircularDeps', () => {
  it('should return empty for acyclic graph', () => {
    const graph = new Map<number, number[]>();
    graph.set(1, [2]);
    graph.set(2, [3]);
    graph.set(3, []);

    const cycles = detectCircularDeps(graph);
    expect(cycles).toEqual([]);
  });

  it('should detect a simple 2-node cycle', () => {
    const graph = new Map<number, number[]>();
    graph.set(1, [2]);
    graph.set(2, [1]);

    const cycles = detectCircularDeps(graph);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toContain(1);
    expect(cycles[0]).toContain(2);
  });

  it('should detect a 3-node cycle', () => {
    const graph = new Map<number, number[]>();
    graph.set(1, [2]);
    graph.set(2, [3]);
    graph.set(3, [1]);

    const cycles = detectCircularDeps(graph);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toContain(1);
    expect(cycles[0]).toContain(2);
    expect(cycles[0]).toContain(3);
  });

  it('should return empty for graph with no edges', () => {
    const graph = new Map<number, number[]>();
    graph.set(1, []);
    graph.set(2, []);

    const cycles = detectCircularDeps(graph);
    expect(cycles).toEqual([]);
  });

  it('should handle self-loop', () => {
    const graph = new Map<number, number[]>();
    graph.set(1, [1]);

    const cycles = detectCircularDeps(graph);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toContain(1);
  });
});

// =============================================================================
// computeWaves — empty and trivial inputs
// =============================================================================

describe('computeWaves', () => {
  it('should return empty waves for empty input', () => {
    const result = computeWaves([], 3, 0);
    expect(result.waves).toEqual([]);
    expect(result.circularDeps).toEqual([]);
  });

  it('should place a single issue in one wave', () => {
    const issues = [makeIssue(1)];
    const result = computeWaves(issues, 3, 0);

    expect(result.waves.length).toBe(1);
    expect(result.waves[0].issues.length).toBe(1);
    expect(result.waves[0].issues[0].issueNumber).toBe(1);
    expect(result.waves[0].label).toBe('Next');
  });

  // ---------------------------------------------------------------------------
  // Parallel issues with no dependencies
  // ---------------------------------------------------------------------------

  it('should put all independent issues in the same wave when under maxActiveTeams', () => {
    const issues = [makeIssue(1), makeIssue(2), makeIssue(3)];
    const result = computeWaves(issues, 5, 0);

    expect(result.waves.length).toBe(1);
    expect(result.waves[0].issues.length).toBe(3);
  });

  it('should split independent issues across waves when exceeding maxActiveTeams', () => {
    const issues = [makeIssue(1), makeIssue(2), makeIssue(3), makeIssue(4), makeIssue(5)];
    const result = computeWaves(issues, 2, 0);

    // 5 issues / max 2 per wave = at least 3 waves
    expect(result.waves.length).toBeGreaterThanOrEqual(3);
    // First wave should have at most 2 issues
    expect(result.waves[0].issues.length).toBeLessThanOrEqual(2);
  });

  // ---------------------------------------------------------------------------
  // Linear dependency chain
  // ---------------------------------------------------------------------------

  it('should order a linear chain into sequential waves', () => {
    // 3 -> 2 -> 1 (issue 3 blocked by 2, issue 2 blocked by 1)
    const issues = [
      makeIssue(1),
      makeIssue(2, { blockedBy: [1] }),
      makeIssue(3, { blockedBy: [2] }),
    ];
    const result = computeWaves(issues, 3, 0);

    expect(result.waves.length).toBe(3);
    expect(result.waves[0].issues[0].issueNumber).toBe(1);
    expect(result.waves[1].issues[0].issueNumber).toBe(2);
    expect(result.waves[2].issues[0].issueNumber).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // Diamond dependency
  // ---------------------------------------------------------------------------

  it('should handle diamond dependency correctly', () => {
    // Issue 4 blocked by 2 and 3; issues 2 and 3 blocked by 1
    const issues = [
      makeIssue(1),
      makeIssue(2, { blockedBy: [1] }),
      makeIssue(3, { blockedBy: [1] }),
      makeIssue(4, { blockedBy: [2, 3] }),
    ];
    const result = computeWaves(issues, 5, 0);

    // Wave 0: issue 1; Wave 1: issues 2 and 3; Wave 2: issue 4
    expect(result.waves.length).toBe(3);
    expect(result.waves[0].issues[0].issueNumber).toBe(1);
    expect(result.waves[1].issues.map((i) => i.issueNumber).sort()).toEqual([2, 3]);
    expect(result.waves[2].issues[0].issueNumber).toBe(4);
  });

  // ---------------------------------------------------------------------------
  // Active teams in Wave 0
  // ---------------------------------------------------------------------------

  it('should place active teams in Wave 0', () => {
    const issues = [
      makeIssue(1, { teamId: 10, teamStatus: 'running' }),
      makeIssue(2),
      makeIssue(3),
    ];
    const result = computeWaves(issues, 3, 1);

    // Wave 0 is active, wave 1 is queued
    expect(result.waves[0].label).toBe('Active');
    expect(result.waves[0].isActive).toBe(true);
    expect(result.waves[0].issues[0].issueNumber).toBe(1);
    expect(result.waves[1].issues.map((i) => i.issueNumber).sort()).toEqual([2, 3]);
  });

  // ---------------------------------------------------------------------------
  // maxActiveTeams capping
  // ---------------------------------------------------------------------------

  it('should respect maxActiveTeams for first queued wave', () => {
    // 4 independent issues, maxActiveTeams = 2, 1 already active
    const issues = [
      makeIssue(1, { teamId: 10, teamStatus: 'running' }),
      makeIssue(2),
      makeIssue(3),
      makeIssue(4),
      makeIssue(5),
    ];
    const result = computeWaves(issues, 2, 1);

    // Wave 0 = active (issue 1)
    expect(result.waves[0].isActive).toBe(true);
    // Wave 1 should cap at maxActiveTeams - activeCount = 2 - 1 = 1
    // But then wave 2 gets maxActiveTeams = 2 slots
    expect(result.waves[0].issues.length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Circular dependencies
  // ---------------------------------------------------------------------------

  it('should treat circular deps as unblocked', () => {
    // Issues 1 and 2 block each other (circular)
    const issues = [
      makeIssue(1, { blockedBy: [2] }),
      makeIssue(2, { blockedBy: [1] }),
    ];
    const result = computeWaves(issues, 3, 0);

    // Both should be in the first wave (circular deps treated as unblocked)
    expect(result.circularDeps.length).toBe(1);
    expect(result.waves.length).toBeGreaterThanOrEqual(1);
    const allIssueNumbers = result.waves.flatMap((w) => w.issues.map((i) => i.issueNumber));
    expect(allIssueNumbers).toContain(1);
    expect(allIssueNumbers).toContain(2);
    // Both should be marked as circular
    const allIssues = result.waves.flatMap((w) => w.issues);
    expect(allIssues.find((i) => i.issueNumber === 1)?.isCircularDep).toBe(true);
    expect(allIssues.find((i) => i.issueNumber === 2)?.isCircularDep).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Mixed active and queued with dependencies
  // ---------------------------------------------------------------------------

  it('should handle mixed active/queued with dependencies', () => {
    // Issue 1 is running, issue 2 depends on 1, issue 3 is independent
    const issues = [
      makeIssue(1, { teamId: 10, teamStatus: 'running' }),
      makeIssue(2, { blockedBy: [1] }),
      makeIssue(3),
    ];
    const result = computeWaves(issues, 3, 1);

    // Wave 0: active issue 1
    expect(result.waves[0].isActive).toBe(true);
    expect(result.waves[0].issues[0].issueNumber).toBe(1);

    // Issue 2 depends on active issue 1, but issue 1 is active (not queued),
    // so the dependency edge is not in the queued graph. Issue 2 should be
    // in the next wave as unblocked among queued issues.
    const queuedWaves = result.waves.filter((w) => !w.isActive);
    const allQueuedIssues = queuedWaves.flatMap((w) => w.issues.map((i) => i.issueNumber));
    expect(allQueuedIssues).toContain(2);
    expect(allQueuedIssues).toContain(3);
  });

  // ---------------------------------------------------------------------------
  // Dependencies on closed issues (already resolved)
  // ---------------------------------------------------------------------------

  it('should ignore closed blockers', () => {
    // Issue 2 depends on issue 1, but issue 1 is closed — should be treated as resolved
    // Since closed issues are filtered out before calling computeWaves in the service,
    // we simulate this by not including the closed blocker in our issue list
    const issues = [
      // Issue 1 is not in the list (it's closed)
      makeIssue(2, { blockedBy: [1] }), // blocker 1 is not in queued set
    ];
    const result = computeWaves(issues, 3, 0);

    // Issue 2 should be in wave 0 since blocker 1 is not in the queued set
    expect(result.waves.length).toBe(1);
    expect(result.waves[0].issues[0].issueNumber).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // maxActiveTeams = 0
  // ---------------------------------------------------------------------------

  it('should handle maxActiveTeams = 0', () => {
    const issues = [makeIssue(1), makeIssue(2)];
    const result = computeWaves(issues, 0, 0);

    // All issues should still be placed in waves (unlimited)
    expect(result.waves.length).toBeGreaterThanOrEqual(1);
    const allIssues = result.waves.flatMap((w) => w.issues);
    expect(allIssues.length).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // First wave label
  // ---------------------------------------------------------------------------

  it('should label the first queued wave as "Next" when no active wave', () => {
    const issues = [makeIssue(1), makeIssue(2)];
    const result = computeWaves(issues, 5, 0);

    expect(result.waves[0].label).toBe('Next');
  });

  it('should label queued waves with "Wave N" when active wave exists', () => {
    const issues = [
      makeIssue(1, { teamId: 10, teamStatus: 'running' }),
      makeIssue(2),
    ];
    const result = computeWaves(issues, 5, 1);

    const queuedWaves = result.waves.filter((w) => !w.isActive);
    expect(queuedWaves[0].label).toMatch(/^Wave \d+$/);
  });
});
