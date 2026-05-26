// =============================================================================
// Fleet Commander — Cleanup Service Tests
// =============================================================================
// Tests for getCleanupPreview() and executeCleanup() — the two-phase cleanup
// that scans for orphan worktrees, signal files, stale branches, and team
// records for selective removal.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Team, Project } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Mocks — must be declared before import
// ---------------------------------------------------------------------------

const mockDb = {
  getProject: vi.fn(),
  getTeam: vi.fn(),
  getTeams: vi.fn().mockReturnValue([]),
  getTeamByWorktree: vi.fn(),
  deleteTeamAndRelated: vi.fn(),
  // Issue #731: CC subworktree tracking. Default returns [] so existing tests
  // see no cc_subworktree items in the preview unless they opt in.
  getTeamSubworktrees: vi.fn().mockReturnValue([]),
  recordCcSubworktreeRemove: vi.fn(),
};

vi.mock('../../src/server/db.js', () => ({
  getDatabase: () => mockDb,
}));

vi.mock('../../src/server/config.js', () => ({
  default: {
    worktreeDir: '.claude/worktrees',
  },
}));

// Mock child_process.execSync
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// Mock fs
const mockFs = {
  existsSync: vi.fn().mockReturnValue(false),
  readdirSync: vi.fn().mockReturnValue([]),
  rmSync: vi.fn(),
  unlinkSync: vi.fn(),
};
vi.mock('fs', () => ({
  default: {
    existsSync: (...args: unknown[]) => mockFs.existsSync(...args),
    readdirSync: (...args: unknown[]) => mockFs.readdirSync(...args),
    rmSync: (...args: unknown[]) => mockFs.rmSync(...args),
    unlinkSync: (...args: unknown[]) => mockFs.unlinkSync(...args),
  },
}));

// Import after mocks
const { getCleanupPreview, executeCleanup, cleanupTeamCcSubworktrees } = await import(
  '../../src/server/services/cleanup.js'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProject(overrides?: Partial<Project>): Project {
  return {
    id: 1,
    name: 'test-project',
    repoPath: '/tmp/repo',
    githubRepo: 'owner/repo',
    status: 'active',
    hooksInstalled: true,
    maxActiveTeams: 2,
    promptFile: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Project;
}

function makeTeam(overrides?: Partial<Team>): Team {
  return {
    id: 1,
    issueNumber: 10,
    issueTitle: 'Test issue',
    projectId: 1,
    status: 'done',
    phase: 'done',
    pid: null,
    sessionId: null,
    worktreeName: 'test-project-10',
    branchName: 'feat/10-test',
    prNumber: null,
    customPrompt: null,
    headless: true,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalCostUsd: 0,
    launchedAt: null,
    stoppedAt: null,
    lastEventAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Helper to create a mock Dirent-like object.
 */
function makeDirent(name: string, isDir: boolean = true) {
  return { name, isDirectory: () => isDir };
}

/**
 * Normalize path separators for matching in mocks (handles Windows backslashes).
 */
function pathContains(p: unknown, fragment: string): boolean {
  if (typeof p !== 'string') return false;
  return p.replace(/\\/g, '/').includes(fragment);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockFs.existsSync.mockReturnValue(false);
  mockFs.readdirSync.mockReturnValue([]);
  mockExecSync.mockReturnValue('');
});

// =============================================================================
// getCleanupPreview
// =============================================================================

describe('getCleanupPreview', () => {
  it('throws when project not found', () => {
    mockDb.getProject.mockReturnValue(undefined);

    expect(() => getCleanupPreview(999)).toThrow('Project not found');
  });

  it('returns empty items when worktree dir does not exist', () => {
    const project = makeProject();
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeams.mockReturnValue([]);
    mockFs.existsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue('');

    const result = getCleanupPreview(1);

    expect(result.projectId).toBe(1);
    expect(result.projectName).toBe('test-project');
    expect(result.items).toHaveLength(0);
  });

  it('identifies orphan worktrees not tracked in DB', () => {
    const project = makeProject();
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeams.mockReturnValue([]);
    mockDb.getTeamByWorktree.mockReturnValue(undefined);

    // Worktree dir exists with one orphan directory
    mockFs.existsSync.mockImplementation((p: string) => {
      if (pathContains(p, '.claude/worktrees')) return true;
      return false;
    });
    mockFs.readdirSync.mockImplementation((p: string, opts?: unknown) => {
      if (pathContains(p, '.claude/worktrees') && opts) {
        return [makeDirent('test-project-42')];
      }
      return [];
    });
    mockExecSync.mockReturnValue('');

    const result = getCleanupPreview(1);

    const worktreeItems = result.items.filter((i) => i.type === 'worktree');
    expect(worktreeItems.length).toBe(1);
    expect(worktreeItems[0]!.name).toBe('test-project-42');
    expect(worktreeItems[0]!.reason).toContain('orphan');
  });

  it('identifies worktrees for done/failed teams', () => {
    const project = makeProject();
    const team = makeTeam({ id: 10, status: 'done', worktreeName: 'test-project-10' });
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeams.mockReturnValue([team]);
    mockDb.getTeamByWorktree.mockReturnValue(team);

    mockFs.existsSync.mockImplementation((p: string) => {
      if (pathContains(p, '.claude/worktrees')) return true;
      return false;
    });
    mockFs.readdirSync.mockImplementation((p: string, opts?: unknown) => {
      if (pathContains(p, '.claude/worktrees') && opts) {
        return [makeDirent('test-project-10')];
      }
      return [];
    });
    mockExecSync.mockReturnValue('');

    const result = getCleanupPreview(1);

    const worktreeItems = result.items.filter((i) => i.type === 'worktree');
    expect(worktreeItems.length).toBe(1);
    expect(worktreeItems[0]!.reason).toContain('done');
  });

  it('skips worktrees for active teams', () => {
    const project = makeProject();
    const activeTeam = makeTeam({ id: 10, status: 'running', worktreeName: 'test-project-10' });
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeams.mockReturnValue([activeTeam]);
    mockDb.getTeamByWorktree.mockReturnValue(activeTeam);

    mockFs.existsSync.mockImplementation((p: string) => {
      if (pathContains(p, '.claude/worktrees')) return true;
      return false;
    });
    mockFs.readdirSync.mockImplementation((p: string, opts?: unknown) => {
      if (pathContains(p, '.claude/worktrees') && opts) {
        return [makeDirent('test-project-10')];
      }
      return [];
    });
    mockExecSync.mockReturnValue('');

    const result = getCleanupPreview(1);

    const worktreeItems = result.items.filter((i) => i.type === 'worktree');
    expect(worktreeItems.length).toBe(0);
  });

  it('identifies stale branches without worktrees', () => {
    const project = makeProject();
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeams.mockReturnValue([]);
    mockDb.getTeamByWorktree.mockReturnValue(undefined);

    // Worktree dir exists but is empty
    mockFs.existsSync.mockImplementation((p: string) => {
      if (pathContains(p, '.claude/worktrees') && !pathContains(p, 'test-project-10')) return true;
      return false;
    });
    mockFs.readdirSync.mockImplementation((_p: string, opts?: unknown) => {
      if (opts) return []; // Dirent mode for worktree dir scan
      return [];
    });

    // git branch --list returns a stale branch
    mockExecSync.mockReturnValue('  worktree-test-project-10\n');

    const result = getCleanupPreview(1);

    const branchItems = result.items.filter((i) => i.type === 'stale_branch');
    expect(branchItems.length).toBe(1);
    expect(branchItems[0]!.name).toBe('worktree-test-project-10');
  });

  it('skips stale branch when team is re-queued (defense-in-depth DB check)', () => {
    const project = makeProject();
    // activeWorktreeNames set is empty (team was not in initial getTeams query)
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeams.mockReturnValue([]);
    // But the direct DB lookup finds the team as queued (re-launched between set build and branch scan)
    const requeuedTeam = makeTeam({ id: 10, status: 'queued', worktreeName: 'test-project-10', projectId: 1 });
    mockDb.getTeamByWorktree.mockReturnValue(requeuedTeam);

    mockFs.existsSync.mockImplementation((p: string) => {
      if (pathContains(p, '.claude/worktrees') && !pathContains(p, 'test-project-10')) return true;
      return false;
    });
    mockFs.readdirSync.mockImplementation((_p: string, opts?: unknown) => {
      if (opts) return [];
      return [];
    });
    mockExecSync.mockReturnValue('  worktree-test-project-10\n');

    const result = getCleanupPreview(1);

    const branchItems = result.items.filter((i) => i.type === 'stale_branch');
    expect(branchItems.length).toBe(0);
  });

  it('skips stale branch belonging to a different project', () => {
    const project = makeProject();
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeams.mockReturnValue([]);
    // Branch belongs to a team in projectId 2 (different project)
    const otherProjectTeam = makeTeam({ id: 20, status: 'done', worktreeName: 'test-project-10', projectId: 2 });
    mockDb.getTeamByWorktree.mockReturnValue(otherProjectTeam);

    mockFs.existsSync.mockImplementation((p: string) => {
      if (pathContains(p, '.claude/worktrees') && !pathContains(p, 'test-project-10')) return true;
      return false;
    });
    mockFs.readdirSync.mockImplementation((_p: string, opts?: unknown) => {
      if (opts) return [];
      return [];
    });
    mockExecSync.mockReturnValue('  worktree-test-project-10\n');

    const result = getCleanupPreview(1);

    const branchItems = result.items.filter((i) => i.type === 'stale_branch');
    expect(branchItems.length).toBe(0);
  });

  it('includes team records when resetTeams is true', () => {
    const project = makeProject();
    const team = makeTeam({ id: 10, status: 'done', worktreeName: 'test-project-10' });
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeams.mockReturnValue([team]);
    mockFs.existsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue('');

    const result = getCleanupPreview(1, true);

    const teamItems = result.items.filter((i) => i.type === 'team_record');
    expect(teamItems.length).toBe(1);
    expect(teamItems[0]!.path).toBe('db:teams:10');
  });

  it('does not include team records when resetTeams is false', () => {
    const project = makeProject();
    const team = makeTeam({ id: 10, status: 'done', worktreeName: 'test-project-10' });
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeams.mockReturnValue([team]);
    mockFs.existsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue('');

    const result = getCleanupPreview(1, false);

    const teamItems = result.items.filter((i) => i.type === 'team_record');
    expect(teamItems.length).toBe(0);
  });
});

// =============================================================================
// executeCleanup
// =============================================================================

describe('executeCleanup', () => {
  it('throws when project not found', () => {
    mockDb.getProject.mockReturnValue(undefined);

    expect(() => executeCleanup(999, [])).toThrow('Project not found');
  });

  it('removes worktree via git worktree remove', () => {
    const project = makeProject();
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeams.mockReturnValue([]);
    mockDb.getTeamByWorktree.mockReturnValue(undefined);

    // Setup: worktree dir has an orphan
    mockFs.existsSync.mockImplementation((p: string) => {
      if (pathContains(p, '.claude/worktrees')) return true;
      return false;
    });
    mockFs.readdirSync.mockImplementation((p: string, opts?: unknown) => {
      if (pathContains(p, '.claude/worktrees') && opts) {
        return [makeDirent('test-project-42')];
      }
      return [];
    });
    mockExecSync.mockReturnValue('');

    const normalizedPath = '/tmp/repo/.claude/worktrees/test-project-42';
    const result = executeCleanup(1, [normalizedPath]);

    expect(result.removed).toContain('test-project-42');
  });

  it('falls back to fs.rmSync when git worktree remove fails', () => {
    const project = makeProject();
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeams.mockReturnValue([]);
    mockDb.getTeamByWorktree.mockReturnValue(undefined);

    mockFs.existsSync.mockImplementation((p: string) => {
      if (pathContains(p, '.claude/worktrees')) return true;
      return false;
    });
    mockFs.readdirSync.mockImplementation((p: string, opts?: unknown) => {
      if (pathContains(p, '.claude/worktrees') && opts) {
        return [makeDirent('test-project-42')];
      }
      return [];
    });
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('worktree remove')) {
        throw new Error('worktree locked');
      }
      return '';
    });

    const normalizedPath = '/tmp/repo/.claude/worktrees/test-project-42';
    const result = executeCleanup(1, [normalizedPath]);

    expect(mockFs.rmSync).toHaveBeenCalled();
    expect(result.removed).toContain('test-project-42');
  });

  it('deletes stale branches via git branch -D', () => {
    const project = makeProject();
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeams.mockReturnValue([]);
    mockDb.getTeamByWorktree.mockReturnValue(undefined);

    // Worktree dir exists but empty
    mockFs.existsSync.mockImplementation((p: string) => {
      if (pathContains(p, '.claude/worktrees') && !pathContains(p, 'test-project-10')) return true;
      return false;
    });
    mockFs.readdirSync.mockImplementation((_p: string, opts?: unknown) => {
      if (opts) return [];
      return [];
    });

    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('branch --list')) {
        return '  worktree-test-project-10\n';
      }
      return '';
    });

    const result = executeCleanup(1, ['worktree-test-project-10']);

    expect(result.removed).toContain('worktree-test-project-10');
    // Verify git branch -D was called
    const branchDeleteCalls = mockExecSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('branch -D'),
    );
    expect(branchDeleteCalls.length).toBe(1);
  });

  it('skips stale branch deletion when team becomes active between preview and execute', () => {
    const project = makeProject();
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeams.mockReturnValue([]);

    // Worktree dir exists but empty
    mockFs.existsSync.mockImplementation((p: string) => {
      if (pathContains(p, '.claude/worktrees') && !pathContains(p, 'test-project-10')) return true;
      return false;
    });
    mockFs.readdirSync.mockImplementation((_p: string, opts?: unknown) => {
      if (opts) return [];
      return [];
    });

    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('branch --list')) {
        return '  worktree-test-project-10\n';
      }
      return '';
    });

    // The preview re-scan (getCleanupPreview inside executeCleanup) returns the branch as stale
    // because getTeamByWorktree returns undefined during the preview phase.
    // But the just-before-delete guard finds the team is now queued.
    let callCount = 0;
    mockDb.getTeamByWorktree.mockImplementation(() => {
      callCount++;
      // First call is from getCleanupPreview (defense-in-depth check) — no team yet
      if (callCount <= 1) return undefined;
      // Second call is from executeCleanup just-before-delete guard — team is now queued
      return makeTeam({ id: 10, status: 'queued', worktreeName: 'test-project-10' });
    });

    const result = executeCleanup(1, ['worktree-test-project-10']);

    // Branch should NOT be deleted
    expect(result.removed).not.toContain('worktree-test-project-10');
    // Verify git branch -D was NOT called
    const branchDeleteCalls = mockExecSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('branch -D'),
    );
    expect(branchDeleteCalls.length).toBe(0);
  });

  it('skips worktree removal when team becomes active between preview and execute', () => {
    const project = makeProject();
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeams.mockReturnValue([]);

    // Setup: worktree dir has an orphan directory
    mockFs.existsSync.mockImplementation((p: string) => {
      if (pathContains(p, '.claude/worktrees')) return true;
      return false;
    });
    mockFs.readdirSync.mockImplementation((p: string, opts?: unknown) => {
      if (pathContains(p, '.claude/worktrees') && opts) {
        return [makeDirent('test-project-42')];
      }
      return [];
    });
    mockExecSync.mockReturnValue('');

    // The preview re-scan (getCleanupPreview inside executeCleanup) returns the
    // worktree as an orphan because getTeamByWorktree returns undefined during
    // the preview phase. But the just-before-delete guard finds the team is now queued.
    let callCount = 0;
    mockDb.getTeamByWorktree.mockImplementation(() => {
      callCount++;
      // First call is from getCleanupPreview (worktree scan) — no team yet
      if (callCount <= 1) return undefined;
      // Second call is from executeCleanup just-before-delete guard — team is now queued
      return makeTeam({ id: 42, status: 'queued', worktreeName: 'test-project-42' });
    });

    const normalizedPath = '/tmp/repo/.claude/worktrees/test-project-42';
    const result = executeCleanup(1, [normalizedPath]);

    // Worktree should NOT be removed
    expect(result.removed).not.toContain('test-project-42');
    // Verify git worktree remove was NOT called
    const worktreeRemoveCalls = mockExecSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('worktree remove'),
    );
    expect(worktreeRemoveCalls.length).toBe(0);
    // Verify fs.rmSync was NOT called
    expect(mockFs.rmSync).not.toHaveBeenCalled();
  });

  it('deletes team records when included in itemPaths', () => {
    const project = makeProject();
    const team = makeTeam({ id: 10, status: 'done' });
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeams.mockReturnValue([team]);
    mockFs.existsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue('');

    const result = executeCleanup(1, ['db:teams:10'], true);

    expect(mockDb.deleteTeamAndRelated).toHaveBeenCalledWith(10);
    expect(result.removed.length).toBe(1);
  });

  it('reports failures without aborting other items', () => {
    const project = makeProject();
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeams.mockReturnValue([]);
    mockDb.getTeamByWorktree.mockReturnValue(undefined);

    // Two orphan worktrees
    mockFs.existsSync.mockImplementation((p: string) => {
      if (pathContains(p, '.claude/worktrees')) return true;
      return false;
    });
    mockFs.readdirSync.mockImplementation((p: string, opts?: unknown) => {
      if (pathContains(p, '.claude/worktrees') && opts) {
        return [makeDirent('test-project-1'), makeDirent('test-project-2')];
      }
      return [];
    });

    // First worktree fails, second succeeds
    let removeCount = 0;
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('worktree remove')) {
        removeCount++;
        if (removeCount === 1) throw new Error('locked');
        return '';
      }
      if (typeof cmd === 'string' && cmd.includes('worktree prune')) return '';
      return '';
    });
    // For the first worktree, rmSync fallback also fails
    mockFs.rmSync.mockImplementationOnce(() => {
      throw new Error('EACCES');
    });

    const result = executeCleanup(1, [
      '/tmp/repo/.claude/worktrees/test-project-1',
      '/tmp/repo/.claude/worktrees/test-project-2',
    ]);

    expect(result.failed.length).toBe(1);
    expect(result.failed[0]!.name).toBe('test-project-1');
    expect(result.removed).toContain('test-project-2');
  });

  it('only removes items the user selected', () => {
    const project = makeProject();
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeams.mockReturnValue([]);
    mockDb.getTeamByWorktree.mockReturnValue(undefined);

    mockFs.existsSync.mockImplementation((p: string) => {
      if (pathContains(p, '.claude/worktrees')) return true;
      return false;
    });
    mockFs.readdirSync.mockImplementation((p: string, opts?: unknown) => {
      if (pathContains(p, '.claude/worktrees') && opts) {
        return [makeDirent('test-project-1'), makeDirent('test-project-2')];
      }
      return [];
    });
    mockExecSync.mockReturnValue('');

    // Only select one of the two
    const result = executeCleanup(1, ['/tmp/repo/.claude/worktrees/test-project-1']);

    expect(result.removed).toContain('test-project-1');
    expect(result.removed).not.toContain('test-project-2');
  });
});

// =============================================================================
// CC subworktree cleanup (Issue #731)
// =============================================================================

describe('cc_subworktree preview', () => {
  it('includes a cc_subworktree item when a done team has an active CC subworktree', () => {
    const project = makeProject();
    const team = makeTeam({ id: 10, status: 'done', worktreeName: 'test-project-10' });
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeams.mockReturnValue([team]);
    mockDb.getTeamSubworktrees.mockReturnValue([
      {
        id: 1,
        teamId: 10,
        path: '/tmp/repo/.claude/worktrees/test-project-10/sub-1',
        branch: 'feat/x',
        createdVia: 'cc',
        createdAt: '2025-01-01T00:00:00Z',
        removedAt: null,
      },
    ]);
    mockFs.existsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue('');

    const result = getCleanupPreview(1);

    const ccItems = result.items.filter((i) => i.type === 'cc_subworktree');
    expect(ccItems.length).toBe(1);
    expect(ccItems[0]!.name).toBe('sub-1');
    expect(ccItems[0]!.path).toBe('/tmp/repo/.claude/worktrees/test-project-10/sub-1');
    expect(ccItems[0]!.reason).toContain('done');
  });

  it('skips cc_subworktree rows that are already removed', () => {
    const project = makeProject();
    const team = makeTeam({ id: 10, status: 'done', worktreeName: 'test-project-10' });
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeams.mockReturnValue([team]);
    mockDb.getTeamSubworktrees.mockReturnValue([
      {
        id: 1,
        teamId: 10,
        path: '/tmp/repo/sub-1',
        branch: null,
        createdVia: 'cc',
        createdAt: '2025-01-01T00:00:00Z',
        removedAt: '2025-01-02T00:00:00Z',
      },
    ]);
    mockFs.existsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue('');

    const result = getCleanupPreview(1);

    const ccItems = result.items.filter((i) => i.type === 'cc_subworktree');
    expect(ccItems.length).toBe(0);
  });

  it('skips cc_subworktree rows with createdVia=fc (FC-owned, not in this branch)', () => {
    const project = makeProject();
    const team = makeTeam({ id: 10, status: 'done', worktreeName: 'test-project-10' });
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeams.mockReturnValue([team]);
    mockDb.getTeamSubworktrees.mockReturnValue([
      {
        id: 1,
        teamId: 10,
        path: '/tmp/repo/sub-1',
        branch: null,
        createdVia: 'fc',
        createdAt: '2025-01-01T00:00:00Z',
        removedAt: null,
      },
    ]);
    mockFs.existsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue('');

    const result = getCleanupPreview(1);

    const ccItems = result.items.filter((i) => i.type === 'cc_subworktree');
    expect(ccItems.length).toBe(0);
  });

  it('skips cc_subworktrees on active teams', () => {
    const project = makeProject();
    const activeTeam = makeTeam({ id: 10, status: 'running', worktreeName: 'test-project-10' });
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeams.mockReturnValue([activeTeam]);
    mockDb.getTeamSubworktrees.mockReturnValue([
      {
        id: 1,
        teamId: 10,
        path: '/tmp/repo/sub-active',
        branch: null,
        createdVia: 'cc',
        createdAt: '2025-01-01T00:00:00Z',
        removedAt: null,
      },
    ]);
    mockFs.existsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue('');

    const result = getCleanupPreview(1);

    const ccItems = result.items.filter((i) => i.type === 'cc_subworktree');
    expect(ccItems.length).toBe(0);
  });
});

describe('cc_subworktree execute', () => {
  it('runs git worktree remove --force and marks removed_at in DB', () => {
    const project = makeProject();
    const team = makeTeam({ id: 10, status: 'done', worktreeName: 'test-project-10' });
    const subworktreeRow = {
      id: 1,
      teamId: 10,
      path: '/tmp/repo/sub-1',
      branch: null,
      createdVia: 'cc' as const,
      createdAt: '2025-01-01T00:00:00Z',
      removedAt: null,
    };
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeams.mockReturnValue([team]);
    mockDb.getTeamSubworktrees.mockReturnValue([subworktreeRow]);
    mockFs.existsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue('');

    const result = executeCleanup(1, ['/tmp/repo/sub-1']);

    expect(result.removed).toContain('sub-1');

    // Verify git worktree remove was called with the subworktree path
    const removeCalls = mockExecSync.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('worktree remove') &&
        call[0].includes('/tmp/repo/sub-1'),
    );
    expect(removeCalls.length).toBe(1);

    // Verify recordCcSubworktreeRemove was called with team and path
    expect(mockDb.recordCcSubworktreeRemove).toHaveBeenCalledWith({
      teamId: 10,
      path: '/tmp/repo/sub-1',
    });
  });

  it('falls back to fs.rmSync when git worktree remove fails', () => {
    const project = makeProject();
    const team = makeTeam({ id: 10, status: 'done', worktreeName: 'test-project-10' });
    const subworktreeRow = {
      id: 1,
      teamId: 10,
      path: '/tmp/repo/sub-locked',
      branch: null,
      createdVia: 'cc' as const,
      createdAt: '2025-01-01T00:00:00Z',
      removedAt: null,
    };
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeams.mockReturnValue([team]);
    mockDb.getTeamSubworktrees.mockReturnValue([subworktreeRow]);
    mockFs.existsSync.mockReturnValue(false);
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('worktree remove')) {
        throw new Error('worktree locked');
      }
      return '';
    });

    const result = executeCleanup(1, ['/tmp/repo/sub-locked']);

    expect(result.removed).toContain('sub-locked');
    expect(mockFs.rmSync).toHaveBeenCalled();
    // Even on git failure, the DB row should be marked removed so retries are bounded
    expect(mockDb.recordCcSubworktreeRemove).toHaveBeenCalled();
  });

  it('skips when the row is no longer tracked between preview and execute', () => {
    const project = makeProject();
    const team = makeTeam({ id: 10, status: 'done', worktreeName: 'test-project-10' });
    const subworktreeRow = {
      id: 1,
      teamId: 10,
      path: '/tmp/repo/sub-vanished',
      branch: null,
      createdVia: 'cc' as const,
      createdAt: '2025-01-01T00:00:00Z',
      removedAt: null,
    };
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeams.mockReturnValue([team]);
    // First call (during preview) returns the active row; second call (during
    // execute lookup) returns an empty list — simulates the row being removed
    // outside FC between preview and execute.
    let lookupCount = 0;
    mockDb.getTeamSubworktrees.mockImplementation(() => {
      lookupCount++;
      return lookupCount === 1 ? [subworktreeRow] : [];
    });
    mockFs.existsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue('');

    const result = executeCleanup(1, ['/tmp/repo/sub-vanished']);

    expect(result.removed).not.toContain('sub-vanished');
    // git worktree remove should NOT have been called
    const removeCalls = mockExecSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('worktree remove'),
    );
    expect(removeCalls.length).toBe(0);
    expect(mockDb.recordCcSubworktreeRemove).not.toHaveBeenCalled();
  });
});

// =============================================================================
// cleanupTeamCcSubworktrees (issue #737)
// =============================================================================

describe('cleanupTeamCcSubworktrees', () => {
  it('removes active CC subworktrees and marks them in DB', () => {
    const team = makeTeam({ id: 10, status: 'done', projectId: 1 });
    const project = makeProject();
    mockDb.getTeam.mockReturnValue(team);
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeamSubworktrees.mockReturnValue([
      {
        id: 1,
        teamId: 10,
        path: '/tmp/repo/sub-1',
        branch: null,
        createdVia: 'cc',
        createdAt: '2025-01-01T00:00:00Z',
        removedAt: null,
      },
    ]);
    mockExecSync.mockReturnValue('');

    const result = cleanupTeamCcSubworktrees(10);

    expect(result.removed).toEqual(['/tmp/repo/sub-1']);
    expect(result.failed).toEqual([]);

    // Verify git worktree remove was called with the subworktree path
    const removeCalls = mockExecSync.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('worktree remove') &&
        call[0].includes('/tmp/repo/sub-1'),
    );
    expect(removeCalls.length).toBe(1);

    // activeOnly filter was passed so historical removed_at rows are skipped
    expect(mockDb.getTeamSubworktrees).toHaveBeenCalledWith(10, { activeOnly: true });

    // DB row marked removed even though the path was deleted via git
    expect(mockDb.recordCcSubworktreeRemove).toHaveBeenCalledWith({
      teamId: 10,
      path: '/tmp/repo/sub-1',
    });
  });

  it('falls back to fs.rmSync when git worktree remove fails', () => {
    const team = makeTeam({ id: 10, status: 'failed', projectId: 1 });
    const project = makeProject();
    mockDb.getTeam.mockReturnValue(team);
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeamSubworktrees.mockReturnValue([
      {
        id: 2,
        teamId: 10,
        path: '/tmp/repo/sub-locked',
        branch: null,
        createdVia: 'cc',
        createdAt: '2025-01-01T00:00:00Z',
        removedAt: null,
      },
    ]);
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('worktree remove')) {
        throw new Error('worktree locked');
      }
      return '';
    });

    const result = cleanupTeamCcSubworktrees(10);

    expect(result.removed).toEqual(['/tmp/repo/sub-locked']);
    expect(mockFs.rmSync).toHaveBeenCalledWith('/tmp/repo/sub-locked', {
      recursive: true,
      force: true,
    });
    // Even on git failure, the DB row should be marked removed so retries are bounded
    expect(mockDb.recordCcSubworktreeRemove).toHaveBeenCalledWith({
      teamId: 10,
      path: '/tmp/repo/sub-locked',
    });
  });

  it('skips subworktree rows with createdVia=fc', () => {
    const team = makeTeam({ id: 10, status: 'done', projectId: 1 });
    const project = makeProject();
    mockDb.getTeam.mockReturnValue(team);
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeamSubworktrees.mockReturnValue([
      {
        id: 3,
        teamId: 10,
        path: '/tmp/repo/.claude/worktrees/proj-10',
        branch: 'worktree-proj-10',
        createdVia: 'fc',
        createdAt: '2025-01-01T00:00:00Z',
        removedAt: null,
      },
    ]);
    mockExecSync.mockReturnValue('');

    const result = cleanupTeamCcSubworktrees(10);

    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([]);

    // git worktree remove must NEVER have been called for an FC-created row
    const removeCalls = mockExecSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('worktree remove'),
    );
    expect(removeCalls.length).toBe(0);
    expect(mockDb.recordCcSubworktreeRemove).not.toHaveBeenCalled();
  });

  it('no active rows is a no-op', () => {
    const team = makeTeam({ id: 10, status: 'done', projectId: 1 });
    const project = makeProject();
    mockDb.getTeam.mockReturnValue(team);
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeamSubworktrees.mockReturnValue([]);
    mockExecSync.mockReturnValue('');

    const result = cleanupTeamCcSubworktrees(10);

    expect(result).toEqual({ removed: [], failed: [] });
    const removeCalls = mockExecSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('worktree remove'),
    );
    expect(removeCalls.length).toBe(0);
    expect(mockDb.recordCcSubworktreeRemove).not.toHaveBeenCalled();
  });

  it('returns early when team is not found', () => {
    mockDb.getTeam.mockReturnValue(undefined);

    const result = cleanupTeamCcSubworktrees(999);

    expect(result).toEqual({ removed: [], failed: [] });
    expect(mockDb.getProject).not.toHaveBeenCalled();
    expect(mockDb.getTeamSubworktrees).not.toHaveBeenCalled();
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('returns early when project is not found', () => {
    const team = makeTeam({ id: 10, status: 'done', projectId: 7 });
    mockDb.getTeam.mockReturnValue(team);
    mockDb.getProject.mockReturnValue(undefined);

    const result = cleanupTeamCcSubworktrees(10);

    expect(result).toEqual({ removed: [], failed: [] });
    expect(mockDb.getProject).toHaveBeenCalledWith(7);
    expect(mockDb.getTeamSubworktrees).not.toHaveBeenCalled();
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('returns early when team has no projectId', () => {
    const team = makeTeam({ id: 10, status: 'done', projectId: null });
    mockDb.getTeam.mockReturnValue(team);

    const result = cleanupTeamCcSubworktrees(10);

    expect(result).toEqual({ removed: [], failed: [] });
    expect(mockDb.getProject).not.toHaveBeenCalled();
    expect(mockDb.getTeamSubworktrees).not.toHaveBeenCalled();
  });

  it('reports failed entries when both git and fs.rmSync throw', () => {
    const team = makeTeam({ id: 10, status: 'done', projectId: 1 });
    const project = makeProject();
    mockDb.getTeam.mockReturnValue(team);
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeamSubworktrees.mockReturnValue([
      {
        id: 4,
        teamId: 10,
        path: '/tmp/repo/sub-stuck',
        branch: null,
        createdVia: 'cc',
        createdAt: '2025-01-01T00:00:00Z',
        removedAt: null,
      },
    ]);
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('worktree remove')) {
        throw new Error('worktree locked');
      }
      return '';
    });
    mockFs.rmSync.mockImplementation(() => {
      throw new Error('EBUSY');
    });

    const result = cleanupTeamCcSubworktrees(10);

    expect(result.removed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.path).toBe('/tmp/repo/sub-stuck');
    expect(result.failed[0]!.error).toContain('EBUSY');
    // Row still marked removed so we don't retry forever
    expect(mockDb.recordCcSubworktreeRemove).toHaveBeenCalledWith({
      teamId: 10,
      path: '/tmp/repo/sub-stuck',
    });
  });

  it('never throws even when recordCcSubworktreeRemove throws', () => {
    const team = makeTeam({ id: 10, status: 'done', projectId: 1 });
    const project = makeProject();
    mockDb.getTeam.mockReturnValue(team);
    mockDb.getProject.mockReturnValue(project);
    mockDb.getTeamSubworktrees.mockReturnValue([
      {
        id: 5,
        teamId: 10,
        path: '/tmp/repo/sub-db-fail',
        branch: null,
        createdVia: 'cc',
        createdAt: '2025-01-01T00:00:00Z',
        removedAt: null,
      },
    ]);
    mockExecSync.mockReturnValue('');
    mockDb.recordCcSubworktreeRemove.mockImplementation(() => {
      throw new Error('DB locked');
    });

    // Must not throw — auto-cleanup is best-effort
    expect(() => cleanupTeamCcSubworktrees(10)).not.toThrow();
  });
});
