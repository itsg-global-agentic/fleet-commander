// =============================================================================
// Fleet Commander — Issue Context Generator Tests
// =============================================================================
// Tests for the issue context generator service that creates
// `.fleet-issue-context.md` files in worktrees before CC spawn.
//
// The generator delegates to:
//   - GitHubIssueProvider.fetchFullIssueContext() for GitHub issues (GraphQL)
//   - Jira provider API for Jira issues
//   - generateIssueContextMarkdown() from shared/issue-context.ts for rendering
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFetchFullIssueContext = vi.hoisted(() => vi.fn());
const mockGetIssue = vi.hoisted(() => vi.fn());
const mockGetLinkedPRs = vi.hoisted(() => vi.fn());
const mockGetDependencies = vi.hoisted(() => vi.fn());

// Mock GitHubIssueProvider as a class with fetchFullIssueContext
vi.mock('../../../src/server/providers/github-issue-provider.js', () => {
  class MockGitHubIssueProvider {
    name = 'github';
    fetchFullIssueContext = mockFetchFullIssueContext;
  }
  return {
    GitHubIssueProvider: MockGitHubIssueProvider,
    parseRepo: (slug: string) => {
      const parts = slug.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) return ['unknown', 'unknown'];
      return [parts[0], parts[1]];
    },
  };
});

// We need dynamic provider returns: GitHub provider for GitHub tests, Jira provider for Jira tests
const mockGetIssueProvider = vi.hoisted(() => vi.fn());

vi.mock('../../../src/server/providers/index.js', () => ({
  getIssueProvider: mockGetIssueProvider,
}));

const mockWriteFileSync = vi.hoisted(() => vi.fn());
vi.mock('fs', () => ({
  default: { writeFileSync: mockWriteFileSync },
  writeFileSync: mockWriteFileSync,
}));

const mockGenerateIssueContextMarkdown = vi.hoisted(() => vi.fn().mockReturnValue('# Mocked markdown'));
vi.mock('../../../src/shared/issue-context.js', () => ({
  generateIssueContextMarkdown: mockGenerateIssueContextMarkdown,
}));

// ---------------------------------------------------------------------------
// Import after mocks — need the real GitHubIssueProvider for instanceof checks
// ---------------------------------------------------------------------------

import { generateIssueContext } from '../../../src/server/services/issue-context-generator.js';
import { GitHubIssueProvider } from '../../../src/server/providers/github-issue-provider.js';
import type { Project } from '../../../src/shared/types.js';
import type { IssueContextData } from '../../../src/shared/issue-context.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 1,
    name: 'test-project',
    repoPath: '/tmp/repo',
    githubRepo: 'owner/repo',
    groupId: null,
    status: 'active',
    hooksInstalled: true,
    maxActiveTeams: 3,
    promptFile: null,
    model: null,
    issueProvider: 'github',
    projectKey: null,
    providerConfig: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeSampleIssueContextData(overrides: Partial<IssueContextData> = {}): IssueContextData {
  return {
    number: 42,
    title: 'Add feature X',
    state: 'OPEN',
    repo: 'owner/repo',
    author: 'alice',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-10T00:00:00Z',
    labels: ['feature'],
    assignees: ['alice'],
    milestone: 'v2.0',
    parent: null,
    children: [],
    blockedBy: [],
    blocking: [],
    linkedPRs: [{ number: 55, state: 'MERGED' }],
    body: 'Feature description here.',
    comments: [{ author: 'bob', date: '2026-01-10T00:00:00Z', body: 'LGTM' }],
    truncation: {
      bodyTruncated: false,
      commentsTruncated: false,
      totalComments: 1,
      includedComments: 1,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// generateIssueContext Tests
// ---------------------------------------------------------------------------

describe('generateIssueContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fetch GitHub issue via GitHubIssueProvider.fetchFullIssueContext and write context file', async () => {
    const contextData = makeSampleIssueContextData();
    const mockProvider = new GitHubIssueProvider();
    mockGetIssueProvider.mockReturnValue(mockProvider);
    mockFetchFullIssueContext.mockResolvedValue(contextData);
    mockGenerateIssueContextMarkdown.mockReturnValue('# Generated markdown');

    await generateIssueContext({
      worktreeAbsPath: '/tmp/worktree',
      issueKey: '42',
      issueNumber: 42,
      issueTitle: 'Add feature X',
      issueProvider: 'github',
      project: makeProject(),
    });

    // Verify fetchFullIssueContext was called with parsed owner/repo and issue number
    expect(mockFetchFullIssueContext).toHaveBeenCalledWith('owner', 'repo', 42);

    // Verify generateIssueContextMarkdown was called with the returned IssueContextData
    expect(mockGenerateIssueContextMarkdown).toHaveBeenCalledWith(contextData);

    // Verify file was written
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const writtenPath = mockWriteFileSync.mock.calls[0][0];
    const writtenContent = mockWriteFileSync.mock.calls[0][1];
    expect(writtenPath).toContain('.fleet-issue-context.md');
    expect(writtenContent).toBe('# Generated markdown');
  });

  it('should fetch Jira issue and write context file using generateIssueContextMarkdown', async () => {
    const jiraProvider = {
      name: 'jira',
      getIssue: mockGetIssue,
      getLinkedPRs: mockGetLinkedPRs,
      getDependencies: mockGetDependencies,
    };
    mockGetIssueProvider.mockReturnValue(jiraProvider);

    mockGetIssue.mockResolvedValue({
      key: 'PROJ-123',
      title: 'Jira task',
      status: 'in_progress',
      rawStatus: 'In Progress',
      url: 'https://jira.example.com/browse/PROJ-123',
      labels: ['backend'],
      assignee: 'dave',
      priority: 2,
      parentKey: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: null,
      provider: 'jira',
    });
    mockGetLinkedPRs.mockResolvedValue([{ number: 10, state: 'open', url: null }]);
    mockGetDependencies.mockResolvedValue([
      { key: 'PROJ-100', title: 'Setup DB', status: 'closed', provider: 'jira', projectKey: 'PROJ' },
    ]);

    await generateIssueContext({
      worktreeAbsPath: '/tmp/worktree',
      issueKey: 'PROJ-123',
      issueNumber: 123,
      issueTitle: 'Jira task',
      issueProvider: 'jira',
      project: makeProject({ issueProvider: 'jira', githubRepo: null }),
    });

    expect(mockGetIssue).toHaveBeenCalledWith('PROJ-123');

    // Verify generateIssueContextMarkdown was called with IssueContextData (not formatContextMarkdown)
    expect(mockGenerateIssueContextMarkdown).toHaveBeenCalledTimes(1);
    const passedData = mockGenerateIssueContextMarkdown.mock.calls[0][0] as IssueContextData;
    expect(passedData.title).toBe('Jira task');
    expect(passedData.state).toBe('In Progress');
    expect(passedData.linkedPRs).toEqual([{ number: 10, state: 'open' }]);
    expect(passedData.blockedBy).toEqual([{ number: 100, title: 'Setup DB', state: 'closed' }]);
    expect(passedData.body).toBe(''); // Jira body is ADF, set to empty

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
  });

  it('should generate fallback context on GitHub fetch failure', async () => {
    const mockProvider = new GitHubIssueProvider();
    mockGetIssueProvider.mockReturnValue(mockProvider);
    mockFetchFullIssueContext.mockResolvedValue(null);

    await generateIssueContext({
      worktreeAbsPath: '/tmp/worktree',
      issueKey: '99',
      issueNumber: 99,
      issueTitle: 'Fallback test',
      issueProvider: 'github',
      project: makeProject(),
    });

    // Verify generateIssueContextMarkdown was called with fallback data
    expect(mockGenerateIssueContextMarkdown).toHaveBeenCalledTimes(1);
    const passedData = mockGenerateIssueContextMarkdown.mock.calls[0][0] as IssueContextData;
    expect(passedData.number).toBe(99);
    expect(passedData.title).toBe('Fallback test');
    expect(passedData.state).toBe('unknown');
    expect(passedData.body).toBe('');
    expect(passedData.comments).toEqual([]);

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
  });

  it('should generate fallback context for unknown provider', async () => {
    // For an unknown provider, getIssueProvider may throw or return a non-GitHub provider.
    // The generator should NOT call fetchFullIssueContext for non-GitHub providers.
    mockGetIssueProvider.mockImplementation(() => {
      throw new Error('Unsupported issue provider: "linear"');
    });

    await generateIssueContext({
      worktreeAbsPath: '/tmp/worktree',
      issueKey: 'LIN-50',
      issueNumber: 50,
      issueTitle: 'Linear issue',
      issueProvider: 'linear',
      project: makeProject({ issueProvider: 'linear', githubRepo: null }),
    });

    // Should not call fetchFullIssueContext
    expect(mockFetchFullIssueContext).not.toHaveBeenCalled();

    // Should still write a context file via fallback
    expect(mockGenerateIssueContextMarkdown).toHaveBeenCalledTimes(1);
    const passedData = mockGenerateIssueContextMarkdown.mock.calls[0][0] as IssueContextData;
    expect(passedData.number).toBe(50);
    expect(passedData.title).toBe('Linear issue');
    expect(passedData.state).toBe('unknown');

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
  });

  it('should not throw when context generation fails', async () => {
    const mockProvider = new GitHubIssueProvider();
    mockGetIssueProvider.mockReturnValue(mockProvider);
    mockFetchFullIssueContext.mockRejectedValue(new Error('Network error'));

    // Should NOT throw
    await expect(generateIssueContext({
      worktreeAbsPath: '/tmp/worktree',
      issueKey: '1',
      issueNumber: 1,
      issueTitle: null,
      issueProvider: 'github',
      project: makeProject(),
    })).resolves.toBeUndefined();
  });

  it('should handle Jira provider error gracefully', async () => {
    const jiraProvider = {
      name: 'jira',
      getIssue: mockGetIssue,
      getLinkedPRs: mockGetLinkedPRs,
      getDependencies: mockGetDependencies,
    };
    mockGetIssueProvider.mockReturnValue(jiraProvider);
    mockGetIssue.mockRejectedValue(new Error('Jira auth failed'));

    await generateIssueContext({
      worktreeAbsPath: '/tmp/worktree',
      issueKey: 'PROJ-999',
      issueNumber: 999,
      issueTitle: 'Jira fail',
      issueProvider: 'jira',
      project: makeProject({ issueProvider: 'jira', githubRepo: null }),
    });

    // Should still write a minimal context file via fallback
    expect(mockGenerateIssueContextMarkdown).toHaveBeenCalledTimes(1);
    const passedData = mockGenerateIssueContextMarkdown.mock.calls[0][0] as IssueContextData;
    expect(passedData.number).toBe(999);
    expect(passedData.title).toBe('Jira fail');
    expect(passedData.state).toBe('unknown');

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
  });

  it('should use instanceof GitHubIssueProvider to detect GitHub provider', async () => {
    // Return a non-GitHub provider object for a github project
    const nonGitHubProvider = {
      name: 'custom',
      getIssue: vi.fn(),
      getLinkedPRs: vi.fn(),
      getDependencies: vi.fn(),
    };
    mockGetIssueProvider.mockReturnValue(nonGitHubProvider);

    await generateIssueContext({
      worktreeAbsPath: '/tmp/worktree',
      issueKey: '42',
      issueNumber: 42,
      issueTitle: 'Test',
      issueProvider: 'github',
      project: makeProject(),
    });

    // fetchFullIssueContext should NOT be called because provider is not instanceof GitHubIssueProvider
    expect(mockFetchFullIssueContext).not.toHaveBeenCalled();

    // Should fall through to fallback
    expect(mockGenerateIssueContextMarkdown).toHaveBeenCalledTimes(1);
    const passedData = mockGenerateIssueContextMarkdown.mock.calls[0][0] as IssueContextData;
    expect(passedData.state).toBe('unknown');
  });

  it('should fall back when project.githubRepo is missing for GitHub provider', async () => {
    await generateIssueContext({
      worktreeAbsPath: '/tmp/worktree',
      issueKey: '42',
      issueNumber: 42,
      issueTitle: 'No repo',
      issueProvider: 'github',
      project: makeProject({ githubRepo: null }),
    });

    // Should not call fetchFullIssueContext because githubRepo is null
    expect(mockFetchFullIssueContext).not.toHaveBeenCalled();
    expect(mockGetIssueProvider).not.toHaveBeenCalled();

    // Should use fallback
    expect(mockGenerateIssueContextMarkdown).toHaveBeenCalledTimes(1);
    const passedData = mockGenerateIssueContextMarkdown.mock.calls[0][0] as IssueContextData;
    expect(passedData.title).toBe('No repo');
    expect(passedData.state).toBe('unknown');
  });
});
