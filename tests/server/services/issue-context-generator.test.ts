// =============================================================================
// Fleet Commander — Issue Context Generator Tests
// =============================================================================
// Tests for the issue context generator service that creates
// `.fleet-issue-context.md` files in worktrees before CC spawn.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockExecGHAsync = vi.hoisted(() => vi.fn());
const mockIsValidGithubRepo = vi.hoisted(() => vi.fn().mockReturnValue(true));

vi.mock('../../../src/server/utils/exec-gh.js', () => ({
  execGHAsync: mockExecGHAsync,
  isValidGithubRepo: mockIsValidGithubRepo,
}));

const mockGetIssue = vi.hoisted(() => vi.fn());
const mockGetLinkedPRs = vi.hoisted(() => vi.fn());
const mockGetDependencies = vi.hoisted(() => vi.fn());

vi.mock('../../../src/server/providers/index.js', () => ({
  getIssueProvider: () => ({
    name: 'jira',
    getIssue: mockGetIssue,
    getLinkedPRs: mockGetLinkedPRs,
    getDependencies: mockGetDependencies,
  }),
}));

const mockWriteFileSync = vi.hoisted(() => vi.fn());
vi.mock('fs', () => ({
  default: { writeFileSync: mockWriteFileSync },
  writeFileSync: mockWriteFileSync,
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { formatContextMarkdown, generateIssueContext } from '../../../src/server/services/issue-context-generator.js';
import type { Project } from '../../../src/shared/types.js';

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

// ---------------------------------------------------------------------------
// formatContextMarkdown Tests
// ---------------------------------------------------------------------------

describe('formatContextMarkdown', () => {
  it('should render full context with all sections', () => {
    const md = formatContextMarkdown({
      key: '42',
      title: 'Add user authentication',
      state: 'OPEN',
      url: 'https://github.com/owner/repo/issues/42',
      body: 'We need OAuth2 support for the login flow.',
      labels: ['feature', 'auth'],
      assignees: ['alice', 'bob'],
      comments: [
        { author: 'carol', body: 'Looks good!', createdAt: '2026-01-15T10:00:00Z' },
      ],
      linkedPRs: [{ number: 50, state: 'OPEN' }],
      dependencies: [{ key: '40', title: 'Setup database', state: 'CLOSED' }],
      milestone: 'v1.0',
    });

    expect(md).toContain('# Issue 42: Add user authentication');
    expect(md).toContain('| **Key** | 42 |');
    expect(md).toContain('| **State** | OPEN |');
    expect(md).toContain('| **URL** | https://github.com/owner/repo/issues/42 |');
    expect(md).toContain('| **Milestone** | v1.0 |');
    expect(md).toContain('| **Labels** | feature, auth |');
    expect(md).toContain('| **Assignees** | alice, bob |');
    expect(md).toContain('## Description');
    expect(md).toContain('We need OAuth2 support');
    expect(md).toContain('## Comments');
    expect(md).toContain('### @carol (2026-01-15T10:00:00Z)');
    expect(md).toContain('Looks good!');
    expect(md).toContain('## Linked Pull Requests');
    expect(md).toContain('- PR #50 — OPEN');
    expect(md).toContain('## Dependencies');
    expect(md).toContain('- 40: Setup database — CLOSED');
  });

  it('should omit empty sections', () => {
    const md = formatContextMarkdown({
      key: '10',
      title: 'Simple bug fix',
      state: 'OPEN',
      url: null,
      body: null,
      labels: [],
      assignees: [],
      comments: [],
      linkedPRs: [],
      dependencies: [],
      milestone: null,
    });

    expect(md).toContain('# Issue 10: Simple bug fix');
    expect(md).toContain('| **Key** | 10 |');
    expect(md).toContain('| **State** | OPEN |');
    expect(md).not.toContain('## Description');
    expect(md).not.toContain('## Comments');
    expect(md).not.toContain('## Linked Pull Requests');
    expect(md).not.toContain('## Dependencies');
    expect(md).not.toContain('**URL**');
    expect(md).not.toContain('**Milestone**');
    expect(md).not.toContain('**Labels**');
    expect(md).not.toContain('**Assignees**');
  });

  it('should truncate body exceeding 10,000 characters', () => {
    const longBody = 'A'.repeat(15_000);
    const md = formatContextMarkdown({
      key: '1',
      title: 'Long body test',
      state: 'OPEN',
      url: null,
      body: longBody,
      labels: [],
      assignees: [],
      comments: [],
      linkedPRs: [],
      dependencies: [],
      milestone: null,
    });

    expect(md).toContain('*(truncated — original exceeds 10,000 characters)*');
    // The body portion should not contain the full 15k characters
    expect(md.length).toBeLessThan(15_000);
  });

  it('should limit comments to 20 most recent', () => {
    const comments = Array.from({ length: 30 }, (_, i) => ({
      author: `user${i}`,
      body: `Comment ${i}`,
      createdAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }));

    const md = formatContextMarkdown({
      key: '5',
      title: 'Many comments',
      state: 'OPEN',
      url: null,
      body: null,
      labels: [],
      assignees: [],
      comments,
      linkedPRs: [],
      dependencies: [],
      milestone: null,
    });

    expect(md).toContain('*10 older comment(s) omitted');
    // Should contain the last 20 comments (user10..user29), not the first 10
    expect(md).toContain('@user10');
    expect(md).toContain('@user29');
    expect(md).not.toContain('@user0 ');
    expect(md).not.toContain('@user9 ');
  });

  it('should handle null body gracefully', () => {
    const md = formatContextMarkdown({
      key: '7',
      title: 'No body',
      state: 'CLOSED',
      url: null,
      body: null,
      labels: [],
      assignees: [],
      comments: [],
      linkedPRs: [],
      dependencies: [],
      milestone: null,
    });

    expect(md).toContain('# Issue 7: No body');
    expect(md).not.toContain('## Description');
  });
});

// ---------------------------------------------------------------------------
// generateIssueContext Tests
// ---------------------------------------------------------------------------

describe('generateIssueContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fetch GitHub issue and write context file', async () => {
    const ghResponse = JSON.stringify({
      number: 42,
      title: 'Add feature X',
      body: 'Feature description here.',
      state: 'OPEN',
      url: 'https://github.com/owner/repo/issues/42',
      labels: [{ name: 'feature' }],
      assignees: [{ login: 'alice' }],
      comments: [{ author: { login: 'bob' }, body: 'LGTM', createdAt: '2026-01-10T00:00:00Z' }],
      milestone: { title: 'v2.0' },
      closedByPullRequests: [{ number: 55, state: 'MERGED' }],
    });
    mockExecGHAsync.mockResolvedValue(ghResponse);

    await generateIssueContext({
      worktreeAbsPath: '/tmp/worktree',
      issueKey: '42',
      issueNumber: 42,
      issueTitle: 'Add feature X',
      issueProvider: 'github',
      project: makeProject(),
    });

    expect(mockExecGHAsync).toHaveBeenCalledTimes(1);
    expect(mockExecGHAsync.mock.calls[0][0]).toContain('gh issue view 42');
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);

    const writtenPath = mockWriteFileSync.mock.calls[0][0];
    const writtenContent = mockWriteFileSync.mock.calls[0][1];
    expect(writtenPath).toContain('.fleet-issue-context.md');
    expect(writtenContent).toContain('# Issue 42: Add feature X');
    expect(writtenContent).toContain('Feature description here.');
    expect(writtenContent).toContain('LGTM');
    expect(writtenContent).toContain('PR #55');
  });

  it('should fetch Jira issue and write context file', async () => {
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
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);

    const writtenContent = mockWriteFileSync.mock.calls[0][1];
    expect(writtenContent).toContain('# Issue PROJ-123: Jira task');
    expect(writtenContent).toContain('In Progress');
    expect(writtenContent).toContain('PR #10');
    expect(writtenContent).toContain('PROJ-100: Setup DB');
  });

  it('should generate minimal context on GitHub fetch failure', async () => {
    mockExecGHAsync.mockResolvedValue(null);

    await generateIssueContext({
      worktreeAbsPath: '/tmp/worktree',
      issueKey: '99',
      issueNumber: 99,
      issueTitle: 'Fallback test',
      issueProvider: 'github',
      project: makeProject(),
    });

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const writtenContent = mockWriteFileSync.mock.calls[0][1];
    expect(writtenContent).toContain('# Issue 99: Fallback test');
    expect(writtenContent).toContain('| **State** | unknown |');
  });

  it('should generate minimal context for unknown provider', async () => {
    await generateIssueContext({
      worktreeAbsPath: '/tmp/worktree',
      issueKey: 'LIN-50',
      issueNumber: 50,
      issueTitle: 'Linear issue',
      issueProvider: 'linear',
      project: makeProject({ issueProvider: 'linear', githubRepo: null }),
    });

    // Should not call GitHub or Jira APIs
    expect(mockExecGHAsync).not.toHaveBeenCalled();
    expect(mockGetIssue).not.toHaveBeenCalled();

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const writtenContent = mockWriteFileSync.mock.calls[0][1];
    expect(writtenContent).toContain('# Issue LIN-50: Linear issue');
  });

  it('should not throw when context generation fails', async () => {
    mockExecGHAsync.mockRejectedValue(new Error('Network error'));

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
    mockGetIssue.mockRejectedValue(new Error('Jira auth failed'));

    await generateIssueContext({
      worktreeAbsPath: '/tmp/worktree',
      issueKey: 'PROJ-999',
      issueNumber: 999,
      issueTitle: 'Jira fail',
      issueProvider: 'jira',
      project: makeProject({ issueProvider: 'jira', githubRepo: null }),
    });

    // Should still write a minimal context file
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const writtenContent = mockWriteFileSync.mock.calls[0][1];
    expect(writtenContent).toContain('# Issue PROJ-999: Jira fail');
  });

  it('should handle invalid GitHub repo slug', async () => {
    mockIsValidGithubRepo.mockReturnValue(false);

    await generateIssueContext({
      worktreeAbsPath: '/tmp/worktree',
      issueKey: '5',
      issueNumber: 5,
      issueTitle: 'Bad repo',
      issueProvider: 'github',
      project: makeProject({ githubRepo: 'invalid repo!' }),
    });

    // Should not call gh CLI
    expect(mockExecGHAsync).not.toHaveBeenCalled();
    // Should still write minimal context
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
  });
});
