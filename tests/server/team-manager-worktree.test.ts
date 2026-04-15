// =============================================================================
// Fleet Commander — TeamManager worktree & sync tests
// =============================================================================
// Tests for:
//   - createWorktree passes timeout to execAsync
//   - syncWithOrigin event is captured in parsedEvents when pre-initialized
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted ensures these are available when vi.mock factories run
// ---------------------------------------------------------------------------

const mockDb = vi.hoisted(() => ({
  getProject: vi.fn(),
  getTeam: vi.fn(),
  getActiveTeams: vi.fn().mockReturnValue([]),
  getActiveTeamCountByProject: vi.fn().mockReturnValue(0),
  getQueuedTeamsByProject: vi.fn().mockReturnValue([]),
  updateTeam: vi.fn(),
  updateTeamSilent: vi.fn(),
  insertTransition: vi.fn(),
  getPullRequest: vi.fn(),
  insertEvent: vi.fn(),
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
    terminal: 'auto',
    mergeShutdownGraceMs: 120000,
    fleetCommanderRoot: '/tmp/fleet',
    mapCleanupIntervalMs: 3600000,
    fcHooksDir: '/tmp/fleet/hooks',
    hookDir: '.claude/hooks',
    fcAgentsDir: '/tmp/fleet/agents',
    fcGuidesDir: '/tmp/fleet/guides',
    fcWorkflowTemplate: '/tmp/fleet/templates/workflow.md',
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
  resolveMessage: vi.fn().mockReturnValue('Shutdown message for PR'),
}));

vi.mock('../../src/server/services/usage-tracker.js', () => ({
  getUsageZone: vi.fn().mockReturnValue('green'),
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

// ---------------------------------------------------------------------------
// Mock child_process.exec + util.promisify to intercept execAsync calls
// ---------------------------------------------------------------------------

const mockExec = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  exec: (...args: unknown[]) => mockExec(...args),
  execSync: vi.fn(),
  spawn: vi.fn(),
  ChildProcess: class {},
}));

vi.mock('util', async () => {
  return {
    promisify: (fn: unknown) => {
      // Return a function that wraps mockExec into a Promise and captures
      // the options (including timeout) passed by the caller.
      return (...args: unknown[]) => {
        return new Promise((resolve, reject) => {
          (fn as Function)(...args, (err: Error | null, result: unknown) => {
            if (err) reject(err);
            else resolve(result);
          });
        });
      };
    },
  };
});

// Mock fs — only existsSync is needed for createWorktree
const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn().mockReturnValue(false),
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
  readFileSync: vi.fn().mockReturnValue(''),
  writeFileSync: vi.fn(),
  statSync: vi.fn().mockReturnValue({ isDirectory: () => false }),
  rmSync: vi.fn(),
}));

vi.mock('fs', () => ({
  default: mockFs,
  ...mockFs,
}));

// Mock cc-spawn (uses child_process and execa internally)
vi.mock('../../src/server/utils/cc-spawn.js', () => ({
  spawnHeadless: vi.fn(),
  spawnInteractive: vi.fn(),
}));

// Mock fc-manifest (uses fs internally)
vi.mock('../../src/server/utils/fc-manifest.js', () => ({
  getHookFiles: vi.fn().mockReturnValue([]),
  getAgentFiles: vi.fn().mockReturnValue([]),
  getGuideFiles: vi.fn().mockReturnValue([]),
  getWorkflowFile: vi.fn().mockReturnValue(null),
  getGitignoreEntries: vi.fn().mockReturnValue([
    '.claude/agents/fleet-dev.md',
    '.claude/agents/fleet-planner.md',
    '.claude/agents/fleet-reviewer.md',
    '.claude/settings.json',
    '.claude/prompts/fleet-workflow.md',
    '.claude/scheduled_tasks.lock',
    'changes.md',
    'review.md',
    'plan.md',
    '.fleet-issue-context.md',
    '.fleet-pm-message',
  ]),
}));

// Mock event-collector
vi.mock('../../src/server/services/event-collector.js', () => ({
  classifyAgentRole: vi.fn().mockReturnValue('tl'),
  shouldAdvancePhase: vi.fn().mockReturnValue(false),
}));

// Mock exec-gh
vi.mock('../../src/server/utils/exec-gh.js', () => ({
  isValidGithubRepo: vi.fn().mockResolvedValue(true),
}));

// Mock issue-context-generator
vi.mock('../../src/server/services/issue-context-generator.js', () => ({
  generateIssueContext: vi.fn().mockResolvedValue(undefined),
}));

import { TeamManager } from '../../src/server/services/team-manager.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TeamManager.createWorktree', () => {
  let tm: TeamManager;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset fs.existsSync to false (createWorktree skips when dir exists)
    mockFs.existsSync.mockReturnValue(false);
    tm = new TeamManager();
  });

  it('should pass 30s timeout to both execAsync calls', async () => {
    // First call (with -b) succeeds
    mockExec.mockImplementation(
      (_cmd: string, _opts: unknown, cb: Function) => cb(null, { stdout: '', stderr: '' }),
    );

    const result = await (tm as any).createWorktree(
      '/tmp/repo', '.claude/worktrees/proj-10', '/tmp/repo/.claude/worktrees/proj-10',
      'feat/10-test', 1, 'queued',
    );

    expect(result).toBe(true);
    // Verify the exec call included timeout: 30000
    expect(mockExec).toHaveBeenCalledTimes(1);
    const callArgs = mockExec.mock.calls[0];
    expect(callArgs[0]).toContain('worktree add');
    expect(callArgs[0]).toContain('-b');
    expect(callArgs[1]).toEqual({ timeout: 30000 });
  });

  it('should pass 30s timeout to fallback execAsync call (without -b)', async () => {
    // First call (with -b) fails, second call (without -b) succeeds
    let callCount = 0;
    mockExec.mockImplementation(
      (_cmd: string, _opts: unknown, cb: Function) => {
        callCount++;
        if (callCount === 1) {
          cb(new Error('branch already exists'), null);
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
      },
    );

    const result = await (tm as any).createWorktree(
      '/tmp/repo', '.claude/worktrees/proj-10', '/tmp/repo/.claude/worktrees/proj-10',
      'feat/10-test', 1, 'queued',
    );

    expect(result).toBe(true);
    expect(mockExec).toHaveBeenCalledTimes(2);
    // Both calls should include timeout: 30000
    expect(mockExec.mock.calls[0][1]).toEqual({ timeout: 30000 });
    expect(mockExec.mock.calls[1][1]).toEqual({ timeout: 30000 });
  });

  it('should skip creation when worktree directory already exists', async () => {
    mockFs.existsSync.mockReturnValue(true);

    const result = await (tm as any).createWorktree(
      '/tmp/repo', '.claude/worktrees/proj-10', '/tmp/repo/.claude/worktrees/proj-10',
      'feat/10-test', 1, 'queued',
    );

    expect(result).toBe(true);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('should transition team to failed when both execAsync calls fail', async () => {
    mockExec.mockImplementation(
      (_cmd: string, _opts: unknown, cb: Function) => {
        cb(new Error('git worktree error'), null);
      },
    );

    const result = await (tm as any).createWorktree(
      '/tmp/repo', '.claude/worktrees/proj-10', '/tmp/repo/.claude/worktrees/proj-10',
      'feat/10-test', 1, 'queued',
    );

    expect(result).toBe(false);
    expect(mockDb.insertTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 1,
        fromStatus: 'queued',
        toStatus: 'failed',
        trigger: 'system',
      }),
    );
    expect(mockDb.updateTeamSilent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'failed' }),
    );
  });
});

describe('TeamManager.syncWithOrigin', () => {
  let tm: TeamManager;

  beforeEach(() => {
    vi.clearAllMocks();
    tm = new TeamManager();
  });

  it('should capture sync event in parsedEvents when array is pre-initialized', async () => {
    const teamId = 42;
    const events: unknown[] = [];
    (tm as any).parsedEvents.set(teamId, events);

    // Mock git fetch, symbolic-ref, rev-list all succeeding
    mockExec.mockImplementation(
      (cmd: string, _opts: unknown, cb: Function) => {
        if (cmd.includes('fetch')) {
          cb(null, { stdout: '', stderr: '' });
        } else if (cmd.includes('symbolic-ref')) {
          cb(null, { stdout: 'refs/remotes/origin/main', stderr: '' });
        } else if (cmd.includes('rev-list')) {
          cb(null, { stdout: '0', stderr: '' });
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
      },
    );

    await (tm as any).syncWithOrigin('/tmp/repo', teamId);

    // The sync event should be pushed into the parsedEvents array
    expect(events.length).toBe(1);
    const event = events[0] as Record<string, unknown>;
    expect(event.type).toBe('fc');
    expect(event.subtype).toBe('origin_sync');
    expect(event.agentName).toBe('__fc__');
  });

  it('should NOT capture sync event when parsedEvents is not initialized', async () => {
    const teamId = 99;
    // Do NOT initialize parsedEvents for this team — simulates the old bug

    mockExec.mockImplementation(
      (_cmd: string, _opts: unknown, cb: Function) => {
        cb(null, { stdout: '0', stderr: '' });
      },
    );

    await (tm as any).syncWithOrigin('/tmp/repo', teamId);

    // parsedEvents was never initialized, so the event is silently dropped
    expect((tm as any).parsedEvents.has(teamId)).toBe(false);
  });

  it('should broadcast team_output SSE event for sync', async () => {
    const teamId = 7;
    (tm as any).parsedEvents.set(teamId, []);

    mockExec.mockImplementation(
      (_cmd: string, _opts: unknown, cb: Function) => {
        cb(null, { stdout: '0', stderr: '' });
      },
    );

    await (tm as any).syncWithOrigin('/tmp/repo', teamId);

    expect(mockSseBroker.broadcast).toHaveBeenCalledWith(
      'team_output',
      expect.objectContaining({ team_id: teamId }),
      teamId,
    );
  });
});

describe('TeamManager.copyFCFiles gitignore', () => {
  let tm: TeamManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(false);
    mockFs.readFileSync.mockReturnValue('');
    tm = new TeamManager();
  });

  it('should add all FC-managed entries to gitignore', () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('.gitignore')) return true;
      return false;
    });
    mockFs.readFileSync.mockReturnValue('node_modules\n');

    (tm as any).copyFCFiles('/tmp/worktree');

    const gitignoreCall = mockFs.writeFileSync.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('.gitignore'),
    );
    expect(gitignoreCall).toBeDefined();
    const writtenContent = gitignoreCall![1] as string;
    // Verify all entries from getGitignoreEntries() are present
    expect(writtenContent).toContain('.claude/agents/fleet-dev.md');
    expect(writtenContent).toContain('.claude/agents/fleet-planner.md');
    expect(writtenContent).toContain('.claude/agents/fleet-reviewer.md');
    expect(writtenContent).toContain('.claude/settings.json');
    expect(writtenContent).toContain('.claude/prompts/fleet-workflow.md');
    expect(writtenContent).toContain('.claude/scheduled_tasks.lock');
    expect(writtenContent).toContain('changes.md');
    expect(writtenContent).toContain('review.md');
    expect(writtenContent).toContain('plan.md');
    expect(writtenContent).toContain('.fleet-issue-context.md');
    expect(writtenContent).toContain('.fleet-pm-message');
    // Verify the header comment is present
    expect(writtenContent).toContain('# Fleet Commander managed files');
    // Verify existing content is preserved
    expect(writtenContent).toContain('node_modules');
  });

  it('should not duplicate entries if all already present in gitignore', () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('.gitignore')) return true;
      return false;
    });
    // All 11 entries already present
    mockFs.readFileSync.mockReturnValue(
      '.claude/agents/fleet-dev.md\n' +
      '.claude/agents/fleet-planner.md\n' +
      '.claude/agents/fleet-reviewer.md\n' +
      '.claude/settings.json\n' +
      '.claude/prompts/fleet-workflow.md\n' +
      '.claude/scheduled_tasks.lock\n' +
      'changes.md\n' +
      'review.md\n' +
      'plan.md\n' +
      '.fleet-issue-context.md\n' +
      '.fleet-pm-message\n',
    );

    (tm as any).copyFCFiles('/tmp/worktree');

    // Should not write gitignore at all since all entries are already present
    const gitignoreCall = mockFs.writeFileSync.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('.gitignore'),
    );
    expect(gitignoreCall).toBeUndefined();
  });

  it('should only add missing entries when some already exist', () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('.gitignore')) return true;
      return false;
    });
    // Only plan.md and review.md already present
    mockFs.readFileSync.mockReturnValue('plan.md\nreview.md\n');

    (tm as any).copyFCFiles('/tmp/worktree');

    const gitignoreCall = mockFs.writeFileSync.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('.gitignore'),
    );
    expect(gitignoreCall).toBeDefined();
    const writtenContent = gitignoreCall![1] as string;
    // The new entries should be present
    expect(writtenContent).toContain('.claude/agents/fleet-dev.md');
    expect(writtenContent).toContain('.fleet-pm-message');
    // But the full content should only have one instance of plan.md and review.md
    const planCount = (writtenContent.match(/^plan\.md$/gm) || []).length;
    expect(planCount).toBe(1);
  });

  it('should handle CRLF line endings in existing gitignore', () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('.gitignore')) return true;
      return false;
    });
    // CRLF line endings with plan.md already present
    mockFs.readFileSync.mockReturnValue('node_modules\r\nplan.md\r\n');

    (tm as any).copyFCFiles('/tmp/worktree');

    const gitignoreCall = mockFs.writeFileSync.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('.gitignore'),
    );
    expect(gitignoreCall).toBeDefined();
    const writtenContent = gitignoreCall![1] as string;
    // Should not duplicate plan.md
    const planCount = (writtenContent.match(/plan\.md/g) || []).length;
    expect(planCount).toBe(1);
    // Output should use LF only (no CRLF)
    expect(writtenContent).not.toContain('\r');
  });
});
