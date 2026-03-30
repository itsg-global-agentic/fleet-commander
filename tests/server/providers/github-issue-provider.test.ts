// =============================================================================
// Fleet Commander -- GitHubIssueProvider Tests
// =============================================================================
// Tests for the GitHubIssueProvider class, including:
//   - GraphQL node to GenericIssue mapping
//   - parseDependenciesFromBody (now exported from provider)
//   - parseRepo helper
//   - GITHUB_STATUS_MAP
//   - Provider capabilities and interface compliance
//   - runWithConcurrency utility
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GitHubIssueProvider,
  GITHUB_STATUS_MAP,
  parseDependenciesFromBody,
  runWithConcurrency,
  parseRepo,
  type GraphQLIssueNode,
} from '../../../src/server/providers/github-issue-provider.js';

// ---------------------------------------------------------------------------
// GITHUB_STATUS_MAP
// ---------------------------------------------------------------------------

describe('GITHUB_STATUS_MAP', () => {
  it('should map OPEN to open', () => {
    expect(GITHUB_STATUS_MAP['OPEN']).toBe('open');
  });

  it('should map CLOSED to closed', () => {
    expect(GITHUB_STATUS_MAP['CLOSED']).toBe('closed');
  });

  it('should return undefined for unknown statuses', () => {
    expect(GITHUB_STATUS_MAP['IN_PROGRESS']).toBeUndefined();
    expect(GITHUB_STATUS_MAP['MERGED']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseRepo
// ---------------------------------------------------------------------------

describe('parseRepo', () => {
  it('should parse a valid owner/repo string', () => {
    expect(parseRepo('octocat/hello-world')).toEqual(['octocat', 'hello-world']);
  });

  it('should parse repos with dots and underscores', () => {
    expect(parseRepo('my.org/my_repo')).toEqual(['my.org', 'my_repo']);
  });

  it('should return unknown/unknown for invalid format', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseRepo('no-slash')).toEqual(['unknown', 'unknown']);
    expect(parseRepo('')).toEqual(['unknown', 'unknown']);
    spy.mockRestore();
  });

  it('should return unknown/unknown for too many slashes', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseRepo('a/b/c')).toEqual(['unknown', 'unknown']);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// runWithConcurrency
// ---------------------------------------------------------------------------

describe('runWithConcurrency', () => {
  it('should run tasks in order and return results', async () => {
    const tasks = [
      async () => 1,
      async () => 2,
      async () => 3,
    ];
    const results = await runWithConcurrency(tasks, 2);
    expect(results).toEqual([1, 2, 3]);
  });

  it('should handle empty task list', async () => {
    const results = await runWithConcurrency([], 5);
    expect(results).toEqual([]);
  });

  it('should limit concurrency', async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const tasks = Array.from({ length: 10 }, () => async () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 10));
      currentConcurrent--;
      return maxConcurrent;
    });

    await runWithConcurrency(tasks, 3);
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it('should handle single task', async () => {
    const results = await runWithConcurrency([async () => 42], 5);
    expect(results).toEqual([42]);
  });
});

// ---------------------------------------------------------------------------
// parseDependenciesFromBody (re-exported from provider)
// ---------------------------------------------------------------------------

describe('parseDependenciesFromBody (from provider)', () => {
  const owner = 'octocat';
  const repo = 'hello-world';

  it('should parse simple "blocked by #N" pattern', () => {
    const deps = parseDependenciesFromBody('blocked by #123', owner, repo);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toEqual({
      number: 123,
      owner: 'octocat',
      repo: 'hello-world',
      state: 'open',
      title: '',
    });
  });

  it('should parse "depends on owner/repo#N" pattern', () => {
    const deps = parseDependenciesFromBody('depends on other-org/other-repo#456', owner, repo);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.number).toBe(456);
    expect(deps[0]!.owner).toBe('other-org');
    expect(deps[0]!.repo).toBe('other-repo');
  });

  it('should parse "blocked by https://github.com/owner/repo/issues/N" pattern', () => {
    const deps = parseDependenciesFromBody(
      'blocked by https://github.com/org/project/issues/789',
      owner,
      repo,
    );
    expect(deps).toHaveLength(1);
    expect(deps[0]!.number).toBe(789);
    expect(deps[0]!.owner).toBe('org');
    expect(deps[0]!.repo).toBe('project');
  });

  it('should return empty array for body with no dependencies', () => {
    const deps = parseDependenciesFromBody('Just a regular issue body.', owner, repo);
    expect(deps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GitHubIssueProvider class
// ---------------------------------------------------------------------------

describe('GitHubIssueProvider', () => {
  let provider: GitHubIssueProvider;

  beforeEach(() => {
    provider = new GitHubIssueProvider();
  });

  // -----------------------------------------------------------------------
  // Interface properties
  // -----------------------------------------------------------------------

  it('should have name "github"', () => {
    expect(provider.name).toBe('github');
  });

  it('should have correct capabilities', () => {
    expect(provider.capabilities).toEqual({
      dependencies: true,
      subIssues: true,
      labels: true,
      boardStatuses: false,
      priorities: false,
      assignees: true,
      linkedPRs: true,
    });
  });

  // -----------------------------------------------------------------------
  // IssueProvider interface methods (stub implementations)
  // -----------------------------------------------------------------------

  it('should throw from getIssue (requires owner/repo context)', async () => {
    await expect(provider.getIssue('123')).rejects.toThrow(/requires owner\/repo context/);
  });

  it('should return empty result from queryIssues', async () => {
    const result = await provider.queryIssues({});
    expect(result).toEqual({ issues: [], cursor: null, hasMore: false });
  });

  it('should return empty array from getDependencies', async () => {
    const result = await provider.getDependencies('123');
    expect(result).toEqual([]);
  });

  it('should return empty array from getLinkedPRs', async () => {
    const result = await provider.getLinkedPRs('123');
    expect(result).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // mapToGenericIssue
  // -----------------------------------------------------------------------

  describe('mapToGenericIssue', () => {
    it('should map a basic GraphQL node to GenericIssue', () => {
      const node: GraphQLIssueNode = {
        number: 42,
        title: 'Fix the bug',
        state: 'OPEN',
        url: 'https://github.com/org/repo/issues/42',
        createdAt: '2026-01-15T10:00:00Z',
        labels: { nodes: [{ name: 'bug' }, { name: 'P1' }] },
      };

      const result = provider.mapToGenericIssue(node);

      expect(result.key).toBe('42');
      expect(result.title).toBe('Fix the bug');
      expect(result.status).toBe('open');
      expect(result.rawStatus).toBe('OPEN');
      expect(result.url).toBe('https://github.com/org/repo/issues/42');
      expect(result.labels).toEqual(['bug', 'P1']);
      expect(result.provider).toBe('github');
      expect(result.parentKey).toBeNull();
      expect(result.createdAt).toBe('2026-01-15T10:00:00Z');
    });

    it('should fall back to current time when createdAt is missing', () => {
      const before = new Date().toISOString();
      const node: GraphQLIssueNode = {
        number: 99,
        title: 'No createdAt',
        state: 'OPEN',
        url: 'https://github.com/org/repo/issues/99',
      };

      const result = provider.mapToGenericIssue(node);
      const after = new Date().toISOString();

      // createdAt should be a valid ISO 8601 string between before and after
      expect(result.createdAt).toBeDefined();
      expect(result.createdAt! >= before).toBe(true);
      expect(result.createdAt! <= after).toBe(true);
    });

    it('should map CLOSED state to closed normalized status', () => {
      const node: GraphQLIssueNode = {
        number: 1,
        title: 'Done',
        state: 'CLOSED',
        url: 'https://example.com',
      };

      const result = provider.mapToGenericIssue(node);
      expect(result.status).toBe('closed');
      expect(result.rawStatus).toBe('CLOSED');
    });

    it('should map unknown state to unknown normalized status', () => {
      const node: GraphQLIssueNode = {
        number: 1,
        title: 'Unknown',
        state: 'WEIRD',
        url: 'https://example.com',
      };

      const result = provider.mapToGenericIssue(node);
      expect(result.status).toBe('unknown');
    });

    it('should map parent number to parentKey string', () => {
      const node: GraphQLIssueNode = {
        number: 10,
        title: 'Child issue',
        state: 'OPEN',
        url: 'https://example.com',
        parent: { number: 5, title: 'Parent issue' },
      };

      const result = provider.mapToGenericIssue(node);
      expect(result.parentKey).toBe('5');
    });

    it('should handle empty labels', () => {
      const node: GraphQLIssueNode = {
        number: 1,
        title: 'No labels',
        state: 'OPEN',
        url: 'https://example.com',
        labels: { nodes: [] },
      };

      const result = provider.mapToGenericIssue(node);
      expect(result.labels).toEqual([]);
    });

    it('should handle missing labels field', () => {
      const node: GraphQLIssueNode = {
        number: 1,
        title: 'No labels field',
        state: 'OPEN',
        url: 'https://example.com',
      };

      const result = provider.mapToGenericIssue(node);
      expect(result.labels).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // fetchSingleIssueDeps returns null on failure
  // -----------------------------------------------------------------------

  it('should return null when fetchSingleIssueDeps query fails', async () => {
    // Mock the private runSingleIssueDepsQuery to return null (simulating failure)
    const spy = vi.spyOn(provider as any, 'runSingleIssueDepsQuery').mockResolvedValue(null);

    const result = await provider.fetchSingleIssueDeps('owner', 'repo', 42);
    expect(result).toBeNull();

    spy.mockRestore();
  });

  // -----------------------------------------------------------------------
  // fetchFullIssueContext returns null on failure
  // -----------------------------------------------------------------------

  it('should return null when fetchFullIssueContext query fails', async () => {
    // Mock the private runIssueContextQuery to return null (simulating failure)
    const spy = vi.spyOn(provider as any, 'runIssueContextQuery').mockResolvedValue(null);

    const result = await provider.fetchFullIssueContext('owner', 'repo', 42);
    expect(result).toBeNull();

    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Relations CRUD methods
// ---------------------------------------------------------------------------

describe('GitHubIssueProvider.getRelationsGH', () => {
  let provider: GitHubIssueProvider;

  beforeEach(() => {
    provider = new GitHubIssueProvider();
  });

  it('should parse relations from GraphQL response', async () => {
    const mockResponse = JSON.stringify({
      data: {
        repository: {
          issue: {
            parent: { number: 10, title: 'Parent Issue', state: 'OPEN' },
            subIssues: {
              nodes: [
                { number: 43, title: 'Child 1', state: 'OPEN' },
                { number: 44, title: 'Child 2', state: 'CLOSED' },
              ],
            },
            blockedBy: {
              nodes: [
                { number: 20, title: 'Blocker', state: 'OPEN', repository: { owner: { login: 'owner' }, name: 'repo' } },
              ],
            },
            blocking: {
              nodes: [
                { number: 30, title: 'Blocked', state: 'OPEN', repository: { owner: { login: 'owner' }, name: 'repo' } },
              ],
            },
          },
        },
      },
    });

    const spy = vi.spyOn(provider as any, 'runGHGraphQL').mockResolvedValue(mockResponse);

    const relations = await provider.getRelationsGH('owner', 'repo', '42');

    expect(relations.parent).toEqual({ key: '10', title: 'Parent Issue', state: 'open' });
    expect(relations.children).toHaveLength(2);
    expect(relations.children[0].key).toBe('43');
    expect(relations.children[1].state).toBe('closed');
    expect(relations.blockedBy).toHaveLength(1);
    expect(relations.blockedBy[0].key).toBe('20');
    expect(relations.blocking).toHaveLength(1);
    expect(relations.blocking[0].key).toBe('30');

    spy.mockRestore();
  });

  it('should return empty relations when issue has none', async () => {
    const mockResponse = JSON.stringify({
      data: {
        repository: {
          issue: {
            parent: null,
            subIssues: { nodes: [] },
            blockedBy: { nodes: [] },
            blocking: { nodes: [] },
          },
        },
      },
    });

    const spy = vi.spyOn(provider as any, 'runGHGraphQL').mockResolvedValue(mockResponse);

    const relations = await provider.getRelationsGH('owner', 'repo', '42');

    expect(relations.parent).toBeNull();
    expect(relations.children).toEqual([]);
    expect(relations.blockedBy).toEqual([]);
    expect(relations.blocking).toEqual([]);

    spy.mockRestore();
  });

  it('should throw on invalid issue key', async () => {
    await expect(provider.getRelationsGH('owner', 'repo', 'abc'))
      .rejects.toThrow('Invalid GitHub issue key');
  });
});

describe('GitHubIssueProvider.addBlockedByGH', () => {
  let provider: GitHubIssueProvider;

  beforeEach(() => {
    provider = new GitHubIssueProvider();
  });

  it('should construct correct addBlockedBy mutation', async () => {
    const getNodeIdSpy = vi.spyOn(provider, 'getNodeId')
      .mockResolvedValueOnce('I_node_42')
      .mockResolvedValueOnce('I_node_10');

    const graphQLSpy = vi.spyOn(provider as any, 'runGHGraphQL')
      .mockResolvedValue(JSON.stringify({ data: { addBlockedBy: { clientMutationId: null } } }));

    await provider.addBlockedByGH('owner', 'repo', '42', '10');

    expect(getNodeIdSpy).toHaveBeenCalledTimes(2);
    expect(graphQLSpy).toHaveBeenCalledTimes(1);

    const callArg = graphQLSpy.mock.calls[0][0];
    const parsed = JSON.parse(callArg);
    expect(parsed.query).toContain('addBlockedBy');
    expect(parsed.query).toContain('I_node_42');
    expect(parsed.query).toContain('I_node_10');

    getNodeIdSpy.mockRestore();
    graphQLSpy.mockRestore();
  });

  it('should throw on GraphQL mutation error', async () => {
    vi.spyOn(provider, 'getNodeId')
      .mockResolvedValueOnce('I_node_42')
      .mockResolvedValueOnce('I_node_10');

    vi.spyOn(provider as any, 'runGHGraphQL')
      .mockResolvedValue(JSON.stringify({
        errors: [{ message: 'Permission denied' }],
      }));

    await expect(provider.addBlockedByGH('owner', 'repo', '42', '10'))
      .rejects.toThrow('GraphQL mutation addBlockedBy failed: Permission denied');
  });
});

describe('GitHubIssueProvider.addChildGH', () => {
  let provider: GitHubIssueProvider;

  beforeEach(() => {
    provider = new GitHubIssueProvider();
  });

  it('should construct correct addSubIssue mutation', async () => {
    const getNodeIdSpy = vi.spyOn(provider, 'getNodeId')
      .mockResolvedValueOnce('I_node_10') // parent
      .mockResolvedValueOnce('I_node_43'); // child

    const graphQLSpy = vi.spyOn(provider as any, 'runGHGraphQL')
      .mockResolvedValue(JSON.stringify({ data: { addSubIssue: { clientMutationId: null } } }));

    await provider.addChildGH('owner', 'repo', '10', '43');

    const callArg = graphQLSpy.mock.calls[0][0];
    const parsed = JSON.parse(callArg);
    expect(parsed.query).toContain('addSubIssue');
    expect(parsed.query).toContain('I_node_10');
    expect(parsed.query).toContain('I_node_43');

    getNodeIdSpy.mockRestore();
    graphQLSpy.mockRestore();
  });
});

describe('GitHubIssueProvider.setParentGH', () => {
  let provider: GitHubIssueProvider;

  beforeEach(() => {
    provider = new GitHubIssueProvider();
  });

  it('should use addSubIssue with replaceParent: true', async () => {
    const getNodeIdSpy = vi.spyOn(provider, 'getNodeId')
      .mockResolvedValueOnce('I_node_10') // parent
      .mockResolvedValueOnce('I_node_42'); // child (the issue)

    const graphQLSpy = vi.spyOn(provider as any, 'runGHGraphQL')
      .mockResolvedValue(JSON.stringify({ data: { addSubIssue: { clientMutationId: null } } }));

    await provider.setParentGH('owner', 'repo', '42', '10');

    const callArg = graphQLSpy.mock.calls[0][0];
    const parsed = JSON.parse(callArg);
    expect(parsed.query).toContain('addSubIssue');
    expect(parsed.query).toContain('replaceParent: true');

    getNodeIdSpy.mockRestore();
    graphQLSpy.mockRestore();
  });
});

describe('GitHubIssueProvider.removeParentGH', () => {
  let provider: GitHubIssueProvider;

  beforeEach(() => {
    provider = new GitHubIssueProvider();
  });

  it('should be a no-op when issue has no parent', async () => {
    const getRelationsSpy = vi.spyOn(provider, 'getRelationsGH').mockResolvedValue({
      parent: null,
      children: [],
      blockedBy: [],
      blocking: [],
    });

    const removeChildSpy = vi.spyOn(provider, 'removeChildGH');

    await provider.removeParentGH('owner', 'repo', '42');

    expect(getRelationsSpy).toHaveBeenCalled();
    expect(removeChildSpy).not.toHaveBeenCalled();

    getRelationsSpy.mockRestore();
    removeChildSpy.mockRestore();
  });

  it('should call removeChildGH with current parent', async () => {
    const getRelationsSpy = vi.spyOn(provider, 'getRelationsGH').mockResolvedValue({
      parent: { key: '10', title: 'Parent', state: 'open' },
      children: [],
      blockedBy: [],
      blocking: [],
    });

    const removeChildSpy = vi.spyOn(provider, 'removeChildGH').mockResolvedValue(undefined);

    await provider.removeParentGH('owner', 'repo', '42');

    expect(removeChildSpy).toHaveBeenCalledWith('owner', 'repo', '10', '42');

    getRelationsSpy.mockRestore();
    removeChildSpy.mockRestore();
  });
});
