// =============================================================================
// Fleet Commander -- TeamManager prompt-substitution tests (issue #710)
// =============================================================================
// Tests the {{AUTO_MERGE_WARNING}} placeholder substitution in
// resolvePromptFromFile() and the buildAutoMergeWarning() decision logic.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Project } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted via vi.hoisted so vi.mock factories can reference them
// ---------------------------------------------------------------------------

const mockDb = vi.hoisted(() => ({
  getProject: vi.fn(),
  getTeam: vi.fn(),
  getActiveTeams: vi.fn().mockReturnValue([]),
  getActiveTeamCountByProject: vi.fn().mockReturnValue(0),
  getQueuedTeamsByProject: vi.fn().mockReturnValue([]),
  updateTeam: vi.fn(),
  updateTeamSilent: vi.fn(),
  updateProject: vi.fn(),
  insertTransition: vi.fn(),
  insertEvent: vi.fn(),
  getPullRequest: vi.fn(),
}));

vi.mock('../../src/server/db.js', () => ({
  getDatabase: () => mockDb,
}));

vi.mock('../../src/server/config.js', () => ({
  default: {
    worktreeDir: '.claude/worktrees',
    outputBufferLines: 500,
    claudeCmd: 'claude',
    skipPermissions: true,
    terminalCmd: 'auto',
    mergeShutdownGraceMs: 120000,
    fleetCommanderRoot: '/tmp/fleet-prompt-test',
    mapCleanupIntervalMs: 3600000,
    fcHooksDir: '/tmp/fleet/hooks',
    hookDir: '.claude/hooks',
    fcAgentsDir: '/tmp/fleet/agents',
    fcGuidesDir: '/tmp/fleet/guides',
    fcWorkflowTemplate: '/tmp/fleet/templates/workflow.md',
    autoMergeRefreshMs: 86_400_000,
  },
}));

const mockSseBroker = vi.hoisted(() => ({
  broadcast: vi.fn(),
  getSnapshot: vi.fn().mockReturnValue([]),
}));
vi.mock('../../src/server/services/sse-broker.js', () => ({
  sseBroker: mockSseBroker,
}));

vi.mock('../../src/server/utils/find-git-bash.js', () => ({
  findGitBash: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/server/utils/resolve-message.js', () => ({
  resolveMessage: vi.fn().mockReturnValue('Shutdown message'),
}));

vi.mock('../../src/server/services/usage-tracker.js', () => ({
  getUsageZone: vi.fn().mockReturnValue('green'),
  isUsageBlocked: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/server/utils/resolve-claude-path.js', () => ({
  resolveClaudePath: vi.fn().mockReturnValue('claude'),
}));

vi.mock('../../src/server/services/issue-fetcher.js', () => ({
  getIssueFetcher: () => ({
    fetchDependenciesForIssue: vi.fn().mockResolvedValue({
      issueNumber: 0, blockedBy: [], resolved: true, openCount: 0,
    }),
  }),
  detectCircularDependencies: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/server/services/github-poller.js', () => ({
  githubPoller: {
    trackBlockedIssue: vi.fn(),
  },
}));

vi.mock('../../src/server/utils/exec-gh.js', () => ({
  execGHAsync: vi.fn(),
  execGitAsync: vi.fn(),
  execGHResult: vi.fn(),
  isValidGithubRepo: (repo: string) =>
    /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo),
  isValidBranchName: (branch: string) => /^[a-zA-Z0-9._/\-]+$/.test(branch),
}));

vi.mock('../../src/server/utils/fc-manifest.js', () => ({
  getHookFiles: vi.fn().mockReturnValue([]),
  getAgentFiles: vi.fn().mockReturnValue([]),
  getGuideFiles: vi.fn().mockReturnValue([]),
  getWorkflowFile: vi.fn().mockReturnValue(null),
  getGitignoreEntries: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/server/services/event-collector.js', () => ({
  classifyAgentRole: vi.fn().mockReturnValue('tl'),
  shouldAdvancePhase: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/server/services/issue-context-generator.js', () => ({
  generateIssueContext: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/server/utils/cc-spawn.js', () => ({
  spawnHeadless: vi.fn(),
  spawnInteractive: vi.fn(),
}));

// Mock fs to control file existence and content for resolvePromptFromFile
const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
  writeFileSync: vi.fn(),
  statSync: vi.fn().mockReturnValue({ isDirectory: () => false }),
  rmSync: vi.fn(),
  openSync: vi.fn(),
  readSync: vi.fn(),
  closeSync: vi.fn(),
}));

vi.mock('fs', () => ({
  default: mockFs,
  ...mockFs,
}));

// Mock project-service refreshAutoMergeForProject to control what
// buildAutoMergeWarning sees without invoking the real gh path.
const mockRefreshAutoMerge = vi.hoisted(() =>
  vi.fn<(projectId: number, options?: { skipIfFresh?: boolean }) => Promise<boolean | null>>(),
);

vi.mock('../../src/server/services/project-service.js', () => ({
  refreshAutoMergeForProject: (projectId: number, options?: { skipIfFresh?: boolean }) =>
    mockRefreshAutoMerge(projectId, options),
  // Re-export the rest as no-ops so accidental imports don't blow up
  checkRepoSettings: vi.fn(),
}));

import { TeamManager } from '../../src/server/services/team-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 1,
    name: 'test-project',
    repoPath: '/tmp/test-project',
    githubRepo: 'owner/repo',
    groupId: null,
    status: 'active',
    hooksInstalled: true,
    maxActiveTeams: 5,
    promptFile: null,
    model: null,
    effort: null,
    issueProvider: 'github',
    projectKey: null,
    providerConfig: null,
    autoMergeEnabled: null,
    autoMergeCheckedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — resolvePromptFromFile {{AUTO_MERGE_WARNING}} substitution
// ---------------------------------------------------------------------------

describe('TeamManager.resolvePromptFromFile {{AUTO_MERGE_WARNING}} substitution', () => {
  let tm: TeamManager;

  beforeEach(() => {
    vi.clearAllMocks();
    tm = new TeamManager();
  });

  it('substitutes {{AUTO_MERGE_WARNING}} with the supplied warning string', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      'Issue: #{{ISSUE_NUMBER}} — {{ISSUE_TITLE}}\n\n{{AUTO_MERGE_WARNING}}',
    );

    // resolvePromptFromFile is private — cast to any to access for testing
    const project = makeProject();
    const result = (tm as unknown as {
      resolvePromptFromFile: (
        p: Project,
        key: string,
        title?: string,
        warning?: string,
      ) => string;
    }).resolvePromptFromFile(project, '42', 'Test', 'INJECTED_WARNING_TEXT');

    expect(result).toContain('INJECTED_WARNING_TEXT');
    expect(result).not.toContain('{{AUTO_MERGE_WARNING}}');
    expect(result).toContain('#42');
    expect(result).toContain('Test');
  });

  it('substitutes {{AUTO_MERGE_WARNING}} with empty string when no warning passed', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      'Issue: #{{ISSUE_NUMBER}}\n\n{{AUTO_MERGE_WARNING}}',
    );

    const project = makeProject();
    const result = (tm as unknown as {
      resolvePromptFromFile: (p: Project, key: string, title?: string, warning?: string) => string;
    }).resolvePromptFromFile(project, '42', 'Test');

    expect(result).not.toContain('{{AUTO_MERGE_WARNING}}');
    // Empty string produced — the placeholder is just gone
    expect(result).toContain('Issue: #42');
  });

  it('hardcoded fallback appends warning when prompt file missing and warning supplied', () => {
    mockFs.existsSync.mockReturnValue(false);

    const project = makeProject();
    const result = (tm as unknown as {
      resolvePromptFromFile: (p: Project, key: string, title?: string, warning?: string) => string;
    }).resolvePromptFromFile(project, '42', undefined, 'WARNING_X');

    expect(result).toContain('WARNING_X');
    expect(result).toContain('#42');
  });

  it('hardcoded fallback omits the warning when warning is empty string', () => {
    mockFs.existsSync.mockReturnValue(false);

    const project = makeProject();
    const result = (tm as unknown as {
      resolvePromptFromFile: (p: Project, key: string, title?: string, warning?: string) => string;
    }).resolvePromptFromFile(project, '42', undefined, '');

    expect(result).not.toContain('Repo does not allow auto-merge');
    expect(result).toContain('#42');
  });
});

// ---------------------------------------------------------------------------
// Tests — buildAutoMergeWarning decision logic
// ---------------------------------------------------------------------------

describe('TeamManager.buildAutoMergeWarning', () => {
  let tm: TeamManager;

  beforeEach(() => {
    vi.clearAllMocks();
    tm = new TeamManager();
  });

  it('returns empty string for a project with autoMergeEnabled = true', async () => {
    mockRefreshAutoMerge.mockResolvedValue(true);

    const result = await (tm as unknown as {
      buildAutoMergeWarning: (project: Project) => Promise<string>;
    }).buildAutoMergeWarning(makeProject({ autoMergeEnabled: true }));

    expect(result).toBe('');
    expect(mockRefreshAutoMerge).toHaveBeenCalledWith(1, { skipIfFresh: true });
  });

  it('returns empty string for a project with autoMergeEnabled = null (unknown)', async () => {
    mockRefreshAutoMerge.mockResolvedValue(null);

    const result = await (tm as unknown as {
      buildAutoMergeWarning: (project: Project) => Promise<string>;
    }).buildAutoMergeWarning(makeProject({ autoMergeEnabled: null }));

    expect(result).toBe('');
  });

  it('returns the long warning text when autoMergeEnabled = false', async () => {
    mockRefreshAutoMerge.mockResolvedValue(false);

    const result = await (tm as unknown as {
      buildAutoMergeWarning: (project: Project) => Promise<string>;
    }).buildAutoMergeWarning(makeProject({ autoMergeEnabled: false }));

    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('Repo does not allow auto-merge');
    expect(result).toContain('Monitor');
    expect(result).toContain('ScheduleWakeup');
    expect(result).toContain('gh pr merge');
  });

  it('returns empty string when refreshAutoMergeForProject throws (defensive)', async () => {
    mockRefreshAutoMerge.mockRejectedValue(new Error('boom'));

    const result = await (tm as unknown as {
      buildAutoMergeWarning: (project: Project) => Promise<string>;
    }).buildAutoMergeWarning(makeProject({ autoMergeEnabled: false }));

    expect(result).toBe('');
  });

  it('passes skipIfFresh: true so launches use the cached value', async () => {
    mockRefreshAutoMerge.mockResolvedValue(false);

    await (tm as unknown as {
      buildAutoMergeWarning: (project: Project) => Promise<string>;
    }).buildAutoMergeWarning(makeProject({ id: 42 }));

    expect(mockRefreshAutoMerge).toHaveBeenCalledWith(42, { skipIfFresh: true });
  });
});
