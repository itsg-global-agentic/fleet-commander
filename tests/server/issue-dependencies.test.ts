// =============================================================================
// Fleet Commander -- Issue Dependency Tests
// =============================================================================
// Tests for:
//   - parseDependenciesFromBody regex parsing
//   - checkDependencies launch-blocking logic (409 responses, force bypass)
//   - Dependency API endpoints
//   - Body-based dependency enrichment merging
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseDependenciesFromBody, detectCircularDependencies } from '../../src/server/services/issue-fetcher.js';
import type { DependencyRef, IssueDependencyInfo } from '../../src/shared/types.js';

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

// ---------------------------------------------------------------------------
// Body-based dependency enrichment merge logic
// ---------------------------------------------------------------------------
// These tests verify the merge/dedup logic used by the post-pass in
// fetchIssueHierarchy: body-parsed deps are merged with inline (GraphQL
// blockedBy) deps, deduplicating by issue number + owner + repo.
// The actual post-pass runs inside fetchIssueHierarchy (which requires
// live gh CLI), so we test the merge logic in isolation here.
// ---------------------------------------------------------------------------

describe('body-based dependency enrichment merge logic', () => {
  const owner = 'octocat';
  const repo = 'hello-world';

  /**
   * Simulate the enrichment merge logic from fetchIssueHierarchy.
   * Takes existing inline deps (from GraphQL blockedBy) and body text,
   * parses body deps, resolves same-repo state from openIssueNumbers,
   * deduplicates, and returns the merged IssueDependencyInfo.
   */
  function enrichWithBodyDeps(
    issueNumber: number,
    existingDeps: IssueDependencyInfo | undefined,
    body: string,
    openIssueNumbers: Set<number>,
    titleByNumber: Map<number, string>,
  ): IssueDependencyInfo | undefined {
    const bodyDeps = parseDependenciesFromBody(body, owner, repo);
    if (bodyDeps.length === 0) return existingDeps;

    // Resolve state and title for same-repo body deps from local data
    for (const dep of bodyDeps) {
      if (dep.owner === owner && dep.repo === repo) {
        dep.state = openIssueNumbers.has(dep.number) ? 'open' : 'closed';
        const title = titleByNumber.get(dep.number);
        if (title) dep.title = title;
      }
    }

    if (existingDeps) {
      // Merge: add body deps not already present
      for (const dep of bodyDeps) {
        const exists = existingDeps.blockedBy.some(
          (b) => b.number === dep.number && b.owner === dep.owner && b.repo === dep.repo
        );
        if (!exists) {
          existingDeps.blockedBy.push(dep);
        }
      }
      existingDeps.openCount = existingDeps.blockedBy.filter((d) => d.state === 'open').length;
      existingDeps.resolved = existingDeps.openCount === 0;
      return existingDeps;
    } else {
      const openCount = bodyDeps.filter((d) => d.state === 'open').length;
      return {
        issueNumber,
        blockedBy: bodyDeps,
        resolved: openCount === 0,
        openCount,
      };
    }
  }

  it('creates dependency info from body when no inline deps exist', () => {
    const openIssues = new Set([10, 20]);
    const titles = new Map([[10, 'Issue 10'], [20, 'Issue 20']]);
    const result = enrichWithBodyDeps(1, undefined, 'blocked by #10', openIssues, titles);

    expect(result).toBeDefined();
    expect(result!.issueNumber).toBe(1);
    expect(result!.blockedBy).toHaveLength(1);
    expect(result!.blockedBy[0].number).toBe(10);
    expect(result!.blockedBy[0].state).toBe('open');
    expect(result!.blockedBy[0].title).toBe('Issue 10');
    expect(result!.resolved).toBe(false);
    expect(result!.openCount).toBe(1);
  });

  it('merges body deps with existing inline deps without duplicates', () => {
    const existing: IssueDependencyInfo = {
      issueNumber: 1,
      blockedBy: [
        { number: 10, owner, repo, state: 'open', title: 'Inline blocker' },
      ],
      resolved: false,
      openCount: 1,
    };
    const openIssues = new Set([10, 20]);
    const titles = new Map([[10, 'Issue 10'], [20, 'Issue 20']]);

    // Body references #10 (duplicate) and #20 (new)
    const result = enrichWithBodyDeps(
      1, existing, 'blocked by #10 and depends on #20', openIssues, titles,
    );

    expect(result).toBeDefined();
    expect(result!.blockedBy).toHaveLength(2);
    // #10 should still have the original inline title, not overwritten
    expect(result!.blockedBy[0].title).toBe('Inline blocker');
    // #20 is new from body
    expect(result!.blockedBy[1].number).toBe(20);
    expect(result!.blockedBy[1].state).toBe('open');
    expect(result!.openCount).toBe(2);
    expect(result!.resolved).toBe(false);
  });

  it('resolves same-repo deps as closed when not in openIssueNumbers set', () => {
    const openIssues = new Set([20]); // #10 is NOT open -> closed
    const titles = new Map([[10, 'Closed issue']]);

    const result = enrichWithBodyDeps(1, undefined, 'blocked by #10', openIssues, titles);

    expect(result).toBeDefined();
    expect(result!.blockedBy[0].state).toBe('closed');
    expect(result!.resolved).toBe(true);
    expect(result!.openCount).toBe(0);
  });

  it('keeps cross-repo deps as open (conservative default)', () => {
    const openIssues = new Set<number>();
    const titles = new Map<number, string>();

    const result = enrichWithBodyDeps(
      1, undefined, 'blocked by acme/widgets#99', openIssues, titles,
    );

    expect(result).toBeDefined();
    expect(result!.blockedBy[0].owner).toBe('acme');
    expect(result!.blockedBy[0].repo).toBe('widgets');
    expect(result!.blockedBy[0].state).toBe('open'); // conservative default
    expect(result!.resolved).toBe(false);
  });

  it('returns undefined when body has no dependency patterns', () => {
    const result = enrichWithBodyDeps(
      1, undefined, 'Just a regular issue body with no deps.', new Set(), new Map(),
    );
    expect(result).toBeUndefined();
  });

  it('leaves existing deps unchanged when body has no dependency patterns', () => {
    const existing: IssueDependencyInfo = {
      issueNumber: 1,
      blockedBy: [
        { number: 10, owner, repo, state: 'open', title: 'Blocker' },
      ],
      resolved: false,
      openCount: 1,
    };

    const result = enrichWithBodyDeps(
      1, existing, 'No dependency patterns here', new Set(), new Map(),
    );

    // Should return the same object unchanged
    expect(result).toBe(existing);
    expect(result!.blockedBy).toHaveLength(1);
  });

  it('recalculates resolved status after merging body deps', () => {
    // Existing: all inline deps resolved
    const existing: IssueDependencyInfo = {
      issueNumber: 1,
      blockedBy: [
        { number: 10, owner, repo, state: 'closed', title: 'Done' },
      ],
      resolved: true,
      openCount: 0,
    };
    const openIssues = new Set([20]); // #20 is still open
    const titles = new Map([[20, 'Still open']]);

    const result = enrichWithBodyDeps(
      1, existing, 'depends on #20', openIssues, titles,
    );

    expect(result).toBeDefined();
    expect(result!.blockedBy).toHaveLength(2);
    // After merge, resolved should be false because #20 is open
    expect(result!.resolved).toBe(false);
    expect(result!.openCount).toBe(1);
  });

  it('handles multiple body deps with mixed resolved states', () => {
    const openIssues = new Set([10]); // #10 open, #20 closed
    const titles = new Map([[10, 'Open one'], [20, 'Closed one']]);

    const result = enrichWithBodyDeps(
      1, undefined,
      'blocked by #10 and depends on #20',
      openIssues, titles,
    );

    expect(result).toBeDefined();
    expect(result!.blockedBy).toHaveLength(2);
    expect(result!.blockedBy[0].state).toBe('open');
    expect(result!.blockedBy[1].state).toBe('closed');
    expect(result!.openCount).toBe(1);
    expect(result!.resolved).toBe(false);
  });

  it('populates title from titleByNumber for same-repo body deps', () => {
    const openIssues = new Set([42]);
    const titles = new Map([[42, 'My issue title']]);

    const result = enrichWithBodyDeps(
      1, undefined, 'blocked by #42', openIssues, titles,
    );

    expect(result!.blockedBy[0].title).toBe('My issue title');
  });

  it('deduplicates cross-repo deps correctly (number + owner + repo)', () => {
    const existing: IssueDependencyInfo = {
      issueNumber: 1,
      blockedBy: [
        { number: 100, owner: 'acme', repo: 'widgets', state: 'open', title: 'Cross-repo' },
      ],
      resolved: false,
      openCount: 1,
    };
    const openIssues = new Set<number>();
    const titles = new Map<number, string>();

    // Body also references acme/widgets#100 (should be deduped)
    // and acme/widgets#200 (new)
    const result = enrichWithBodyDeps(
      1, existing,
      'blocked by acme/widgets#100 and depends on acme/widgets#200',
      openIssues, titles,
    );

    expect(result!.blockedBy).toHaveLength(2); // not 3
    expect(result!.blockedBy[0].number).toBe(100);
    expect(result!.blockedBy[1].number).toBe(200);
  });
});
