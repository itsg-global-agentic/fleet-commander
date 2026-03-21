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
  getTeams: vi.fn().mockReturnValue([]),
  getTeamByWorktree: vi.fn(),
  deleteTeamAndRelated: vi.fn(),
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
const { getCleanupPreview, executeCleanup } = await import(
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
