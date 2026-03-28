// =============================================================================
// Fleet Commander — Issue Update Poller Tests
// =============================================================================
// Tests for the IssueUpdatePoller service: snapshot initialization, comment
// detection, bot filtering, label filtering, body change detection, external
// closure, and status filtering.
//
// Follows the same mock pattern as github-poller.test.ts.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Team, Project } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Mocks — must be declared before import
// ---------------------------------------------------------------------------

const mockDb = {
  getActiveTeams: vi.fn().mockReturnValue([]),
  getProjects: vi.fn().mockReturnValue([]),
  getTeam: vi.fn(),
  getProject: vi.fn(),
  updateTeamSilent: vi.fn(),
  insertTransition: vi.fn(),
};

vi.mock('../../src/server/db.js', () => ({
  getDatabase: () => mockDb,
}));

vi.mock('../../src/server/config.js', () => ({
  default: {
    issueUpdatePollMs: 30000,
  },
}));

const mockSseBroker = {
  broadcast: vi.fn(),
};
vi.mock('../../src/server/services/sse-broker.js', () => ({
  sseBroker: mockSseBroker,
}));

const mockResolveMessage = vi.fn().mockReturnValue(null);
vi.mock('../../src/server/utils/resolve-message.js', () => ({
  resolveMessage: (...args: unknown[]) => mockResolveMessage(...args),
}));

const mockManager = {
  sendMessage: vi.fn(),
  stop: vi.fn(),
};
vi.mock('../../src/server/services/team-manager.js', () => ({
  getTeamManager: () => mockManager,
}));

const mockExecGHAsync = vi.fn().mockResolvedValue(null);
vi.mock('../../src/server/utils/exec-gh.js', () => ({
  execGHAsync: (...args: unknown[]) => mockExecGHAsync(...args),
  isValidGithubRepo: (repo: string) => /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo),
}));

// Import after mocks
const { issueUpdatePoller } = await import(
  '../../src/server/services/issue-update-poller.js'
);
const { isPriorityLabel, isBot, hashString } = await import(
  '../../src/server/services/issue-update-poller.js'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTeam(overrides?: Partial<Team>): Partial<Team> {
  return {
    id: 1,
    issueNumber: 42,
    issueTitle: 'Test issue',
    issueKey: '42',
    issueProvider: 'github',
    projectId: 1,
    status: 'running',
    phase: 'implementing',
    pid: 12345,
    sessionId: 'sess-1',
    worktreeName: 'proj-42',
    branchName: 'feat/42-test',
    prNumber: null,
    customPrompt: null,
    headless: false,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalCostUsd: 0,
    launchedAt: new Date().toISOString(),
    stoppedAt: null,
    lastEventAt: new Date().toISOString(),
    blockedByJson: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeProject(overrides?: Partial<Project>): Partial<Project> {
  return {
    id: 1,
    name: 'my-project',
    repoPath: '/tmp/repo',
    githubRepo: 'owner/repo',
    status: 'active',
    hooksInstalled: true,
    maxActiveTeams: 2,
    promptFile: null,
    issueProvider: 'github',
    projectKey: null,
    providerConfig: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeGHIssueView(overrides?: Record<string, unknown>) {
  return JSON.stringify({
    number: 42,
    title: 'Test issue',
    state: 'OPEN',
    body: 'Issue body text',
    labels: [],
    comments: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mockDb.getActiveTeams.mockReturnValue([]);
  mockDb.getProjects.mockReturnValue([]);
  // Clear snapshots between tests by removing known team IDs
  issueUpdatePoller.removeTeam(1);
  issueUpdatePoller.removeTeam(2);
});

afterEach(() => {
  issueUpdatePoller.stop();
  vi.useRealTimers();
});

// =============================================================================
// Utility function tests
// =============================================================================

describe('isPriorityLabel', () => {
  it('matches priority/* labels', () => {
    expect(isPriorityLabel('priority/high')).toBe(true);
    expect(isPriorityLabel('priority:low')).toBe(true);
    expect(isPriorityLabel('Priority/Critical')).toBe(true);
  });

  it('matches P0-P4 labels', () => {
    expect(isPriorityLabel('P0')).toBe(true);
    expect(isPriorityLabel('P4')).toBe(true);
    expect(isPriorityLabel('P5')).toBe(false);
  });

  it('matches blocking/blocked/urgent/critical', () => {
    expect(isPriorityLabel('blocking')).toBe(true);
    expect(isPriorityLabel('blocked')).toBe(true);
    expect(isPriorityLabel('blocker')).toBe(true);
    expect(isPriorityLabel('urgent')).toBe(true);
    expect(isPriorityLabel('critical')).toBe(true);
  });

  it('does not match general labels', () => {
    expect(isPriorityLabel('enhancement')).toBe(false);
    expect(isPriorityLabel('documentation')).toBe(false);
    expect(isPriorityLabel('bug')).toBe(false);
  });
});

describe('isBot', () => {
  it('detects Bot type', () => {
    expect(isBot({ login: 'dependabot', type: 'Bot' })).toBe(true);
  });

  it('detects [bot] suffix', () => {
    expect(isBot({ login: 'dependabot[bot]' })).toBe(true);
    expect(isBot({ login: 'github-actions[bot]' })).toBe(true);
  });

  it('does not flag human users', () => {
    expect(isBot({ login: 'octocat', type: 'User' })).toBe(false);
    expect(isBot({ login: 'developer' })).toBe(false);
  });
});

describe('hashString', () => {
  it('produces consistent hashes', () => {
    expect(hashString('hello')).toBe(hashString('hello'));
  });

  it('produces different hashes for different strings', () => {
    expect(hashString('hello')).not.toBe(hashString('world'));
  });

  it('returns a hex string', () => {
    expect(hashString('test')).toMatch(/^[0-9a-f]+$/);
  });
});

// =============================================================================
// Poll behavior tests
// =============================================================================

describe('IssueUpdatePoller', () => {
  it('first poll initializes snapshots without sending messages', async () => {
    const team = makeTeam({ status: 'running' });
    const project = makeProject();
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getProjects.mockReturnValue([project]);
    mockExecGHAsync.mockResolvedValueOnce(makeGHIssueView());
    mockResolveMessage.mockReturnValue('test message');

    // Trigger poll manually
    // Access the private poll method via the prototype
    await (issueUpdatePoller as unknown as { poll(): Promise<void> }).poll();

    // No messages should be sent on first poll
    expect(mockManager.sendMessage).not.toHaveBeenCalled();
    expect(mockResolveMessage).not.toHaveBeenCalled();
  });

  it('detects new non-bot comment on second poll', async () => {
    const team = makeTeam({ status: 'running' });
    const project = makeProject();
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getProjects.mockReturnValue([project]);

    // First poll — initialize snapshot with 0 comments
    mockExecGHAsync.mockResolvedValueOnce(makeGHIssueView({ comments: [] }));
    await (issueUpdatePoller as unknown as { poll(): Promise<void> }).poll();

    // Second poll — one new human comment
    mockExecGHAsync.mockResolvedValueOnce(
      makeGHIssueView({
        comments: [
          {
            author: { login: 'octocat', type: 'User' },
            body: 'Please also fix the typo on line 10.',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    mockResolveMessage.mockReturnValue('New comment on issue #42 by @octocat');

    await (issueUpdatePoller as unknown as { poll(): Promise<void> }).poll();

    expect(mockResolveMessage).toHaveBeenCalledWith(
      'issue_comment_new',
      expect.objectContaining({
        ISSUE_KEY: '42',
        COMMENT_AUTHOR: 'octocat',
      }),
    );
    expect(mockManager.sendMessage).toHaveBeenCalledWith(
      1,
      'New comment on issue #42 by @octocat',
      'fc',
      'issue_comment_new',
    );
  });

  it('filters out bot comments', async () => {
    const team = makeTeam({ status: 'running' });
    const project = makeProject();
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getProjects.mockReturnValue([project]);

    // First poll — no comments
    mockExecGHAsync.mockResolvedValueOnce(makeGHIssueView({ comments: [] }));
    await (issueUpdatePoller as unknown as { poll(): Promise<void> }).poll();

    // Second poll — only bot comments
    mockExecGHAsync.mockResolvedValueOnce(
      makeGHIssueView({
        comments: [
          {
            author: { login: 'dependabot[bot]', type: 'Bot' },
            body: 'Bumped dependency X',
            createdAt: new Date().toISOString(),
          },
          {
            author: { login: 'github-actions[bot]' },
            body: 'CI report',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );

    await (issueUpdatePoller as unknown as { poll(): Promise<void> }).poll();

    // No messages should be sent — all comments are from bots
    expect(mockResolveMessage).not.toHaveBeenCalled();
    expect(mockManager.sendMessage).not.toHaveBeenCalled();
  });

  it('detects external issue closure and triggers shutdown', async () => {
    const team = makeTeam({ status: 'running' });
    const project = makeProject();
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getProjects.mockReturnValue([project]);

    // First poll — issue is OPEN
    mockExecGHAsync.mockResolvedValueOnce(makeGHIssueView({ state: 'OPEN' }));
    await (issueUpdatePoller as unknown as { poll(): Promise<void> }).poll();

    // Second poll — issue is CLOSED
    mockExecGHAsync.mockResolvedValueOnce(makeGHIssueView({ state: 'CLOSED' }));
    mockResolveMessage.mockReturnValue('Issue #42 was closed externally.');

    await (issueUpdatePoller as unknown as { poll(): Promise<void> }).poll();

    // Should send the closure message
    expect(mockResolveMessage).toHaveBeenCalledWith(
      'issue_closed_externally',
      expect.objectContaining({ ISSUE_KEY: '42' }),
    );

    // Should insert transition and update team status
    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        fromStatus: 'running',
        toStatus: 'done',
        trigger: 'poller',
        reason: 'Issue closed externally',
      }),
    );
    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        status: 'done',
        phase: 'done',
      }),
    );

    // Should broadcast status change
    expect(mockSseBroker.broadcast).toHaveBeenCalledWith(
      'team_status_changed',
      expect.objectContaining({
        team_id: 1,
        status: 'done',
        previous_status: 'running',
      }),
      1,
    );

    // Should stop the team
    expect(mockManager.stop).toHaveBeenCalledWith(1);
  });

  it('only notifies for priority/blocking label changes', async () => {
    const team = makeTeam({ status: 'running' });
    const project = makeProject();
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getProjects.mockReturnValue([project]);

    // First poll — no labels
    mockExecGHAsync.mockResolvedValueOnce(makeGHIssueView({ labels: [] }));
    await (issueUpdatePoller as unknown as { poll(): Promise<void> }).poll();

    // Second poll — added 'enhancement' (non-priority) and 'P0' (priority)
    mockExecGHAsync.mockResolvedValueOnce(
      makeGHIssueView({
        labels: [{ name: 'enhancement' }, { name: 'P0' }],
      }),
    );
    mockResolveMessage.mockReturnValue('Labels changed');

    await (issueUpdatePoller as unknown as { poll(): Promise<void> }).poll();

    // Should notify — P0 is a priority label
    expect(mockResolveMessage).toHaveBeenCalledWith(
      'issue_labels_changed',
      expect.objectContaining({
        ISSUE_KEY: '42',
        LABELS_ADDED: 'P0',
      }),
    );
  });

  it('does not notify for non-priority label changes only', async () => {
    const team = makeTeam({ status: 'running' });
    const project = makeProject();
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getProjects.mockReturnValue([project]);

    // First poll — no labels
    mockExecGHAsync.mockResolvedValueOnce(makeGHIssueView({ labels: [] }));
    await (issueUpdatePoller as unknown as { poll(): Promise<void> }).poll();

    // Second poll — only non-priority labels added
    mockExecGHAsync.mockResolvedValueOnce(
      makeGHIssueView({
        labels: [{ name: 'enhancement' }, { name: 'documentation' }],
      }),
    );

    await (issueUpdatePoller as unknown as { poll(): Promise<void> }).poll();

    // No label notification should fire
    expect(mockResolveMessage).not.toHaveBeenCalled();
  });

  it('detects body edit', async () => {
    const team = makeTeam({ status: 'running' });
    const project = makeProject();
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getProjects.mockReturnValue([project]);

    // First poll — initial body
    mockExecGHAsync.mockResolvedValueOnce(
      makeGHIssueView({ body: 'Original body text' }),
    );
    await (issueUpdatePoller as unknown as { poll(): Promise<void> }).poll();

    // Second poll — body changed
    mockExecGHAsync.mockResolvedValueOnce(
      makeGHIssueView({ body: 'Updated body text with new requirements' }),
    );
    mockResolveMessage.mockReturnValue('Issue body updated');

    await (issueUpdatePoller as unknown as { poll(): Promise<void> }).poll();

    expect(mockResolveMessage).toHaveBeenCalledWith(
      'issue_body_updated',
      expect.objectContaining({
        ISSUE_KEY: '42',
      }),
    );
    expect(mockManager.sendMessage).toHaveBeenCalledWith(
      1,
      'Issue body updated',
      'fc',
      'issue_body_updated',
    );
  });

  it('only polls running/idle/stuck teams, not queued or launching', async () => {
    const queuedTeam = makeTeam({ id: 1, status: 'queued' });
    const launchingTeam = makeTeam({ id: 2, status: 'launching' });
    const runningTeam = makeTeam({ id: 3, status: 'running', issueNumber: 100, issueKey: '100' });
    const project = makeProject();
    mockDb.getActiveTeams.mockReturnValue([queuedTeam, launchingTeam, runningTeam]);
    mockDb.getProjects.mockReturnValue([project]);
    mockExecGHAsync.mockResolvedValue(makeGHIssueView({ number: 100 }));

    await (issueUpdatePoller as unknown as { poll(): Promise<void> }).poll();

    // Only the running team should have triggered a gh call
    expect(mockExecGHAsync).toHaveBeenCalledTimes(1);
    expect(mockExecGHAsync).toHaveBeenCalledWith(
      expect.stringContaining('100'),
    );
  });

  it('batches multiple changes in one poll cycle into one message set', async () => {
    const team = makeTeam({ status: 'running' });
    const project = makeProject();
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getProjects.mockReturnValue([project]);

    // First poll — initialize
    mockExecGHAsync.mockResolvedValueOnce(
      makeGHIssueView({
        body: 'Original',
        labels: [],
        comments: [],
      }),
    );
    await (issueUpdatePoller as unknown as { poll(): Promise<void> }).poll();

    // Second poll — body changed AND new comment AND priority label added
    mockExecGHAsync.mockResolvedValueOnce(
      makeGHIssueView({
        body: 'Updated requirements',
        labels: [{ name: 'P1' }],
        comments: [
          {
            author: { login: 'human', type: 'User' },
            body: 'Added priority label.',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    mockResolveMessage.mockReturnValue('some message');

    await (issueUpdatePoller as unknown as { poll(): Promise<void> }).poll();

    // Should have resolved 3 templates: comment, labels, body
    expect(mockResolveMessage).toHaveBeenCalledWith('issue_comment_new', expect.any(Object));
    expect(mockResolveMessage).toHaveBeenCalledWith('issue_labels_changed', expect.any(Object));
    expect(mockResolveMessage).toHaveBeenCalledWith('issue_body_updated', expect.any(Object));
    expect(mockResolveMessage).toHaveBeenCalledTimes(3);
  });

  it('skips team when gh CLI fails', async () => {
    const team = makeTeam({ status: 'running' });
    const project = makeProject();
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getProjects.mockReturnValue([project]);

    // gh CLI returns null (failure)
    mockExecGHAsync.mockResolvedValueOnce(null);

    await (issueUpdatePoller as unknown as { poll(): Promise<void> }).poll();

    // No messages, no errors
    expect(mockResolveMessage).not.toHaveBeenCalled();
    expect(mockManager.sendMessage).not.toHaveBeenCalled();
  });

  it('handles idle and stuck teams', async () => {
    const idleTeam = makeTeam({ id: 1, status: 'idle', issueNumber: 10, issueKey: '10' });
    const stuckTeam = makeTeam({ id: 2, status: 'stuck', issueNumber: 20, issueKey: '20' });
    const project = makeProject();
    mockDb.getActiveTeams.mockReturnValue([idleTeam, stuckTeam]);
    mockDb.getProjects.mockReturnValue([project]);
    mockExecGHAsync.mockResolvedValue(makeGHIssueView());

    await (issueUpdatePoller as unknown as { poll(): Promise<void> }).poll();

    // Both should be polled
    expect(mockExecGHAsync).toHaveBeenCalledTimes(2);
  });

  it('removeTeam clears snapshot so next poll re-initializes', async () => {
    const team = makeTeam({ status: 'running' });
    const project = makeProject();
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockDb.getProjects.mockReturnValue([project]);

    // First poll — initialize
    mockExecGHAsync.mockResolvedValueOnce(makeGHIssueView({ comments: [] }));
    await (issueUpdatePoller as unknown as { poll(): Promise<void> }).poll();

    // Remove the team's snapshot
    issueUpdatePoller.removeTeam(1);

    // Next poll should re-initialize without sending messages
    mockExecGHAsync.mockResolvedValueOnce(
      makeGHIssueView({
        comments: [
          {
            author: { login: 'octocat', type: 'User' },
            body: 'Hello',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );

    await (issueUpdatePoller as unknown as { poll(): Promise<void> }).poll();

    // Should NOT send a message — this is a re-initialization
    expect(mockManager.sendMessage).not.toHaveBeenCalled();
  });
});
