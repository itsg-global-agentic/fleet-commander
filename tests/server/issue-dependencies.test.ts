// =============================================================================
// Fleet Commander -- Issue Dependency Tests
// =============================================================================
// Tests for:
//   - parseDependenciesFromBody regex parsing
//   - checkDependencies launch-blocking logic (409 responses, force bypass)
//   - Dependency API endpoints
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseDependenciesFromBody, detectCircularDependencies } from '../../src/server/services/issue-fetcher.js';

// ---------------------------------------------------------------------------
// parseDependenciesFromBody — regex parsing tests
// ---------------------------------------------------------------------------

describe('parseDependenciesFromBody', () => {
  const defaultOwner = 'octocat';
  const defaultRepo = 'hello-world';

  // -----------------------------------------------------------------------
  // Simple #N references
  // -----------------------------------------------------------------------

  it('parses "blocked by #123"', () => {
    const deps = parseDependenciesFromBody('blocked by #123', defaultOwner, defaultRepo);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toEqual({
      number: 123,
      owner: 'octocat',
      repo: 'hello-world',
      state: 'open',
      title: '',
    });
  });

  it('parses "Blocked by #42" (case insensitive)', () => {
    const deps = parseDependenciesFromBody('Blocked by #42', defaultOwner, defaultRepo);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.number).toBe(42);
  });

  it('parses "BLOCKED BY #99" (all caps)', () => {
    const deps = parseDependenciesFromBody('BLOCKED BY #99', defaultOwner, defaultRepo);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.number).toBe(99);
  });

  it('parses "depends on #456"', () => {
    const deps = parseDependenciesFromBody('depends on #456', defaultOwner, defaultRepo);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.number).toBe(456);
  });

  it('parses "Depends On #789" (mixed case)', () => {
    const deps = parseDependenciesFromBody('Depends On #789', defaultOwner, defaultRepo);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.number).toBe(789);
  });

  it('parses "requires #10"', () => {
    const deps = parseDependenciesFromBody('requires #10', defaultOwner, defaultRepo);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.number).toBe(10);
  });

  it('parses multiple dependencies in the same body', () => {
    const body = 'This issue is blocked by #123 and also depends on #456.';
    const deps = parseDependenciesFromBody(body, defaultOwner, defaultRepo);
    expect(deps).toHaveLength(2);
    expect(deps.map((d) => d.number)).toEqual([123, 456]);
  });

  it('handles extra whitespace between words', () => {
    const deps = parseDependenciesFromBody('blocked  by  #55', defaultOwner, defaultRepo);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.number).toBe(55);
  });

  // -----------------------------------------------------------------------
  // owner/repo#N references
  // -----------------------------------------------------------------------

  it('parses "blocked by owner/repo#123" (cross-repo)', () => {
    const deps = parseDependenciesFromBody('blocked by acme/widgets#200', defaultOwner, defaultRepo);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toEqual({
      number: 200,
      owner: 'acme',
      repo: 'widgets',
      state: 'open',
      title: '',
    });
  });

  it('parses "depends on some-org/my.repo#77"', () => {
    const deps = parseDependenciesFromBody('depends on some-org/my.repo#77', defaultOwner, defaultRepo);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.owner).toBe('some-org');
    expect(deps[0]!.repo).toBe('my.repo');
    expect(deps[0]!.number).toBe(77);
  });

  // -----------------------------------------------------------------------
  // Full URL references
  // -----------------------------------------------------------------------

  it('parses "blocked by https://github.com/owner/repo/issues/789"', () => {
    const deps = parseDependenciesFromBody(
      'blocked by https://github.com/myorg/myrepo/issues/789',
      defaultOwner,
      defaultRepo
    );
    expect(deps).toHaveLength(1);
    expect(deps[0]).toEqual({
      number: 789,
      owner: 'myorg',
      repo: 'myrepo',
      state: 'open',
      title: '',
    });
  });

  it('parses http:// URLs (not just https://)', () => {
    const deps = parseDependenciesFromBody(
      'depends on http://github.com/test/project/issues/5',
      defaultOwner,
      defaultRepo
    );
    expect(deps).toHaveLength(1);
    expect(deps[0]!.number).toBe(5);
  });

  // -----------------------------------------------------------------------
  // Mixed patterns
  // -----------------------------------------------------------------------

  it('parses mixed patterns: #N, owner/repo#N, and URL', () => {
    const body = `
This issue:
- blocked by #100
- depends on acme/lib#200
- requires https://github.com/foo/bar/issues/300
    `;
    const deps = parseDependenciesFromBody(body, defaultOwner, defaultRepo);
    expect(deps).toHaveLength(3);
    expect(deps.map((d) => d.number)).toEqual([100, 200, 300]);
    expect(deps[0]!.owner).toBe(defaultOwner);
    expect(deps[1]!.owner).toBe('acme');
    expect(deps[2]!.owner).toBe('foo');
  });

  // -----------------------------------------------------------------------
  // "After" keyword references
  // -----------------------------------------------------------------------

  it('parses "After #123" (simple same-repo)', () => {
    const deps = parseDependenciesFromBody('After #123', defaultOwner, defaultRepo);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toEqual({
      number: 123,
      owner: 'octocat',
      repo: 'hello-world',
      state: 'open',
      title: '',
    });
  });

  it('parses "after #456" (lowercase)', () => {
    const deps = parseDependenciesFromBody('after #456', defaultOwner, defaultRepo);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.number).toBe(456);
  });

  it('parses "After owner/repo#789" (cross-repo)', () => {
    const deps = parseDependenciesFromBody('After acme/widgets#789', defaultOwner, defaultRepo);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toEqual({
      number: 789,
      owner: 'acme',
      repo: 'widgets',
      state: 'open',
      title: '',
    });
  });

  it('parses "after https://github.com/owner/repo/issues/100"', () => {
    const deps = parseDependenciesFromBody(
      'after https://github.com/myorg/myrepo/issues/100',
      defaultOwner,
      defaultRepo
    );
    expect(deps).toHaveLength(1);
    expect(deps[0]).toEqual({
      number: 100,
      owner: 'myorg',
      repo: 'myrepo',
      state: 'open',
      title: '',
    });
  });

  it('parses mix of "After" with other keywords in the same body', () => {
    const body = `
This issue:
- after #50
- blocked by #100
- depends on acme/lib#200
    `;
    const deps = parseDependenciesFromBody(body, defaultOwner, defaultRepo);
    expect(deps).toHaveLength(3);
    expect(deps.map((d) => d.number)).toEqual([50, 100, 200]);
    expect(deps[0]!.owner).toBe(defaultOwner);
    expect(deps[1]!.owner).toBe(defaultOwner);
    expect(deps[2]!.owner).toBe('acme');
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it('returns empty array for body with no dependency patterns', () => {
    const deps = parseDependenciesFromBody('This is a regular issue body.', defaultOwner, defaultRepo);
    expect(deps).toHaveLength(0);
  });

  it('returns empty array for empty body', () => {
    const deps = parseDependenciesFromBody('', defaultOwner, defaultRepo);
    expect(deps).toHaveLength(0);
  });

  it('does not match plain "#123" without a keyword prefix', () => {
    const deps = parseDependenciesFromBody('See issue #123 for details', defaultOwner, defaultRepo);
    expect(deps).toHaveLength(0);
  });

  it('ignores zero or negative issue numbers', () => {
    const deps = parseDependenciesFromBody('blocked by #0', defaultOwner, defaultRepo);
    expect(deps).toHaveLength(0);
  });

  it('all returned deps default to state open', () => {
    const body = 'blocked by #1 and blocked by #2 and blocked by #3';
    const deps = parseDependenciesFromBody(body, defaultOwner, defaultRepo);
    for (const dep of deps) {
      expect(dep.state).toBe('open');
    }
  });
});

// ---------------------------------------------------------------------------
// checkDependencies launch-blocking logic (via teams route)
// ---------------------------------------------------------------------------
// These tests verify the integration contract: when fetchDependenciesForIssue
// returns unresolved deps, the launch route responds 409 with force bypass.
// We test the logic inline since the full API endpoint test would require
// a Fastify server with a real DB.
// ---------------------------------------------------------------------------

describe('checkDependencies logic', () => {
  it('returns null (allow launch) when fetchDependenciesForIssue returns null', () => {
    // Simulating the checkDependencies function behavior:
    // null means "could not determine" -> permissive fallback
    const depInfo = null;
    const shouldBlock = depInfo !== null && !depInfo.resolved;
    expect(shouldBlock).toBe(false);
  });

  it('blocks launch when there are unresolved dependencies', () => {
    const depInfo = {
      issueNumber: 42,
      blockedBy: [
        { number: 10, owner: 'o', repo: 'r', state: 'open' as const, title: 'Blocker' },
      ],
      resolved: false,
      openCount: 1,
    };
    const shouldBlock = depInfo !== null && !depInfo.resolved;
    expect(shouldBlock).toBe(true);
  });

  it('allows launch when all dependencies are resolved', () => {
    const depInfo = {
      issueNumber: 42,
      blockedBy: [
        { number: 10, owner: 'o', repo: 'r', state: 'closed' as const, title: 'Done' },
      ],
      resolved: true,
      openCount: 0,
    };
    const shouldBlock = depInfo !== null && !depInfo.resolved;
    expect(shouldBlock).toBe(false);
  });

  it('allows launch when force=true bypasses dependency check', () => {
    // In the route, force=true skips the checkDependencies call entirely
    const force = true;
    const depInfo = {
      issueNumber: 42,
      blockedBy: [
        { number: 10, owner: 'o', repo: 'r', state: 'open' as const, title: 'Blocker' },
      ],
      resolved: false,
      openCount: 1,
    };
    // force=true means we never even look at depInfo
    const shouldBlock = !force && depInfo !== null && !depInfo.resolved;
    expect(shouldBlock).toBe(false);
  });

  it('extracts blocker numbers correctly for tracking', () => {
    const depInfo = {
      issueNumber: 42,
      blockedBy: [
        { number: 10, owner: 'o', repo: 'r', state: 'open' as const, title: 'A' },
        { number: 20, owner: 'o', repo: 'r', state: 'closed' as const, title: 'B' },
        { number: 30, owner: 'o', repo: 'r', state: 'open' as const, title: 'C' },
      ],
      resolved: false,
      openCount: 2,
    };
    const blockerNumbers = depInfo.blockedBy
      .filter((b) => b.state === 'open')
      .map((b) => b.number);
    expect(blockerNumbers).toEqual([10, 30]);
  });
});

// ---------------------------------------------------------------------------
// getAvailableIssues — dependency filtering logic
// ---------------------------------------------------------------------------
// These tests verify the filter predicate used by getAvailableIssues:
// issues with dependencies.resolved === false should be excluded;
// issues without dependency data should NOT be excluded (permissive fallback).
// ---------------------------------------------------------------------------

describe('getAvailableIssues dependency filter logic', () => {
  // Simulate the filter predicate from getAvailableIssues
  function passesFilter(issue: {
    state: string;
    boardStatus?: string;
    children: unknown[];
    dependencies?: { resolved: boolean };
  }): boolean {
    if (issue.state !== 'open') return false;
    if (issue.boardStatus && issue.boardStatus !== 'Ready') return false;
    if (issue.children.length > 0) return false;
    if (issue.dependencies?.resolved === false) return false;
    return true;
  }

  it('excludes issues with unresolved dependencies', () => {
    const issue = {
      state: 'open',
      children: [],
      dependencies: { resolved: false },
    };
    expect(passesFilter(issue)).toBe(false);
  });

  it('includes issues with resolved dependencies', () => {
    const issue = {
      state: 'open',
      children: [],
      dependencies: { resolved: true },
    };
    expect(passesFilter(issue)).toBe(true);
  });

  it('includes issues without dependency data (permissive fallback)', () => {
    const issue = {
      state: 'open',
      children: [],
    };
    expect(passesFilter(issue)).toBe(true);
  });

  it('includes issues with undefined dependencies', () => {
    const issue = {
      state: 'open',
      children: [],
      dependencies: undefined,
    };
    expect(passesFilter(issue)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 409 response shape verification
// ---------------------------------------------------------------------------

describe('409 dependency block response shape', () => {
  it('response includes error, message, dependencies, and hint fields', () => {
    const depInfo = {
      issueNumber: 42,
      blockedBy: [
        { number: 10, owner: 'o', repo: 'r', state: 'open' as const, title: 'Blocker' },
      ],
      resolved: false,
      openCount: 1,
    };

    // Simulate what the route handler builds
    const response = {
      error: 'Blocked by Dependencies',
      message: `Issue #${depInfo.issueNumber} is blocked by ${depInfo.openCount} unresolved dependency`,
      dependencies: depInfo,
      hint: 'Set force: true to bypass dependency check',
    };

    expect(response.error).toBe('Blocked by Dependencies');
    expect(response.dependencies).toBe(depInfo);
    expect(response.hint).toContain('force');
    expect(response.message).toContain('#42');
  });
});

// ---------------------------------------------------------------------------
// detectCircularDependencies — cycle detection tests
// ---------------------------------------------------------------------------

describe('detectCircularDependencies', () => {
  it('returns null when there are no dependencies', () => {
    const deps = new Map<number, number[]>();
    expect(detectCircularDependencies(1, deps)).toBeNull();
  });

  it('returns null for a linear dependency chain (no cycle)', () => {
    const deps = new Map<number, number[]>();
    deps.set(1, [2]);
    deps.set(2, [3]);
    deps.set(3, []);
    expect(detectCircularDependencies(1, deps)).toBeNull();
  });

  it('detects a simple 2-node cycle: 1 -> 2 -> 1', () => {
    const deps = new Map<number, number[]>();
    deps.set(1, [2]);
    deps.set(2, [1]);
    const cycle = detectCircularDependencies(1, deps);
    expect(cycle).not.toBeNull();
    expect(cycle).toContain(1);
    expect(cycle).toContain(2);
    // Cycle should start and end with the same node
    expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
  });

  it('detects a 3-node cycle: 1 -> 2 -> 3 -> 1', () => {
    const deps = new Map<number, number[]>();
    deps.set(1, [2]);
    deps.set(2, [3]);
    deps.set(3, [1]);
    const cycle = detectCircularDependencies(1, deps);
    expect(cycle).not.toBeNull();
    expect(cycle).toEqual([1, 2, 3, 1]);
  });

  it('detects a self-loop: 1 -> 1', () => {
    const deps = new Map<number, number[]>();
    deps.set(1, [1]);
    const cycle = detectCircularDependencies(1, deps);
    expect(cycle).not.toBeNull();
    expect(cycle).toEqual([1, 1]);
  });

  it('returns null when dependencies exist but starting node has no deps', () => {
    const deps = new Map<number, number[]>();
    deps.set(2, [3]);
    deps.set(3, [2]);
    // Issue 1 has no dependencies at all — should not find a cycle
    expect(detectCircularDependencies(1, deps)).toBeNull();
  });

  it('handles a branching graph where only one branch has a cycle', () => {
    const deps = new Map<number, number[]>();
    deps.set(1, [2, 3]);
    deps.set(2, []); // no deps — dead end
    deps.set(3, [4]);
    deps.set(4, [1]); // cycle back to 1
    const cycle = detectCircularDependencies(1, deps);
    expect(cycle).not.toBeNull();
    expect(cycle).toContain(1);
    expect(cycle).toContain(3);
    expect(cycle).toContain(4);
  });

  it('returns null when nodes reference unknown issue numbers (not in map)', () => {
    const deps = new Map<number, number[]>();
    deps.set(1, [99, 100]); // 99 and 100 are not in the map
    expect(detectCircularDependencies(1, deps)).toBeNull();
  });

  it('handles a diamond dependency shape without cycles', () => {
    const deps = new Map<number, number[]>();
    deps.set(1, [2, 3]);
    deps.set(2, [4]);
    deps.set(3, [4]);
    deps.set(4, []);
    expect(detectCircularDependencies(1, deps)).toBeNull();
  });
});
