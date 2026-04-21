// =============================================================================
// Fleet Commander -- Projects Routes: HTTP contract tests
// =============================================================================
// Tests the projects route plugin for correct HTTP status codes, response shapes,
// parameter validation, and ServiceError-to-HTTP mapping. Uses mocked services
// with a real temp SQLite database.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import os from 'os';
import path from 'path';
import fs from 'fs';

import { getDatabase, closeDatabase } from '../../../src/server/db.js';
import { sseBroker } from '../../../src/server/services/sse-broker.js';

// ---------------------------------------------------------------------------
// Service mocks -- must be set up BEFORE importing the route plugin
// ---------------------------------------------------------------------------

vi.mock('../../../src/server/services/team-manager.js', () => ({
  getTeamManager: vi.fn(() => ({
    sendMessage: vi.fn(),
    getOutput: vi.fn().mockReturnValue([]),
    getParsedEvents: vi.fn().mockReturnValue([]),
    launch: vi.fn().mockResolvedValue({ id: 1, status: 'launching' }),
    stop: vi.fn().mockResolvedValue({ id: 1, status: 'done' }),
    stopAll: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('../../../src/server/services/issue-fetcher.js', () => ({
  getIssueFetcher: vi.fn(() => ({
    fetch: vi.fn().mockResolvedValue([]),
    fetchDependenciesForIssue: vi.fn().mockResolvedValue(null),
    enrichWithTeamInfo: vi.fn().mockReturnValue([]),
    getIssues: vi.fn().mockResolvedValue([]),
    getIssuesByProject: vi.fn().mockReturnValue([]),
    getCachedAt: vi.fn().mockReturnValue(null),
    getAvailableIssues: vi.fn().mockReturnValue([]),
    getIssue: vi.fn().mockReturnValue(null),
    clearProject: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock('../../../src/server/services/github-poller.js', () => ({
  githubPoller: {
    getRecentPRs: vi.fn().mockReturnValue([]),
    trackBlockedIssue: vi.fn(),
  },
}));

// Mock exec-gh to prevent real CLI calls in ProjectService
vi.mock('../../../src/server/utils/exec-gh.js', () => ({
  execGitAsync: vi.fn().mockResolvedValue('true'),
  execGHAsync: vi.fn().mockResolvedValue(null),
  execGHResult: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 1 }),
  isValidGithubRepo: vi.fn().mockReturnValue(true),
}));

// Mock hook-installer to prevent filesystem side effects
vi.mock('../../../src/server/utils/hook-installer.js', () => ({
  installHooks: vi.fn(),
  uninstallHooks: vi.fn(),
}));

// Mock child_process to prevent real exec calls
vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue(Buffer.from('')),
}));

// Import routes AFTER mocks
import projectsRoutes from '../../../src/server/routes/projects.js';

// ---------------------------------------------------------------------------
// Test-level state
// ---------------------------------------------------------------------------

let server: FastifyInstance;
let dbPath: string;

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  dbPath = path.join(
    os.tmpdir(),
    `fleet-proj-routes-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );

  closeDatabase();
  process.env['FLEET_DB_PATH'] = dbPath;
  getDatabase(dbPath);

  server = Fastify({ logger: false });
  await server.register(projectsRoutes);
  await server.ready();
});

afterAll(async () => {
  sseBroker.stop();
  await server.close();
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
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let projectCounter = 0;

function seedProject(overrides: {
  name?: string;
  repoPath?: string;
  githubRepo?: string | null;
  status?: string;
} = {}) {
  projectCounter++;
  const db = getDatabase();
  return db.insertProject({
    name: overrides.name ?? `test-project-${Date.now()}-${projectCounter}`,
    repoPath: overrides.repoPath ?? `C:/fake/repo-${Date.now()}-${projectCounter}`,
    githubRepo: overrides.githubRepo ?? null,
  });
}

function seedTeam(overrides: {
  issueNumber?: number;
  worktreeName?: string;
  projectId?: number;
  status?: string;
} = {}) {
  const db = getDatabase();
  return db.insertTeam({
    issueNumber: overrides.issueNumber ?? 100,
    worktreeName: overrides.worktreeName ?? `proj-team-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    status: (overrides.status as 'running') ?? 'running',
    phase: 'implementing' as 'implementing',
    projectId: overrides.projectId ?? null,
  });
}

// =============================================================================
// Tests: GET /api/projects
// =============================================================================

describe('GET /api/projects', () => {
  it('should return array of projects with 200', async () => {
    seedProject();

    const res = await server.inject({ method: 'GET', url: '/api/projects' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it('should filter by status=active', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/projects?status=active' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

// =============================================================================
// Tests: GET /api/projects/:id
// =============================================================================

describe('GET /api/projects/:id', () => {
  it('should return project detail with 200', async () => {
    const project = seedProject();

    const res = await server.inject({ method: 'GET', url: `/api/projects/${project.id}` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(project.id);
    expect(body.name).toBe(project.name);
  });

  it('should return 404 for unknown project', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/projects/99999' });
    expect(res.statusCode).toBe(404);
  });

  it('should return 400 for non-numeric ID', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/projects/abc' });
    expect(res.statusCode).toBe(400);
  });

  it('should return 400 for negative ID', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/projects/-1' });
    expect(res.statusCode).toBe(400);
  });
});

// =============================================================================
// Tests: POST /api/projects
// =============================================================================

describe('POST /api/projects', () => {
  it('should return 400 for missing name', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { repoPath: 'C:/some/path' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('should return 400 for missing repoPath', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'test-project' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('should return 400 for empty name', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '', repoPath: 'C:/some/path' },
    });

    expect(res.statusCode).toBe(400);
  });
});

// =============================================================================
// Tests: PUT /api/projects/:id
// =============================================================================

describe('PUT /api/projects/:id', () => {
  it('should return 200 on success', async () => {
    const project = seedProject();

    const res = await server.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}`,
      payload: { name: 'updated-name' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('updated-name');
  });

  it('should return 404 for unknown project', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/projects/99999',
      payload: { name: 'updated-name' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('should return 400 for non-numeric ID', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/projects/abc',
      payload: { name: 'updated-name' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('should accept a valid effort value', async () => {
    const project = seedProject();

    const res = await server.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}`,
      payload: { effort: 'high' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().effort).toBe('high');

    // Confirm via GET
    const getRes = await server.inject({ method: 'GET', url: `/api/projects/${project.id}` });
    expect(getRes.json().effort).toBe('high');
  });

  it('should reject invalid effort with 400', async () => {
    const project = seedProject();

    const res = await server.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}`,
      payload: { effort: 'extreme' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('should coerce empty-string effort to null', async () => {
    const project = seedProject();
    // First set it to something non-null
    await server.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}`,
      payload: { effort: 'max' },
    });

    // Now clear with empty string
    const res = await server.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}`,
      payload: { effort: '' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().effort).toBeNull();
  });

  it('should clear effort when explicitly set to null', async () => {
    const project = seedProject();
    await server.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}`,
      payload: { effort: 'low' },
    });

    const res = await server.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}`,
      payload: { effort: null },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().effort).toBeNull();
  });
});

// =============================================================================
// Tests: DELETE /api/projects/:id
// =============================================================================

describe('DELETE /api/projects/:id', () => {
  it('should return 200 on success', async () => {
    const project = seedProject();

    const res = await server.inject({
      method: 'DELETE',
      url: `/api/projects/${project.id}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it('should return 404 for unknown project', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: '/api/projects/99999',
    });

    expect(res.statusCode).toBe(404);
  });

  it('should return 400 for non-numeric ID', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: '/api/projects/abc',
    });

    expect(res.statusCode).toBe(400);
  });
});

// =============================================================================
// Tests: POST /api/projects/:id/install
// =============================================================================

describe('POST /api/projects/:id/install', () => {
  it('should return 404 for unknown project', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/projects/99999/install',
    });

    expect(res.statusCode).toBe(404);
  });

  it('should return 400 for non-numeric ID', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/projects/abc/install',
    });

    expect(res.statusCode).toBe(400);
  });
});

// =============================================================================
// Tests: GET /api/projects/:id/teams
// =============================================================================

describe('GET /api/projects/:id/teams', () => {
  it('should return teams for project', async () => {
    const project = seedProject();
    seedTeam({ projectId: project.id, issueNumber: 500, worktreeName: `proj-teams-${Date.now()}` });

    const res = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/teams`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('should return 404 for unknown project', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/projects/99999/teams',
    });

    expect(res.statusCode).toBe(404);
  });

  it('should return 400 for non-numeric ID', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/projects/abc/teams',
    });

    expect(res.statusCode).toBe(400);
  });
});

// =============================================================================
// =============================================================================
// Tests: GET /api/projects/:id/cleanup-preview
// =============================================================================

describe('GET /api/projects/:id/cleanup-preview', () => {
  it('should return 404 for unknown project', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/projects/99999/cleanup-preview',
    });

    expect(res.statusCode).toBe(404);
  });

  it('should return 400 for non-numeric ID', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/projects/abc/cleanup-preview',
    });

    expect(res.statusCode).toBe(400);
  });
});
