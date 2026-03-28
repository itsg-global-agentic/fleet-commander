// =============================================================================
// Fleet Commander -- GitHubIssueProvider fetchFullIssueContext Tests
// =============================================================================
// Tests for the fetchFullIssueContext method on GitHubIssueProvider, including:
//   - Parsing a full GraphQL response into IssueContextData
//   - Filtering bot comments (login ending with [bot] or github-actions)
//   - Filtering minimized comments
//   - Selecting 10 most recent comments
//   - Handling query failures and fallback to basic query
//   - Handling null/missing fields
// =============================================================================

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import {
  GitHubIssueProvider,
  type IssueContextGraphQLNode,
} from '../../../src/server/providers/github-issue-provider.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a full IssueContextGraphQLNode for testing.
 */
function makeGraphQLNode(
  overrides: Partial<IssueContextGraphQLNode> = {},
): IssueContextGraphQLNode {
  return {
    number: 42,
    title: 'Test issue',
    state: 'OPEN',
    body: 'Issue body text.',
    createdAt: '2025-01-15T10:00:00Z',
    updatedAt: '2025-01-16T14:30:00Z',
    author: { login: 'alice' },
    labels: { nodes: [{ name: 'bug' }] },
    assignees: { nodes: [{ login: 'bob' }] },
    milestone: { title: 'v2.0' },
    comments: {
      totalCount: 2,
      nodes: [
        {
          author: { login: 'charlie' },
          createdAt: '2025-01-16T11:00:00Z',
          body: 'First comment',
          isMinimized: false,
        },
        {
          author: { login: 'dave' },
          createdAt: '2025-01-16T12:00:00Z',
          body: 'Second comment',
          isMinimized: false,
        },
      ],
    },
    parent: { number: 10, title: 'Parent issue' },
    subIssues: {
      nodes: [
        { number: 43, title: 'Child A', state: 'OPEN' },
        { number: 44, title: 'Child B', state: 'CLOSED' },
      ],
    },
    blockedBy: {
      nodes: [
        {
          number: 30,
          title: 'Blocker',
          state: 'OPEN',
          repository: { owner: { login: 'acme' }, name: 'widget' },
        },
      ],
    },
    blocking: {
      nodes: [
        {
          number: 50,
          title: 'Downstream',
          state: 'OPEN',
          repository: { owner: { login: 'acme' }, name: 'widget' },
        },
      ],
    },
    closedByPullRequestsReferences: {
      nodes: [{ number: 100, state: 'OPEN', url: 'https://github.com/acme/widget/pull/100' }],
    },
    ...overrides,
  };
}

/**
 * Create a JSON string representing a successful GraphQL response.
 */
function makeGraphQLResponse(node: IssueContextGraphQLNode): string {
  return JSON.stringify({
    data: {
      repository: {
        issue: node,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitHubIssueProvider.fetchFullIssueContext', () => {
  let provider: GitHubIssueProvider;
  let runGHGraphQLSpy: MockInstance;

  beforeEach(() => {
    provider = new GitHubIssueProvider();
    // Spy on the private runGHGraphQL method to mock gh CLI calls
    runGHGraphQLSpy = vi
      .spyOn(provider as unknown as { runGHGraphQL: (body: string, timeout: number) => Promise<string> }, 'runGHGraphQL')
      .mockResolvedValue('{}');
  });

  it('should parse a full GraphQL response into IssueContextData', async () => {
    const node = makeGraphQLNode();
    runGHGraphQLSpy.mockResolvedValue(makeGraphQLResponse(node));

    const result = await provider.fetchFullIssueContext('acme', 'widget', 42);

    expect(result).not.toBeNull();
    expect(result!.number).toBe(42);
    expect(result!.title).toBe('Test issue');
    expect(result!.state).toBe('OPEN');
    expect(result!.repo).toBe('acme/widget');
    expect(result!.author).toBe('alice');
    expect(result!.createdAt).toBe('2025-01-15T10:00:00Z');
    expect(result!.updatedAt).toBe('2025-01-16T14:30:00Z');
    expect(result!.labels).toEqual(['bug']);
    expect(result!.assignees).toEqual(['bob']);
    expect(result!.milestone).toBe('v2.0');
    expect(result!.parent).toEqual({ number: 10, title: 'Parent issue' });
    expect(result!.children).toHaveLength(2);
    expect(result!.blockedBy).toHaveLength(1);
    expect(result!.blocking).toHaveLength(1);
    expect(result!.linkedPRs).toHaveLength(1);
    expect(result!.body).toBe('Issue body text.');
    expect(result!.comments).toHaveLength(2);
    expect(result!.truncation.totalComments).toBe(2);
    expect(result!.truncation.includedComments).toBe(2);
  });

  it('should filter bot comments (login ending with [bot])', async () => {
    const node = makeGraphQLNode({
      comments: {
        totalCount: 3,
        nodes: [
          { author: { login: 'dependabot[bot]' }, createdAt: '2025-01-16T11:00:00Z', body: 'Bot comment', isMinimized: false },
          { author: { login: 'renovate[bot]' }, createdAt: '2025-01-16T11:30:00Z', body: 'Another bot', isMinimized: false },
          { author: { login: 'human' }, createdAt: '2025-01-16T12:00:00Z', body: 'Human comment', isMinimized: false },
        ],
      },
    });
    runGHGraphQLSpy.mockResolvedValue(makeGraphQLResponse(node));

    const result = await provider.fetchFullIssueContext('acme', 'widget', 42);

    expect(result).not.toBeNull();
    expect(result!.comments).toHaveLength(1);
    expect(result!.comments[0].author).toBe('human');
    expect(result!.comments[0].body).toBe('Human comment');
  });

  it('should filter github-actions comments', async () => {
    const node = makeGraphQLNode({
      comments: {
        totalCount: 2,
        nodes: [
          { author: { login: 'github-actions' }, createdAt: '2025-01-16T11:00:00Z', body: 'CI bot', isMinimized: false },
          { author: { login: 'alice' }, createdAt: '2025-01-16T12:00:00Z', body: 'Real comment', isMinimized: false },
        ],
      },
    });
    runGHGraphQLSpy.mockResolvedValue(makeGraphQLResponse(node));

    const result = await provider.fetchFullIssueContext('acme', 'widget', 42);

    expect(result).not.toBeNull();
    expect(result!.comments).toHaveLength(1);
    expect(result!.comments[0].author).toBe('alice');
  });

  it('should filter minimized comments', async () => {
    const node = makeGraphQLNode({
      comments: {
        totalCount: 2,
        nodes: [
          { author: { login: 'alice' }, createdAt: '2025-01-16T11:00:00Z', body: 'Spam', isMinimized: true },
          { author: { login: 'bob' }, createdAt: '2025-01-16T12:00:00Z', body: 'Good comment', isMinimized: false },
        ],
      },
    });
    runGHGraphQLSpy.mockResolvedValue(makeGraphQLResponse(node));

    const result = await provider.fetchFullIssueContext('acme', 'widget', 42);

    expect(result).not.toBeNull();
    expect(result!.comments).toHaveLength(1);
    expect(result!.comments[0].body).toBe('Good comment');
  });

  it('should select only 10 most recent non-bot comments', async () => {
    const comments = Array.from({ length: 15 }, (_, i) => ({
      author: { login: `user${i}` },
      createdAt: `2025-01-16T${String(i).padStart(2, '0')}:00:00Z`,
      body: `Comment ${i}`,
      isMinimized: false,
    }));

    const node = makeGraphQLNode({
      comments: { totalCount: 15, nodes: comments },
    });
    runGHGraphQLSpy.mockResolvedValue(makeGraphQLResponse(node));

    const result = await provider.fetchFullIssueContext('acme', 'widget', 42);

    expect(result).not.toBeNull();
    expect(result!.comments).toHaveLength(10);
    // Should be the last 10 (most recent)
    expect(result!.comments[0].author).toBe('user5');
    expect(result!.comments[9].author).toBe('user14');
    expect(result!.truncation.commentsTruncated).toBe(true);
    expect(result!.truncation.totalComments).toBe(15);
    expect(result!.truncation.includedComments).toBe(10);
  });

  it('should handle null body', async () => {
    const node = makeGraphQLNode({ body: null });
    runGHGraphQLSpy.mockResolvedValue(makeGraphQLResponse(node));

    const result = await provider.fetchFullIssueContext('acme', 'widget', 42);

    expect(result).not.toBeNull();
    expect(result!.body).toBe('');
  });

  it('should handle null author', async () => {
    const node = makeGraphQLNode({ author: null });
    runGHGraphQLSpy.mockResolvedValue(makeGraphQLResponse(node));

    const result = await provider.fetchFullIssueContext('acme', 'widget', 42);

    expect(result).not.toBeNull();
    expect(result!.author).toBe('unknown');
  });

  it('should handle null comment author', async () => {
    const node = makeGraphQLNode({
      comments: {
        totalCount: 1,
        nodes: [
          { author: null, createdAt: '2025-01-16T12:00:00Z', body: 'Anonymous', isMinimized: false },
        ],
      },
    });
    runGHGraphQLSpy.mockResolvedValue(makeGraphQLResponse(node));

    const result = await provider.fetchFullIssueContext('acme', 'widget', 42);

    expect(result).not.toBeNull();
    expect(result!.comments).toHaveLength(1);
    expect(result!.comments[0].author).toBe('unknown');
  });

  it('should handle missing optional fields', async () => {
    const node: IssueContextGraphQLNode = {
      number: 42,
      title: 'Minimal',
      state: 'OPEN',
      body: null,
      createdAt: '2025-01-15T10:00:00Z',
      updatedAt: '2025-01-16T14:30:00Z',
      author: null,
    };
    runGHGraphQLSpy.mockResolvedValue(makeGraphQLResponse(node));

    const result = await provider.fetchFullIssueContext('acme', 'widget', 42);

    expect(result).not.toBeNull();
    expect(result!.labels).toEqual([]);
    expect(result!.assignees).toEqual([]);
    expect(result!.milestone).toBeNull();
    expect(result!.parent).toBeNull();
    expect(result!.children).toEqual([]);
    expect(result!.blockedBy).toEqual([]);
    expect(result!.blocking).toEqual([]);
    expect(result!.linkedPRs).toEqual([]);
    expect(result!.comments).toEqual([]);
  });

  it('should return null when GraphQL query fails', async () => {
    runGHGraphQLSpy.mockRejectedValue(new Error('gh CLI failed'));

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await provider.fetchFullIssueContext('acme', 'widget', 42);
    spy.mockRestore();

    expect(result).toBeNull();
  });

  it('should return null when issue is not found', async () => {
    runGHGraphQLSpy.mockResolvedValue(JSON.stringify({
      data: { repository: { issue: null } },
    }));

    const result = await provider.fetchFullIssueContext('acme', 'widget', 999);

    expect(result).toBeNull();
  });

  it('should fall back to basic query when full query fails with field error', async () => {
    // First call fails with field error, second (basic) succeeds
    const node = makeGraphQLNode({
      subIssues: undefined,
      blockedBy: undefined,
      blocking: undefined,
    });

    let callCount = 0;
    runGHGraphQLSpy.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Simulate field-not-found error
        return JSON.stringify({
          errors: [{ message: "Field 'blockedBy' doesn't exist on type 'Issue'" }],
          data: null,
        });
      }
      return makeGraphQLResponse(node);
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await provider.fetchFullIssueContext('acme', 'widget', 42);
    warnSpy.mockRestore();
    errorSpy.mockRestore();

    expect(result).not.toBeNull();
    expect(result!.number).toBe(42);
    // Should have called runGHGraphQL twice (full + basic)
    expect(callCount).toBe(2);
  });

  it('should handle only bot/minimized comments (empty comments section)', async () => {
    const node = makeGraphQLNode({
      comments: {
        totalCount: 3,
        nodes: [
          { author: { login: 'dependabot[bot]' }, createdAt: '2025-01-16T11:00:00Z', body: 'Bot 1', isMinimized: false },
          { author: { login: 'github-actions' }, createdAt: '2025-01-16T12:00:00Z', body: 'Bot 2', isMinimized: false },
          { author: { login: 'alice' }, createdAt: '2025-01-16T13:00:00Z', body: 'Hidden', isMinimized: true },
        ],
      },
    });
    runGHGraphQLSpy.mockResolvedValue(makeGraphQLResponse(node));

    const result = await provider.fetchFullIssueContext('acme', 'widget', 42);

    expect(result).not.toBeNull();
    expect(result!.comments).toHaveLength(0);
    expect(result!.truncation.totalComments).toBe(3);
    expect(result!.truncation.includedComments).toBe(0);
  });

  it('should construct dependency URLs correctly', async () => {
    const node = makeGraphQLNode({
      blockedBy: {
        nodes: [
          {
            number: 99,
            title: 'Cross-repo blocker',
            state: 'OPEN',
            repository: { owner: { login: 'other-org' }, name: 'other-repo' },
          },
        ],
      },
    });
    runGHGraphQLSpy.mockResolvedValue(makeGraphQLResponse(node));

    const result = await provider.fetchFullIssueContext('acme', 'widget', 42);

    expect(result).not.toBeNull();
    expect(result!.blockedBy[0].url).toBe(
      'https://github.com/other-org/other-repo/issues/99',
    );
  });
});
