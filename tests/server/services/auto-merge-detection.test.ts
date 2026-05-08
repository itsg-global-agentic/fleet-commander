// =============================================================================
// Fleet Commander -- Auto-merge detection tests (issue #710)
// =============================================================================
// Tests refreshAutoMergeForProject() — the function that fetches the GitHub
// repo's `allow_auto_merge` setting via `gh api`, persists the boolean on the
// projects row, and broadcasts SSE only when the value actually changes.
//
// We mock execGHAsync at the exec-gh module boundary so the cross-module call
// from refreshAutoMergeForProject -> checkRepoSettings -> execGHAsync can be
// intercepted (vi.spyOn does not work across ESM module bindings).
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE importing project-service
// ---------------------------------------------------------------------------

const mockExecGHAsync = vi.hoisted(() => vi.fn());
const mockExecGitAsync = vi.hoisted(() => vi.fn());

vi.mock('../../../src/server/utils/exec-gh.js', () => ({
  execGHAsync: (...args: unknown[]) => mockExecGHAsync(...args),
  execGitAsync: (...args: unknown[]) => mockExecGitAsync(...args),
  execGHResult: vi.fn(),
  isValidGithubRepo: (repo: string) =>
    /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo),
  isValidBranchName: (branch: string) => /^[a-zA-Z0-9._/\-]+$/.test(branch),
}));

const mockBroadcast = vi.hoisted(() => vi.fn());

vi.mock('../../../src/server/services/sse-broker.js', () => ({
  sseBroker: {
    broadcast: mockBroadcast,
    stop: vi.fn(),
  },
}));

// Import AFTER mocks
import { getDatabase, closeDatabase } from '../../../src/server/db.js';
import { refreshAutoMergeForProject } from '../../../src/server/services/project-service.js';

// ---------------------------------------------------------------------------
// Test-level state
// ---------------------------------------------------------------------------

let dbPath: string;

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

beforeAll(() => {
  dbPath = path.join(
    os.tmpdir(),
    `fleet-auto-merge-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );

  closeDatabase();
  process.env['FLEET_DB_PATH'] = dbPath;
  getDatabase(dbPath);
});

afterAll(() => {
  closeDatabase();

  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      // best effort
    }
  }

  delete process.env['FLEET_DB_PATH'];
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default: gh returns { allow_auto_merge: false } for repos query and null
  // for branch protection (404 = not configured). Individual tests override.
  mockExecGHAsync.mockImplementation(async (cmd: string) => {
    if (cmd.includes('/branches/')) return null;
    if (cmd.includes('/repos/') || cmd.includes('repos/')) {
      return JSON.stringify({ allow_auto_merge: false, default_branch: 'main' });
    }
    return null;
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nameCounter = 0;
function unique(prefix: string): string {
  nameCounter++;
  return `${prefix}-${Date.now()}-${nameCounter}-${Math.random().toString(36).slice(2)}`;
}

function seedGithubProject(githubRepo: string | null = 'owner/repo') {
  const db = getDatabase();
  return db.insertProject({
    name: unique('auto-merge-proj'),
    repoPath: `/tmp/${unique('auto-merge-repo')}`,
    githubRepo,
    issueProvider: 'github',
  });
}

function seedJiraProject() {
  const db = getDatabase();
  return db.insertProject({
    name: unique('auto-merge-jira-proj'),
    repoPath: `/tmp/${unique('auto-merge-jira-repo')}`,
    githubRepo: null,
    issueProvider: 'jira',
    projectKey: 'PROJ',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('refreshAutoMergeForProject', () => {
  it('returns null and writes checkedAt for a project with no githubRepo', async () => {
    const project = seedGithubProject(null);

    const result = await refreshAutoMergeForProject(project.id);

    expect(result).toBeNull();
    expect(mockExecGHAsync).not.toHaveBeenCalled();

    // Verify checkedAt was bumped
    const reloaded = getDatabase().getProject(project.id)!;
    expect(reloaded.autoMergeEnabled).toBeNull();
    expect(reloaded.autoMergeCheckedAt).not.toBeNull();
  });

  it('returns null and writes checkedAt for a non-GitHub (jira) project', async () => {
    const project = seedJiraProject();

    const result = await refreshAutoMergeForProject(project.id);

    expect(result).toBeNull();
    expect(mockExecGHAsync).not.toHaveBeenCalled();

    const reloaded = getDatabase().getProject(project.id)!;
    expect(reloaded.autoMergeEnabled).toBeNull();
    expect(reloaded.autoMergeCheckedAt).not.toBeNull();
  });

  it('does NOT call gh when skipIfFresh is true and check is recent', async () => {
    const project = seedGithubProject('owner/repo');

    // Pre-populate a recent autoMergeCheckedAt and autoMergeEnabled
    getDatabase().updateProject(project.id, {
      autoMergeEnabled: true,
      autoMergeCheckedAt: new Date().toISOString(),
    });

    const result = await refreshAutoMergeForProject(project.id, {
      skipIfFresh: true,
    });

    expect(result).toBe(true); // returns cached
    expect(mockExecGHAsync).not.toHaveBeenCalled();
  });

  it('DOES call gh when skipIfFresh is false even with a recent check', async () => {
    const project = seedGithubProject('owner/repo');

    getDatabase().updateProject(project.id, {
      autoMergeEnabled: true,
      autoMergeCheckedAt: new Date().toISOString(),
    });

    // Override default mock to return false this time
    mockExecGHAsync.mockImplementation(async (cmd: string) => {
      if (cmd.includes('/branches/')) return null;
      return JSON.stringify({ allow_auto_merge: false, default_branch: 'main' });
    });

    const result = await refreshAutoMergeForProject(project.id, {
      skipIfFresh: false,
    });

    expect(result).toBe(false);
    expect(mockExecGHAsync).toHaveBeenCalled();

    const reloaded = getDatabase().getProject(project.id)!;
    expect(reloaded.autoMergeEnabled).toBe(false);
  });

  it('persists the value returned by gh on success (true)', async () => {
    const project = seedGithubProject('owner/repo');

    mockExecGHAsync.mockImplementation(async (cmd: string) => {
      if (cmd.includes('/branches/')) return null;
      return JSON.stringify({ allow_auto_merge: true, default_branch: 'main' });
    });

    const result = await refreshAutoMergeForProject(project.id);

    expect(result).toBe(true);

    const reloaded = getDatabase().getProject(project.id)!;
    expect(reloaded.autoMergeEnabled).toBe(true);
    expect(reloaded.autoMergeCheckedAt).not.toBeNull();
  });

  it('preserves prior autoMergeEnabled when gh fails (returns null)', async () => {
    const project = seedGithubProject('owner/repo');

    // Seed a known prior value with stale checkedAt (48h ago)
    getDatabase().updateProject(project.id, {
      autoMergeEnabled: true,
      autoMergeCheckedAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
    });

    // Simulate gh failure: execGHAsync returns null
    mockExecGHAsync.mockResolvedValue(null);

    const result = await refreshAutoMergeForProject(project.id);

    expect(result).toBe(true); // unchanged

    const reloaded = getDatabase().getProject(project.id)!;
    expect(reloaded.autoMergeEnabled).toBe(true);
    // checkedAt advanced (so we throttle retries)
    expect(reloaded.autoMergeCheckedAt).not.toBeNull();
    const newCheckedAtMs = new Date(reloaded.autoMergeCheckedAt!).getTime();
    expect(Date.now() - newCheckedAtMs).toBeLessThan(60_000);
  });

  it('broadcasts project_updated only when the value actually changes', async () => {
    const project = seedGithubProject('owner/repo');

    // First call — value goes from null to true. Should broadcast.
    mockExecGHAsync.mockImplementation(async (cmd: string) => {
      if (cmd.includes('/branches/')) return null;
      return JSON.stringify({ allow_auto_merge: true, default_branch: 'main' });
    });

    await refreshAutoMergeForProject(project.id);

    expect(mockBroadcast).toHaveBeenCalledWith(
      'project_updated',
      expect.objectContaining({ project_id: project.id }),
    );

    mockBroadcast.mockClear();

    // Second call — value stays true. Should NOT broadcast.
    await refreshAutoMergeForProject(project.id);

    expect(mockBroadcast).not.toHaveBeenCalled();

    // Third call — value flips to false. Should broadcast.
    mockExecGHAsync.mockImplementation(async (cmd: string) => {
      if (cmd.includes('/branches/')) return null;
      return JSON.stringify({ allow_auto_merge: false, default_branch: 'main' });
    });

    await refreshAutoMergeForProject(project.id);

    expect(mockBroadcast).toHaveBeenCalledWith(
      'project_updated',
      expect.objectContaining({ project_id: project.id }),
    );
  });

  it('returns null for a missing project id', async () => {
    const result = await refreshAutoMergeForProject(999_999);
    expect(result).toBeNull();
    expect(mockExecGHAsync).not.toHaveBeenCalled();
  });
});
