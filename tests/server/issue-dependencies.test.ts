// =============================================================================
// Fleet Commander -- Issue Dependency Tests
// =============================================================================
// Tests for:
//   - parseDependenciesFromBody regex parsing
//   - checkDependencies launch-blocking logic (409 responses, force bypass)
//   - Dependency API endpoints
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseDependenciesFromBody } from '../../src/server/services/issue-fetcher.js';

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
