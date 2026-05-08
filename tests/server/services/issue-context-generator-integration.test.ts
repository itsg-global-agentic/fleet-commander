// =============================================================================
// Fleet Commander — Issue Context Generator Integration Test (issue #711)
// =============================================================================
// Asserts that an inline image URL in a GitHub issue body actually survives
// the conversion path through the REAL `generateIssueContextMarkdown()`
// renderer and ends up in the file written to the worktree.
//
// Unlike the unit-test file in the same directory, this file does NOT mock
// `../../../src/shared/issue-context.js` — only `fs` and the issue provider
// are mocked. The point is to catch regressions where the renderer's
// truncation logic strips an image when it shouldn't.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IssueContextData } from '../../../src/shared/issue-context.js';
import type { Project } from '../../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Mocks (intentionally NOT mocking issue-context.js — we want the real render)
// ---------------------------------------------------------------------------

const mockFetchFullIssueContext = vi.hoisted(() => vi.fn());
const mockGetIssueProvider = vi.hoisted(() => vi.fn());

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

vi.mock('../../../src/server/providers/index.js', () => ({
  getIssueProvider: mockGetIssueProvider,
}));

const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockMkdirSync = vi.hoisted(() => vi.fn());
vi.mock('fs', () => ({
  default: { writeFileSync: mockWriteFileSync, mkdirSync: mockMkdirSync },
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { generateIssueContext } from '../../../src/server/services/issue-context-generator.js';
import { GitHubIssueProvider } from '../../../src/server/providers/github-issue-provider.js';

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

function makeIssueContextData(overrides: Partial<IssueContextData> = {}): IssueContextData {
  return {
    number: 42,
    title: 'Bug with screenshot',
    state: 'OPEN',
    repo: 'owner/repo',
    author: 'alice',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    labels: [],
    assignees: [],
    milestone: null,
    parent: null,
    children: [],
    blockedBy: [],
    blocking: [],
    linkedPRs: [],
    body: '',
    comments: [],
    truncation: {
      bodyTruncated: false,
      commentsTruncated: false,
      totalComments: 0,
      includedComments: 0,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateIssueContext (integration with real markdown renderer)', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('should preserve a markdown image URL through the real renderer and log parity', async () => {
    const url = 'https://user-images.githubusercontent.com/9/xyz.png';
    const body = `Steps to reproduce:\n\n1. Click foo\n2. See bug\n\n![Bug](${url})`;

    const provider = new GitHubIssueProvider();
    mockGetIssueProvider.mockReturnValue(provider);
    mockFetchFullIssueContext.mockResolvedValue(
      makeIssueContextData({ body }),
    );

    await generateIssueContext({
      worktreeAbsPath: '/tmp/worktree',
      issueKey: '42',
      issueNumber: 42,
      issueTitle: 'Bug with screenshot',
      issueProvider: 'github',
      project: makeProject(),
    });

    // The rendered markdown was passed to fs.writeFileSync as the second arg.
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const written = String(mockWriteFileSync.mock.calls[0][1]);

    // The image URL must still be present, in markdown form, in the rendered file.
    expect(written).toContain(`![Bug](${url})`);

    // And the parity log must reflect that the image survived: 1 in body, 1 in prompt.
    const parityLogs = consoleLogSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('Image-ref parity'));
    expect(parityLogs).toHaveLength(1);
    expect(parityLogs[0]).toMatch(/Image-ref parity for issue 42:/);
    expect(parityLogs[0]).toMatch(/images_in_body=1 images_in_prompt=1/);

    // No parity warning.
    const parityWarns = consoleWarnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('Image-ref parity'));
    expect(parityWarns).toHaveLength(0);
  });
});
