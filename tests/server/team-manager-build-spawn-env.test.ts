// =============================================================================
// Fleet Commander — TeamManager.buildSpawnEnv unit tests
// =============================================================================
// Verifies that buildSpawnEnv() correctly sets (or omits) the
// CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS env var based on config.enableAgentTeams,
// and that other expected env vars are always present.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock modules before importing TeamManager
// ---------------------------------------------------------------------------

// vi.hoisted ensures the object is available when vi.mock factories run
const mockConfig = vi.hoisted(() => ({
  worktreeDir: '.claude/worktrees',
  outputBufferLines: 500,
  claudeCmd: 'claude',
  skipPermissions: true,
  terminalCmd: 'auto' as const,
  enableAgentTeams: true,
}));

vi.mock('../../src/server/db.js', () => ({
  getDatabase: () => ({
    getProject: vi.fn(),
    getActiveTeamCountByProject: vi.fn(),
    getQueuedTeamsByProject: vi.fn(),
    getTeam: vi.fn(),
    updateTeam: vi.fn(),
    insertTransition: vi.fn(),
  }),
}));

vi.mock('../../src/server/config.js', () => ({
  default: mockConfig,
}));

vi.mock('../../src/server/services/sse-broker.js', () => ({
  sseBroker: {
    broadcast: vi.fn(),
    getSnapshot: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('../../src/server/utils/find-git-bash.js', () => ({
  findGitBash: vi.fn().mockReturnValue(null),
}));

import { TeamManager } from '../../src/server/services/team-manager.js';
import type { Project } from '../../src/shared/types.js';

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
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TeamManager.buildSpawnEnv', () => {
  let tm: TeamManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.enableAgentTeams = true;
    tm = new TeamManager();
  });

  it('includes CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS when enableAgentTeams is true', () => {
    mockConfig.enableAgentTeams = true;
    const project = makeProject();
    // Access private method via bracket notation for testing
    const env = (tm as unknown as Record<string, Function>)['buildSpawnEnv'](project, 'test-project-42', 1);
    expect(env['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS']).toBe('1');
  });

  it('sets CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS to undefined when enableAgentTeams is false', () => {
    mockConfig.enableAgentTeams = false;
    const project = makeProject();
    const env = (tm as unknown as Record<string, Function>)['buildSpawnEnv'](project, 'test-project-42', 1);
    expect(env['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS']).toBeUndefined();
  });

  it('always includes FLEET_TEAM_ID and FLEET_PROJECT_ID', () => {
    const project = makeProject();
    const env = (tm as unknown as Record<string, Function>)['buildSpawnEnv'](project, 'my-worktree', 7);
    expect(env['FLEET_TEAM_ID']).toBe('my-worktree');
    expect(env['FLEET_PROJECT_ID']).toBe('7');
  });

  it('always includes FLEET_GITHUB_REPO from the project', () => {
    const project = makeProject({ githubRepo: 'acme/widgets' });
    const env = (tm as unknown as Record<string, Function>)['buildSpawnEnv'](project, 'acme-widgets-1', 1);
    expect(env['FLEET_GITHUB_REPO']).toBe('acme/widgets');
  });

  it('defaults FLEET_GITHUB_REPO to empty string when project has no githubRepo', () => {
    const project = makeProject({ githubRepo: null as unknown as string });
    const env = (tm as unknown as Record<string, Function>)['buildSpawnEnv'](project, 'test-1', 1);
    expect(env['FLEET_GITHUB_REPO']).toBe('');
  });

  it('inherits process.env entries', () => {
    // process.env.PATH should be inherited
    const project = makeProject();
    const env = (tm as unknown as Record<string, Function>)['buildSpawnEnv'](project, 'test-1', 1);
    expect(env['PATH']).toBeDefined();
  });

  it('includes CLAUDE_CODE_GIT_BASH_PATH when findGitBash returns a path', async () => {
    // Re-import with different mock
    const { findGitBash } = await import('../../src/server/utils/find-git-bash.js');
    (findGitBash as ReturnType<typeof vi.fn>).mockReturnValue('C:/Program Files/Git/bin/bash.exe');

    const project = makeProject();
    const env = (tm as unknown as Record<string, Function>)['buildSpawnEnv'](project, 'test-1', 1);
    expect(env['CLAUDE_CODE_GIT_BASH_PATH']).toBe('C:/Program Files/Git/bin/bash.exe');
  });
});
