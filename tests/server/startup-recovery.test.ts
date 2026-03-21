// =============================================================================
// Fleet Commander — Startup Recovery Tests
// =============================================================================
// Tests for recoverOnStartup() which reconciles DB state with OS processes
// and filesystem state on server restart.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Team, Project } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Mocks — must be declared before import
// ---------------------------------------------------------------------------

const mockDb = {
  getActiveTeams: vi.fn<() => Partial<Team>[]>().mockReturnValue([]),
  getProjects: vi.fn<() => Partial<Project>[]>().mockReturnValue([]),
  getTeamByWorktree: vi.fn(),
  getQueuedTeamsByProject: vi.fn().mockReturnValue([]),
  updateTeam: vi.fn(),
  insertTransition: vi.fn(),
};

vi.mock('../../src/server/db.js', () => ({
  getDatabase: () => mockDb,
}));

vi.mock('../../src/server/config.js', () => ({
  default: {
    worktreeDir: '.claude/worktrees',
  },
}));

// Mock child_process.execSync for isProcessAlive
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// Mock fs for worktree scanning
const mockFs = {
  existsSync: vi.fn().mockReturnValue(false),
  readdirSync: vi.fn().mockReturnValue([]),
};
vi.mock('fs', () => ({
  default: {
    existsSync: (...args: unknown[]) => mockFs.existsSync(...args),
    readdirSync: (...args: unknown[]) => mockFs.readdirSync(...args),
  },
}));

// Mock team-manager (dynamic import in startup-recovery.ts)
const mockProcessQueue = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/server/services/team-manager.js', () => ({
  getTeamManager: () => ({
    processQueue: mockProcessQueue,
  }),
}));

// Import after mocks are set up
const { recoverOnStartup } = await import(
  '../../src/server/services/startup-recovery.js'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTeam(overrides: Partial<Team>): Partial<Team> {
  return {
    id: 1,
    issueNumber: 100,
    issueTitle: 'Test issue',
    projectId: 1,
    status: 'running',
    phase: 'implementing',
    pid: 12345,
    sessionId: 'sess-abc',
    worktreeName: 'test-100',
    branchName: 'feat/100-test',
    prNumber: null,
    customPrompt: null,
    launchedAt: new Date().toISOString(),
    stoppedAt: null,
    lastEventAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeProject(overrides?: Partial<Project>): Partial<Project> {
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
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.getActiveTeams.mockReturnValue([]);
  mockDb.getProjects.mockReturnValue([]);
  mockDb.getQueuedTeamsByProject.mockReturnValue([]);
  mockFs.existsSync.mockReturnValue(false);
  mockFs.readdirSync.mockReturnValue([]);
});

// =============================================================================
// Process reconciliation — dead PIDs
// =============================================================================

describe('Dead PID recovery', () => {
  it('marks running team with dead PID as idle', async () => {
    const team = makeTeam({ id: 1, status: 'running', pid: 9999 });
    mockDb.getActiveTeams.mockReturnValue([team]);
    // Simulate dead process: execSync throws (Windows) or process.kill throws (POSIX)
    mockExecSync.mockImplementation(() => {
      throw new Error('process not found');
    });

    await recoverOnStartup();

    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        fromStatus: 'running',
        toStatus: 'idle',
        trigger: 'system',
        reason: expect.stringContaining('no longer alive'),
      }),
    );
    expect(mockDb.updateTeam).toHaveBeenCalledWith(1, expect.objectContaining({
      status: 'idle',
      pid: null,
    }));
  });

  it('marks launching team with dead PID as failed', async () => {
    const team = makeTeam({ id: 2, status: 'launching', pid: 8888 });
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockExecSync.mockImplementation(() => {
      throw new Error('process not found');
    });

    await recoverOnStartup();

    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 2,
        fromStatus: 'launching',
        toStatus: 'failed',
        trigger: 'system',
      }),
    );
    expect(mockDb.updateTeam).toHaveBeenCalledWith(2, expect.objectContaining({
      status: 'failed',
      pid: null,
    }));
  });

  it('marks idle team with dead PID as idle (keeps idle)', async () => {
    const team = makeTeam({ id: 3, status: 'idle', pid: 7777 });
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockExecSync.mockImplementation(() => {
      throw new Error('process not found');
    });

    await recoverOnStartup();

    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 3,
        fromStatus: 'idle',
        toStatus: 'idle',
        trigger: 'system',
      }),
    );
    expect(mockDb.updateTeam).toHaveBeenCalledWith(3, expect.objectContaining({
      status: 'idle',
      pid: null,
    }));
  });

  it('marks stuck team with dead PID as idle', async () => {
    const team = makeTeam({ id: 4, status: 'stuck', pid: 6666 });
    mockDb.getActiveTeams.mockReturnValue([team]);
    mockExecSync.mockImplementation(() => {
      throw new Error('process not found');
    });

    await recoverOnStartup();

    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 4,
        fromStatus: 'stuck',
        toStatus: 'idle',
        trigger: 'system',
      }),
    );
    expect(mockDb.updateTeam).toHaveBeenCalledWith(4, expect.objectContaining({
      status: 'idle',
      pid: null,
    }));
  });
});

// =============================================================================
// Process reconciliation — alive PIDs
// =============================================================================

describe('Alive PID recovery', () => {
  it('updates lastEventAt for running team with alive PID', async () => {
    const team = makeTeam({ id: 5, status: 'running', pid: 5555 });
    mockDb.getActiveTeams.mockReturnValue([team]);
    // Simulate alive process on Windows: tasklist returns output containing the PID
    mockExecSync.mockReturnValue(`node.exe    5555 Console    1    50,000 K`);

    await recoverOnStartup();

    // Should not change status
    expect(mockDb.insertTransition).not.toHaveBeenCalled();
    // Should update lastEventAt
    expect(mockDb.updateTeam).toHaveBeenCalledWith(5, expect.objectContaining({
      lastEventAt: expect.any(String),
    }));
    // Should NOT set status or pid
    const updateCall = mockDb.updateTeam.mock.calls[0]![1];
    expect(updateCall).not.toHaveProperty('status');
    expect(updateCall).not.toHaveProperty('pid');
  });
});

// =============================================================================
// No PID recorded
// =============================================================================

describe('No PID recovery', () => {
  it('marks team with no PID as idle', async () => {
    const team = makeTeam({ id: 6, status: 'running', pid: null });
    mockDb.getActiveTeams.mockReturnValue([team]);

    await recoverOnStartup();

    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 6,
        fromStatus: 'running',
        toStatus: 'idle',
        trigger: 'system',
        reason: expect.stringContaining('no PID'),
      }),
    );
    expect(mockDb.updateTeam).toHaveBeenCalledWith(6, expect.objectContaining({
      status: 'idle',
    }));
  });

  it('skips queued teams entirely', async () => {
    const team = makeTeam({ id: 7, status: 'queued', pid: null });
    mockDb.getActiveTeams.mockReturnValue([team]);

    await recoverOnStartup();

    expect(mockDb.insertTransition).not.toHaveBeenCalled();
    expect(mockDb.updateTeam).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Orphan worktree detection
// =============================================================================

describe('Orphan worktree detection', () => {
  it('logs warning for orphan worktrees not tracked in database', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const project = makeProject({ id: 1, name: 'test-project', repoPath: '/tmp/repo' });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getQueuedTeamsByProject.mockReturnValue([]);
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue(['test-project-42']);
    mockDb.getTeamByWorktree.mockReturnValue(undefined);

    await recoverOnStartup();

    // The warning is a single string containing both "Orphan worktree" and the dir name
    const orphanCalls = consoleSpy.mock.calls.filter(
      (call) => String(call[0]).includes('Orphan worktree') && String(call[0]).includes('test-project-42'),
    );
    expect(orphanCalls.length).toBe(1);
    consoleSpy.mockRestore();
  });

  it('does not warn for worktrees tracked in database', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const project = makeProject({ id: 1, name: 'test-project', repoPath: '/tmp/repo' });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getQueuedTeamsByProject.mockReturnValue([]);
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue(['test-project-42']);
    mockDb.getTeamByWorktree.mockReturnValue({ id: 10 });

    await recoverOnStartup();

    // No orphan warning
    const orphanCalls = consoleSpy.mock.calls.filter(
      (call) => String(call[0]).includes('Orphan'),
    );
    expect(orphanCalls.length).toBe(0);
    consoleSpy.mockRestore();
  });

  it('skips worktree scan when no active projects exist', async () => {
    mockDb.getProjects.mockReturnValue([]);

    await recoverOnStartup();

    expect(mockFs.existsSync).not.toHaveBeenCalled();
    expect(mockFs.readdirSync).not.toHaveBeenCalled();
  });

  it('skips project when worktree directory does not exist', async () => {
    const project = makeProject({ id: 1, name: 'test-project', repoPath: '/tmp/repo' });
    mockDb.getProjects.mockReturnValue([project]);
    mockDb.getQueuedTeamsByProject.mockReturnValue([]);
    mockFs.existsSync.mockReturnValue(false);

    await recoverOnStartup();

    expect(mockDb.getTeamByWorktree).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Queue re-processing after recovery
// =============================================================================

describe('Queue re-processing after recovery', () => {
  it('triggers processQueue when queued teams exist', async () => {
    const project = makeProject({ id: 1, name: 'test-project', repoPath: '/tmp/repo' });
    mockDb.getProjects.mockReturnValue([project]);
    mockFs.existsSync.mockReturnValue(false);
    mockDb.getQueuedTeamsByProject.mockReturnValue([
      makeTeam({ id: 10, status: 'queued' }),
    ]);

    await recoverOnStartup();

    expect(mockProcessQueue).toHaveBeenCalledWith(1);
  });

  it('does not trigger processQueue when no queued teams exist', async () => {
    const project = makeProject({ id: 1, name: 'test-project', repoPath: '/tmp/repo' });
    mockDb.getProjects.mockReturnValue([project]);
    mockFs.existsSync.mockReturnValue(false);
    mockDb.getQueuedTeamsByProject.mockReturnValue([]);

    await recoverOnStartup();

    expect(mockProcessQueue).not.toHaveBeenCalled();
  });
});
