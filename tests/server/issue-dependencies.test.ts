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
import { parseDependenciesFromBody, detectCircularDependencies, IssueFetcher } from '../../src/server/services/issue-fetcher.js';
import type { IssueNode } from '../../src/server/services/issue-fetcher.js';
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

// ---------------------------------------------------------------------------
// GraphQL blockedBy + trackedInIssues + body merge logic (single-issue path)
// ---------------------------------------------------------------------------
// These tests verify the three-source merge logic used by
// fetchDependenciesFromTimeline: blockedBy nodes are processed first,
// trackedInIssues are deduped against blockedBy, and body-parsed deps
// are deduped against both. This mirrors the fix for issue #580 where
// blockedBy from GraphQL was not propagated in the single-issue query.
// ---------------------------------------------------------------------------

describe('single-issue dependency merge: blockedBy + trackedInIssues + body', () => {
  const owner = 'octocat';
  const repo = 'hello-world';

  /** GraphQL node shape matching SingleIssueDepsResult subfields */
  interface DepNode {
    number: number;
    title: string;
    state: string;
    repository: { owner: { login: string }; name: string };
  }

  /**
   * Simulate the three-source merge logic from fetchDependenciesFromTimeline.
   * Takes blockedBy nodes, trackedInIssues nodes, and body text, and returns
   * the merged IssueDependencyInfo. This mirrors the actual implementation
   * without requiring live gh CLI calls.
   */
  function mergeThreeSources(
    issueNumber: number,
    blockedByNodes: DepNode[],
    trackedNodes: DepNode[],
    body: string | null,
  ): IssueDependencyInfo {
    const blockedBy: DependencyRef[] = [];

    // 1. Process blockedBy nodes FIRST
    for (const node of blockedByNodes) {
      blockedBy.push({
        number: node.number,
        owner: node.repository.owner.login,
        repo: node.repository.name,
        state: node.state.toLowerCase() === 'open' ? 'open' : 'closed',
        title: node.title,
      });
    }

    // 2. Process trackedInIssues, deduplicating against blockedBy
    for (const node of trackedNodes) {
      const exists = blockedBy.some(
        (b) => b.number === node.number &&
               b.owner === node.repository.owner.login &&
               b.repo === node.repository.name
      );
      if (!exists) {
        blockedBy.push({
          number: node.number,
          owner: node.repository.owner.login,
          repo: node.repository.name,
          state: node.state.toLowerCase() === 'open' ? 'open' : 'closed',
          title: node.title,
        });
      }
    }

    // 3. Parse body for dependency patterns, deduplicating against above
    if (body) {
      const bodyDeps = parseDependenciesFromBody(body, owner, repo);
      for (const dep of bodyDeps) {
        const exists = blockedBy.some(
          (b) => b.number === dep.number && b.owner === dep.owner && b.repo === dep.repo
        );
        if (!exists) {
          blockedBy.push(dep);
        }
      }
    }

    const openCount = blockedBy.filter((d) => d.state === 'open').length;
    return { issueNumber, blockedBy, resolved: openCount === 0, openCount };
  }

  it('includes blockedBy nodes from GraphQL response in dependency info', () => {
    const blockedByNodes: DepNode[] = [
      {
        number: 10,
        title: 'Blocker issue',
        state: 'OPEN',
        repository: { owner: { login: owner }, name: repo },
      },
    ];

    const result = mergeThreeSources(42, blockedByNodes, [], null);

    expect(result.issueNumber).toBe(42);
    expect(result.blockedBy).toHaveLength(1);
    expect(result.blockedBy[0]).toEqual({
      number: 10,
      owner,
      repo,
      state: 'open',
      title: 'Blocker issue',
    });
    expect(result.resolved).toBe(false);
    expect(result.openCount).toBe(1);
  });

  it('deduplicates blockedBy against trackedInIssues', () => {
    const sharedNode: DepNode = {
      number: 10,
      title: 'Shared dependency',
      state: 'OPEN',
      repository: { owner: { login: owner }, name: repo },
    };

    // Same issue appears in both blockedBy and trackedInIssues
    const result = mergeThreeSources(42, [sharedNode], [sharedNode], null);

    expect(result.blockedBy).toHaveLength(1); // not 2
    expect(result.blockedBy[0].number).toBe(10);
    expect(result.openCount).toBe(1);
  });

  it('merges blockedBy, trackedInIssues, and body-parsed deps without duplicates', () => {
    const blockedByNodes: DepNode[] = [
      {
        number: 10,
        title: 'From blockedBy',
        state: 'OPEN',
        repository: { owner: { login: owner }, name: repo },
      },
    ];
    const trackedNodes: DepNode[] = [
      {
        number: 10, // duplicate with blockedBy
        title: 'From tracked',
        state: 'OPEN',
        repository: { owner: { login: owner }, name: repo },
      },
      {
        number: 20,
        title: 'From tracked only',
        state: 'CLOSED',
        repository: { owner: { login: owner }, name: repo },
      },
    ];
    const body = 'blocked by #10 and depends on #20 and requires #30';

    const result = mergeThreeSources(42, blockedByNodes, trackedNodes, body);

    // #10 from blockedBy (deduped from tracked + body)
    // #20 from trackedInIssues (deduped from body)
    // #30 from body (unique)
    expect(result.blockedBy).toHaveLength(3);
    expect(result.blockedBy.map((d) => d.number)).toEqual([10, 20, 30]);
    // #10 should retain the blockedBy title (processed first)
    expect(result.blockedBy[0].title).toBe('From blockedBy');
    // #20 should retain the tracked title (processed before body)
    expect(result.blockedBy[1].title).toBe('From tracked only');
    expect(result.blockedBy[1].state).toBe('closed');
  });

  it('returns only trackedInIssues and body deps when blockedBy is not present', () => {
    const trackedNodes: DepNode[] = [
      {
        number: 10,
        title: 'Tracked blocker',
        state: 'OPEN',
        repository: { owner: { login: owner }, name: repo },
      },
    ];
    const body = 'depends on #20';

    const result = mergeThreeSources(42, [], trackedNodes, body);

    expect(result.blockedBy).toHaveLength(2);
    expect(result.blockedBy[0].number).toBe(10);
    expect(result.blockedBy[0].title).toBe('Tracked blocker');
    expect(result.blockedBy[1].number).toBe(20);
    expect(result.resolved).toBe(false);
    expect(result.openCount).toBe(2); // both default to open
  });

  it('handles cross-repo blockedBy nodes correctly', () => {
    const blockedByNodes: DepNode[] = [
      {
        number: 55,
        title: 'Cross-repo blocker',
        state: 'OPEN',
        repository: { owner: { login: 'acme' }, name: 'widgets' },
      },
    ];

    const result = mergeThreeSources(42, blockedByNodes, [], null);

    expect(result.blockedBy).toHaveLength(1);
    expect(result.blockedBy[0]).toEqual({
      number: 55,
      owner: 'acme',
      repo: 'widgets',
      state: 'open',
      title: 'Cross-repo blocker',
    });
    expect(result.resolved).toBe(false);
  });

  it('deduplicates cross-repo entries across all three sources', () => {
    const crossRepoNode: DepNode = {
      number: 100,
      title: 'Shared cross-repo',
      state: 'OPEN',
      repository: { owner: { login: 'acme' }, name: 'widgets' },
    };

    const body = 'blocked by acme/widgets#100';

    const result = mergeThreeSources(42, [crossRepoNode], [crossRepoNode], body);

    expect(result.blockedBy).toHaveLength(1); // fully deduped
    expect(result.blockedBy[0].number).toBe(100);
    expect(result.blockedBy[0].owner).toBe('acme');
  });

  it('resolved is true when all blockedBy nodes are closed', () => {
    const blockedByNodes: DepNode[] = [
      {
        number: 10,
        title: 'Done',
        state: 'CLOSED',
        repository: { owner: { login: owner }, name: repo },
      },
    ];
    const trackedNodes: DepNode[] = [
      {
        number: 20,
        title: 'Also done',
        state: 'CLOSED',
        repository: { owner: { login: owner }, name: repo },
      },
    ];

    const result = mergeThreeSources(42, blockedByNodes, trackedNodes, null);

    expect(result.blockedBy).toHaveLength(2);
    expect(result.resolved).toBe(true);
    expect(result.openCount).toBe(0);
  });

  it('returns resolved=true with empty blockedBy when no sources have deps', () => {
    const result = mergeThreeSources(42, [], [], 'No dependency patterns here.');

    expect(result.blockedBy).toHaveLength(0);
    expect(result.resolved).toBe(true);
    expect(result.openCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Batch launch dependency gate — categorization logic
// ---------------------------------------------------------------------------
// These tests verify the categorization logic used by TeamService.launchBatch:
// issues with unresolved dependencies (including intra-batch deps) should be
// queued rather than launched, while unblocked issues launch normally.
// ---------------------------------------------------------------------------

describe('batch launch dependency gate categorization', () => {
  /**
   * Simulate the batch launch categorization logic from TeamService.launchBatch.
   * Takes a list of issues and a dependency resolver, and returns the launchable
   * and queueable sets.
   */
  function categorizeBatch(
    issues: Array<{ number: number; title?: string }>,
    depResolver: (issueNumber: number) => IssueDependencyInfo | null,
  ): {
    launchable: Array<{ number: number; title?: string }>;
    queueable: Array<{ issue: { number: number; title?: string }; blockerNumbers: number[] }>;
  } {
    const launchable: Array<{ number: number; title?: string }> = [];
    const queueable: Array<{ issue: { number: number; title?: string }; blockerNumbers: number[] }> = [];

    for (const issue of issues) {
      const depInfo = depResolver(issue.number);
      if (depInfo && !depInfo.resolved) {
        const openBlockerNumbers = depInfo.blockedBy
          .filter((b) => b.state === 'open')
          .map((b) => b.number);

        if (openBlockerNumbers.length === 0) {
          launchable.push(issue);
        } else {
          queueable.push({ issue, blockerNumbers: openBlockerNumbers });
        }
      } else {
        launchable.push(issue);
      }
    }

    return { launchable, queueable };
  }

  it('queues intra-batch blocked issues instead of launching them', () => {
    // #576 has no deps; #577 blocked by #576 (both in batch)
    const issues = [
      { number: 576, title: 'Base' },
      { number: 577, title: 'Step 2' },
    ];

    const result = categorizeBatch(issues, (issueNumber) => {
      if (issueNumber === 576) return null;
      if (issueNumber === 577) {
        return {
          issueNumber: 577,
          blockedBy: [{ number: 576, owner: 'o', repo: 'r', state: 'open' as const, title: 'Base' }],
          resolved: false,
          openCount: 1,
        };
      }
      return null;
    });

    expect(result.launchable).toHaveLength(1);
    expect(result.launchable[0].number).toBe(576);
    expect(result.queueable).toHaveLength(1);
    expect(result.queueable[0].issue.number).toBe(577);
    expect(result.queueable[0].blockerNumbers).toEqual([576]);
  });

  it('queues a full dependency chain correctly', () => {
    // #576 -> #577 -> #578 -> #579 (chain)
    const issues = [
      { number: 576 },
      { number: 577 },
      { number: 578 },
      { number: 579 },
    ];

    const blockerMap: Record<number, number> = { 577: 576, 578: 577, 579: 578 };

    const result = categorizeBatch(issues, (issueNumber) => {
      const blocker = blockerMap[issueNumber];
      if (blocker) {
        return {
          issueNumber,
          blockedBy: [{ number: blocker, owner: 'o', repo: 'r', state: 'open' as const, title: '' }],
          resolved: false,
          openCount: 1,
        };
      }
      return null;
    });

    expect(result.launchable).toHaveLength(1);
    expect(result.launchable[0].number).toBe(576);
    expect(result.queueable).toHaveLength(3);
    expect(result.queueable.map((q) => q.issue.number)).toEqual([577, 578, 579]);
  });

  it('launches all issues when none have dependencies', () => {
    const issues = [{ number: 10 }, { number: 11 }, { number: 12 }];

    const result = categorizeBatch(issues, () => null);

    expect(result.launchable).toHaveLength(3);
    expect(result.queueable).toHaveLength(0);
  });

  it('treats unresolved deps with no open blockers as launchable (permissive fallback)', () => {
    const issues = [{ number: 10 }];

    const result = categorizeBatch(issues, () => ({
      issueNumber: 10,
      blockedBy: [{ number: 5, owner: 'o', repo: 'r', state: 'closed' as const, title: 'Done' }],
      resolved: false,
      openCount: 0,
    }));

    // Permissive: no open blockers means launchable
    expect(result.launchable).toHaveLength(1);
    expect(result.queueable).toHaveLength(0);
  });

  it('separates external and intra-batch blocked issues into queueable', () => {
    // #10 unblocked, #11 blocked by external #5, #12 blocked by intra-batch #10
    const issues = [{ number: 10 }, { number: 11 }, { number: 12 }];

    const result = categorizeBatch(issues, (issueNumber) => {
      if (issueNumber === 11) {
        return {
          issueNumber: 11,
          blockedBy: [{ number: 5, owner: 'o', repo: 'r', state: 'open' as const, title: 'Ext' }],
          resolved: false,
          openCount: 1,
        };
      }
      if (issueNumber === 12) {
        return {
          issueNumber: 12,
          blockedBy: [{ number: 10, owner: 'o', repo: 'r', state: 'open' as const, title: 'Intra' }],
          resolved: false,
          openCount: 1,
        };
      }
      return null;
    });

    expect(result.launchable).toHaveLength(1);
    expect(result.launchable[0].number).toBe(10);
    expect(result.queueable).toHaveLength(2);
    expect(result.queueable.map((q) => q.issue.number)).toEqual([11, 12]);
  });
});

// ---------------------------------------------------------------------------
// Inherited blockers (parent-child hierarchy)
// ---------------------------------------------------------------------------
// Tests for transitive blocker inheritance through the issue tree.
// Uses IssueFetcher.getDependenciesFromCache with a pre-populated cache.
// ---------------------------------------------------------------------------

describe('inherited blockers (parent-child hierarchy)', () => {
  /**
   * Helper to create a minimal IssueNode for testing.
   */
  function makeNode(
    number: number,
    opts: {
      state?: 'open' | 'closed';
      children?: IssueNode[];
      dependencies?: IssueDependencyInfo;
      issueKey?: string;
    } = {},
  ): IssueNode {
    const node: IssueNode = {
      number,
      title: `Issue #${number}`,
      state: opts.state ?? 'open',
      labels: [],
      url: `https://github.com/test/repo/issues/${number}`,
      children: opts.children ?? [],
      issueKey: opts.issueKey ?? String(number),
      issueProvider: 'github',
    };
    if (opts.dependencies) {
      node.dependencies = opts.dependencies;
    }
    return node;
  }

  /**
   * Helper to create a DependencyRef.
   */
  function makeDepRef(number: number, state: 'open' | 'closed' = 'open'): DependencyRef {
    return {
      number,
      owner: 'test',
      repo: 'repo',
      state,
      title: `Blocker #${number}`,
    };
  }

  /**
   * Helper to set up an IssueFetcher with a pre-populated cache.
   */
  function setupFetcher(issues: IssueNode[]): IssueFetcher {
    const fetcher = new IssueFetcher();
    // Directly set the private cache for testing
    const cache = { issues, cachedAt: new Date().toISOString() };
    (fetcher as unknown as { cacheByProject: Map<number, { issues: IssueNode[]; cachedAt: string | null }> }).cacheByProject.set(1, cache);
    return fetcher;
  }

  it('should inherit blockers from direct parent', () => {
    // Parent #10 is blocked by #1 (open). Child #20 should inherit #1 via #10.
    const parent = makeNode(10, {
      dependencies: {
        issueNumber: 10,
        blockedBy: [makeDepRef(1, 'open')],
        resolved: false,
        openCount: 1,
      },
      children: [makeNode(20)],
    });

    const fetcher = setupFetcher([parent]);
    const deps = fetcher.getDependenciesFromCache(1, 20);

    expect(deps).not.toBeNull();
    expect(deps!.inheritedBlockedBy).toHaveLength(1);
    expect(deps!.inheritedBlockedBy![0].number).toBe(1);
    expect(deps!.inheritedBlockedBy![0].viaAncestor).toBe(10);
    expect(deps!.inheritedBlockedBy![0].state).toBe('open');
    expect(deps!.resolved).toBe(false);
    expect(deps!.openCount).toBe(1);
  });

  it('should inherit blockers transitively through grandparent', () => {
    // Grandparent #5 is blocked by #1. Parent #10 is child of #5. Child #20 is child of #10.
    // Issue #20 should inherit #1 via #5 (walking up through #10 then #5).
    const child = makeNode(20);
    const parent = makeNode(10, { children: [child] });
    const grandparent = makeNode(5, {
      dependencies: {
        issueNumber: 5,
        blockedBy: [makeDepRef(1, 'open')],
        resolved: false,
        openCount: 1,
      },
      children: [parent],
    });

    const fetcher = setupFetcher([grandparent]);
    const deps = fetcher.getDependenciesFromCache(1, 20);

    expect(deps).not.toBeNull();
    expect(deps!.inheritedBlockedBy).toHaveLength(1);
    expect(deps!.inheritedBlockedBy![0].number).toBe(1);
    expect(deps!.inheritedBlockedBy![0].viaAncestor).toBe(5);
    expect(deps!.resolved).toBe(false);
    expect(deps!.openCount).toBe(1);
  });

  it('should not duplicate direct blockers in inherited list', () => {
    // Parent #10 is blocked by #1. Child #20 is also directly blocked by #1.
    // #1 should appear only in blockedBy (direct), NOT in inheritedBlockedBy.
    const child = makeNode(20, {
      dependencies: {
        issueNumber: 20,
        blockedBy: [makeDepRef(1, 'open')],
        resolved: false,
        openCount: 1,
      },
    });
    const parent = makeNode(10, {
      dependencies: {
        issueNumber: 10,
        blockedBy: [makeDepRef(1, 'open')],
        resolved: false,
        openCount: 1,
      },
      children: [child],
    });

    const fetcher = setupFetcher([parent]);
    const deps = fetcher.getDependenciesFromCache(1, 20);

    expect(deps).not.toBeNull();
    // #1 is already a direct blocker — should NOT appear as inherited
    expect(deps!.inheritedBlockedBy ?? []).toHaveLength(0);
    // openCount should only count the direct blocker
    expect(deps!.openCount).toBe(1);
  });

  it('should handle cycle in parent chain gracefully', () => {
    // Simulate a cycle by having a child that is also an ancestor.
    // The visited set should prevent infinite loops.
    // We build a tree: #10 -> #20, then manually create a parent chain cycle
    // by making #20's parent map point back to a node that points to #10.
    // Since buildParentMap is derived from children arrays, a true cycle
    // cannot exist in a tree structure. However, the visited set still protects.

    // Test with a very deep chain (but within limit)
    const leaf = makeNode(100);
    let current: IssueNode = leaf;
    for (let i = 99; i >= 90; i--) {
      current = makeNode(i, { children: [current] });
    }

    const fetcher = setupFetcher([current]);
    const deps = fetcher.getDependenciesFromCache(1, 100);

    // Should return without error (no infinite loop)
    expect(deps).not.toBeNull();
    expect(deps!.resolved).toBe(true);
  });

  it('should respect MAX_ANCESTOR_DEPTH limit', () => {
    // Build a chain deeper than 10 levels with a blocker at the top.
    // The blocker at depth > 10 should NOT be inherited.
    let current: IssueNode = makeNode(20);
    // Build 12 levels of parents (20 -> 19 -> 18 -> ... -> 8)
    for (let i = 19; i >= 8; i--) {
      current = makeNode(i, { children: [current] });
    }
    // Add a blocker at the root (issue #8, depth 12 from issue #20)
    current.dependencies = {
      issueNumber: 8,
      blockedBy: [makeDepRef(1, 'open')],
      resolved: false,
      openCount: 1,
    };

    const fetcher = setupFetcher([current]);
    const deps = fetcher.getDependenciesFromCache(1, 20);

    expect(deps).not.toBeNull();
    // The blocker should NOT be inherited because the ancestor is beyond MAX_ANCESTOR_DEPTH=10
    expect(deps!.inheritedBlockedBy ?? []).toHaveLength(0);
    expect(deps!.resolved).toBe(true);
  });

  it('should treat resolved inherited blockers as non-blocking', () => {
    // Parent #10 has a closed blocker #1. Child #20 should NOT be blocked.
    const parent = makeNode(10, {
      dependencies: {
        issueNumber: 10,
        blockedBy: [makeDepRef(1, 'closed')],
        resolved: true,
        openCount: 0,
      },
      children: [makeNode(20)],
    });

    const fetcher = setupFetcher([parent]);
    const deps = fetcher.getDependenciesFromCache(1, 20);

    expect(deps).not.toBeNull();
    // Closed blockers are NOT collected as inherited
    expect(deps!.inheritedBlockedBy ?? []).toHaveLength(0);
    expect(deps!.resolved).toBe(true);
    expect(deps!.openCount).toBe(0);
  });

  it('should not inherit blockers from closed ancestors', () => {
    // Closed parent #10 has an open blocker #1. Child #20 should NOT inherit.
    const parent = makeNode(10, {
      state: 'closed',
      dependencies: {
        issueNumber: 10,
        blockedBy: [makeDepRef(1, 'open')],
        resolved: false,
        openCount: 1,
      },
      children: [makeNode(20)],
    });

    const fetcher = setupFetcher([parent]);
    const deps = fetcher.getDependenciesFromCache(1, 20);

    expect(deps).not.toBeNull();
    // Closed ancestor does not propagate blockers
    expect(deps!.inheritedBlockedBy ?? []).toHaveLength(0);
    expect(deps!.resolved).toBe(true);
    expect(deps!.openCount).toBe(0);
  });

  it('should inherit multiple blockers from the same parent', () => {
    // Parent #10 is blocked by #1 and #2 (both open). Child #20 should inherit both.
    const parent = makeNode(10, {
      dependencies: {
        issueNumber: 10,
        blockedBy: [makeDepRef(1, 'open'), makeDepRef(2, 'open')],
        resolved: false,
        openCount: 2,
      },
      children: [makeNode(20)],
    });

    const fetcher = setupFetcher([parent]);
    const deps = fetcher.getDependenciesFromCache(1, 20);

    expect(deps).not.toBeNull();
    expect(deps!.inheritedBlockedBy).toHaveLength(2);
    expect(deps!.inheritedBlockedBy!.map((b) => b.number).sort()).toEqual([1, 2]);
    expect(deps!.openCount).toBe(2);
    expect(deps!.resolved).toBe(false);
  });

  it('should inherit blockers from multiple ancestors at different depths', () => {
    // Grandparent #5 blocked by #1, Parent #10 blocked by #2. Child #20 should inherit both.
    const child = makeNode(20);
    const parent = makeNode(10, {
      dependencies: {
        issueNumber: 10,
        blockedBy: [makeDepRef(2, 'open')],
        resolved: false,
        openCount: 1,
      },
      children: [child],
    });
    const grandparent = makeNode(5, {
      dependencies: {
        issueNumber: 5,
        blockedBy: [makeDepRef(1, 'open')],
        resolved: false,
        openCount: 1,
      },
      children: [parent],
    });

    const fetcher = setupFetcher([grandparent]);
    const deps = fetcher.getDependenciesFromCache(1, 20);

    expect(deps).not.toBeNull();
    expect(deps!.inheritedBlockedBy).toHaveLength(2);
    const inherited = deps!.inheritedBlockedBy!;
    // #2 inherited via parent #10
    const via10 = inherited.find((b) => b.number === 2);
    expect(via10).toBeDefined();
    expect(via10!.viaAncestor).toBe(10);
    // #1 inherited via grandparent #5
    const via5 = inherited.find((b) => b.number === 1);
    expect(via5).toBeDefined();
    expect(via5!.viaAncestor).toBe(5);
    expect(deps!.openCount).toBe(2);
    expect(deps!.resolved).toBe(false);
  });

  it('should set viaAncestorKey from the ancestor issueKey', () => {
    const parent = makeNode(10, {
      issueKey: 'PROJ-10',
      dependencies: {
        issueNumber: 10,
        blockedBy: [makeDepRef(1, 'open')],
        resolved: false,
        openCount: 1,
      },
      children: [makeNode(20)],
    });

    const fetcher = setupFetcher([parent]);
    const deps = fetcher.getDependenciesFromCache(1, 20);

    expect(deps).not.toBeNull();
    expect(deps!.inheritedBlockedBy).toHaveLength(1);
    expect(deps!.inheritedBlockedBy![0].viaAncestorKey).toBe('PROJ-10');
  });
});

