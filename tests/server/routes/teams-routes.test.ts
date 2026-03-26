// =============================================================================
// Fleet Commander -- Teams Routes: HTTP contract tests
// =============================================================================
// Tests the teams route plugin for correct HTTP status codes, response shapes,
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

vi.mock('../../../src/server/services/team-manager.js', () => {
  const mockSendMessage = vi.fn();
  const mockGetOutput = vi.fn().mockReturnValue([]);
  const mockGetParsedEvents = vi.fn().mockReturnValue([]);
  const mockLaunch = vi.fn().mockResolvedValue({ id: 99, status: 'launching' });
  const mockStop = vi.fn().mockResolvedValue({ id: 1, status: 'done' });
  const mockStopAll = vi.fn().mockResolvedValue([]);
  const mockForceLaunch = vi.fn().mockResolvedValue({ id: 1, status: 'launching' });
  const mockResume = vi.fn().mockResolvedValue({ id: 1, status: 'running' });
  const mockRestart = vi.fn().mockResolvedValue({ id: 1, status: 'launching' });
  const mockLaunchBatch = vi.fn().mockResolvedValue([]);
  const mockQueueTeamWithBlockers = vi.fn().mockResolvedValue({ id: 1, status: 'queued' });

  return {
    getTeamManager: vi.fn(() => ({
      sendMessage: mockSendMessage,
      getOutput: mockGetOutput,
      getParsedEvents: mockGetParsedEvents,
      launch: mockLaunch,
      stop: mockStop,
      stopAll: mockStopAll,
      forceLaunch: mockForceLaunch,
      resume: mockResume,
      restart: mockRestart,
      launchBatch: mockLaunchBatch,
      queueTeamWithBlockers: mockQueueTeamWithBlockers,
    })),
  };
});

vi.mock('../../../src/server/services/issue-fetcher.js', () => ({
  getIssueFetcher: vi.fn(() => ({
    fetch: vi.fn().mockResolvedValue([]),
    fetchDependenciesForIssue: vi.fn().mockResolvedValue(null),
    enrichWithTeamInfo: vi.fn().mockReturnValue([]),
    getNextIssue: vi.fn().mockReturnValue(null),
    getIssues: vi.fn().mockResolvedValue([]),
    getIssuesByProject: vi.fn().mockReturnValue([]),
    getCachedAt: vi.fn().mockReturnValue(null),
    getAvailableIssues: vi.fn().mockReturnValue([]),
    getIssue: vi.fn().mockReturnValue(null),
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

// Import routes AFTER mocks
import teamsRoutes from '../../../src/server/routes/teams.js';
import { getTeamManager } from '../../../src/server/services/team-manager.js';

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
    `fleet-teams-routes-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );

  closeDatabase();
  process.env['FLEET_DB_PATH'] = dbPath;
  getDatabase(dbPath);

  server = Fastify({ logger: false });
  await server.register(teamsRoutes);
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

let teamCounter = 0;

function seedTeam(overrides: {
  issueNumber?: number;
  worktreeName?: string;
  status?: string;
  phase?: string;
  projectId?: number;
  prNumber?: number | null;
} = {}) {
  teamCounter++;
  const db = getDatabase();
  return db.insertTeam({
    issueNumber: overrides.issueNumber ?? 1000 + teamCounter,
    worktreeName: overrides.worktreeName ?? `teams-test-${Date.now()}-${teamCounter}`,
    status: (overrides.status as 'running') ?? 'running',
    phase: (overrides.phase as 'implementing') ?? 'implementing',
    projectId: overrides.projectId ?? null,
    prNumber: overrides.prNumber ?? null,
  });
}

function seedProject(overrides: {
  name?: string;
  repoPath?: string;
} = {}) {
  const db = getDatabase();
  return db.insertProject({
    name: overrides.name ?? `test-project-${Date.now()}`,
    repoPath: overrides.repoPath ?? `C:/fake/repo-${Date.now()}`,
  });
}

// =============================================================================
// Tests: GET /api/teams
// =============================================================================

describe('GET /api/teams', () => {
  it('should return paginated dashboard data with 200', async () => {
    seedTeam();

    const res = await server.inject({ method: 'GET', url: '/api/teams' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('limit');
    expect(body).toHaveProperty('offset');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('should respect limit and offset params', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/teams?limit=2&offset=0' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(0);
    expect(body.data.length).toBeLessThanOrEqual(2);
  });

  it('should return 400 for invalid limit', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/teams?limit=-1' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('limit');
  });

  it('should return 400 for non-numeric limit', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/teams?limit=abc' });
    expect(res.statusCode).toBe(400);
  });

  it('should return 400 for negative offset', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/teams?offset=-1' });
    expect(res.statusCode).toBe(400);
  });
});

// =============================================================================
// Tests: GET /api/teams/:id
// =============================================================================

describe('GET /api/teams/:id', () => {
  it('should return team detail for valid ID with 200', async () => {
    const manager = getTeamManager();
    (manager.getOutput as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (manager.getParsedEvents as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const team = seedTeam();

    const res = await server.inject({ method: 'GET', url: `/api/teams/${team.id}` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(team.id);
    expect(body.issueNumber).toBe(team.issueNumber);
    expect(body.status).toBe('running');
  });

  it('should return 404 for unknown team', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/teams/99999' });
    expect(res.statusCode).toBe(404);
  });

  it('should return 400 for non-numeric ID', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/teams/abc' });
    expect(res.statusCode).toBe(400);
  });

  it('should return 400 for negative ID', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/teams/-5' });
    expect(res.statusCode).toBe(400);
  });
});

// =============================================================================
// Tests: GET /api/teams/:id/status
// =============================================================================

describe('GET /api/teams/:id/status', () => {
  it('should return compact status with pending commands', async () => {
    const team = seedTeam();

    const res = await server.inject({ method: 'GET', url: `/api/teams/${team.id}/status` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(team.id);
    expect(body.status).toBe('running');
    expect(body).toHaveProperty('pending_commands');
  });

  it('should return 404 for unknown team', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/teams/99999/status' });
    expect(res.statusCode).toBe(404);
  });
});

// =============================================================================
// Tests: GET /api/teams/:id/output
// =============================================================================

describe('GET /api/teams/:id/output', () => {
  it('should return output buffer for valid team', async () => {
    const manager = getTeamManager();
    (manager.getOutput as ReturnType<typeof vi.fn>).mockReturnValue(['line1', 'line2']);

    const team = seedTeam();

    const res = await server.inject({ method: 'GET', url: `/api/teams/${team.id}/output` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.teamId).toBe(team.id);
    expect(body.lines).toEqual(['line1', 'line2']);
    expect(body.count).toBe(2);
  });

  it('should return 404 for unknown team', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/teams/99999/output' });
    expect(res.statusCode).toBe(404);
  });
});

// =============================================================================
// Tests: GET /api/teams/:id/events
// =============================================================================

describe('GET /api/teams/:id/events', () => {
  it('should return paginated events for valid team', async () => {
    const team = seedTeam();

    const res = await server.inject({ method: 'GET', url: `/api/teams/${team.id}/events` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('limit');
    expect(body).toHaveProperty('offset');
  });

  it('should return 404 for unknown team', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/teams/99999/events' });
    expect(res.statusCode).toBe(404);
  });

  it('should return 400 for invalid limit', async () => {
    const team = seedTeam();
    const res = await server.inject({ method: 'GET', url: `/api/teams/${team.id}/events?limit=-1` });
    expect(res.statusCode).toBe(400);
  });
});

// =============================================================================
// Tests: GET /api/teams/:id/timeline
// =============================================================================

describe('GET /api/teams/:id/timeline', () => {
  it('should return 400 for invalid team ID', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/teams/abc/timeline' });
    expect(res.statusCode).toBe(400);
  });

  it('should return 404 for unknown team', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/teams/99999/timeline' });
    expect(res.statusCode).toBe(404);
  });
});

// =============================================================================
// Tests: GET /api/teams/:id/export
// =============================================================================

describe('GET /api/teams/:id/export', () => {
  it('should return JSON export with correct headers', async () => {
    const manager = getTeamManager();
    (manager.getParsedEvents as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (manager.getOutput as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const team = seedTeam({ worktreeName: `export-json-${Date.now()}` });

    const res = await server.inject({ method: 'GET', url: `/api/teams/${team.id}/export` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('.json');
  });

  it('should return text export when format=txt', async () => {
    const manager = getTeamManager();
    (manager.getParsedEvents as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (manager.getOutput as ReturnType<typeof vi.fn>).mockReturnValue(['line1']);

    const team = seedTeam({ worktreeName: `export-txt-${Date.now()}` });

    const res = await server.inject({ method: 'GET', url: `/api/teams/${team.id}/export?format=txt` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-disposition']).toContain('.txt');
  });

  it('should return 400 for invalid team ID', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/teams/abc/export' });
    expect(res.statusCode).toBe(400);
  });

  it('should return 404 for unknown team', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/teams/99999/export' });
    expect(res.statusCode).toBe(404);
  });
});

// =============================================================================
// Tests: POST /api/teams/launch
// =============================================================================

describe('POST /api/teams/launch', () => {
  it('should return 400 for missing projectId', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/teams/launch',
      payload: { issueNumber: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('should return 400 for missing issueNumber', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/teams/launch',
      payload: { projectId: 1 },
    });
    expect(res.statusCode).toBe(400);
  });
});

// =============================================================================
// Tests: POST /api/teams/:id/stop
// =============================================================================

describe('POST /api/teams/:id/stop', () => {
  it('should return 200 on success', async () => {
    const team = seedTeam();
    const manager = getTeamManager();
    (manager.stop as ReturnType<typeof vi.fn>).mockResolvedValue({ id: team.id, status: 'done' });

    const res = await server.inject({
      method: 'POST',
      url: `/api/teams/${team.id}/stop`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('done');
  });

  it('should return 404 for unknown team', async () => {
    const manager = getTeamManager();
    (manager.stop as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Team 99999 not found'));

    const res = await server.inject({
      method: 'POST',
      url: '/api/teams/99999/stop',
    });

    expect(res.statusCode).toBe(404);
  });
});

// =============================================================================
// Tests: POST /api/teams/stop-all
// =============================================================================

describe('POST /api/teams/stop-all', () => {
  it('should return 200', async () => {
    const manager = getTeamManager();
    (manager.stopAll as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const res = await server.inject({
      method: 'POST',
      url: '/api/teams/stop-all',
    });

    expect(res.statusCode).toBe(200);
  });
});

// =============================================================================
// Tests: POST /api/teams/:id/send-message
// =============================================================================

describe('POST /api/teams/:id/send-message', () => {
  it('should return 201 when delivered', async () => {
    const team = seedTeam();
    const manager = getTeamManager();
    (manager.sendMessage as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const res = await server.inject({
      method: 'POST',
      url: `/api/teams/${team.id}/send-message`,
      payload: { message: 'Hello team' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('delivered');
    expect(body.deliveredAt).toBeDefined();
  });

  it('should return 400 for empty message', async () => {
    const team = seedTeam();

    const res = await server.inject({
      method: 'POST',
      url: `/api/teams/${team.id}/send-message`,
      payload: { message: '' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('should return 404 for unknown team', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/teams/99999/send-message',
      payload: { message: 'Hello' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('should return 422 when message is not delivered', async () => {
    const team = seedTeam();
    const manager = getTeamManager();
    (manager.sendMessage as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const res = await server.inject({
      method: 'POST',
      url: `/api/teams/${team.id}/send-message`,
      payload: { message: 'Hello team' },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe('Unprocessable Entity');
  });

  it('should return 400 for invalid team ID', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/teams/abc/send-message',
      payload: { message: 'Hello' },
    });

    expect(res.statusCode).toBe(400);
  });
});

// =============================================================================
// Tests: POST /api/teams/:id/set-phase
// =============================================================================

describe('POST /api/teams/:id/set-phase', () => {
  it('should return 200 for valid phase', async () => {
    const team = seedTeam();

    const res = await server.inject({
      method: 'POST',
      url: `/api/teams/${team.id}/set-phase`,
      payload: { phase: 'reviewing' },
    });

    expect(res.statusCode).toBe(200);
  });

  it('should return 400 for invalid phase', async () => {
    const team = seedTeam();

    const res = await server.inject({
      method: 'POST',
      url: `/api/teams/${team.id}/set-phase`,
      payload: { phase: 'nonexistent_phase' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('should return 400 for invalid team ID', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/teams/abc/set-phase',
      payload: { phase: 'reviewing' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('should return 404 for unknown team', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/teams/99999/set-phase',
      payload: { phase: 'reviewing' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('should return 409 when team is in terminal status', async () => {
    const team = seedTeam({ status: 'done' });

    const res = await server.inject({
      method: 'POST',
      url: `/api/teams/${team.id}/set-phase`,
      payload: { phase: 'reviewing' },
    });

    expect(res.statusCode).toBe(409);
  });
});

// =============================================================================
// Tests: POST /api/teams/:id/acknowledge
// =============================================================================

describe('POST /api/teams/:id/acknowledge', () => {
  it('should return 200 for stuck team', async () => {
    const team = seedTeam({ status: 'stuck' });

    const res = await server.inject({
      method: 'POST',
      url: `/api/teams/${team.id}/acknowledge`,
    });

    expect(res.statusCode).toBe(200);
  });

  it('should return 200 for failed team', async () => {
    const team = seedTeam({ status: 'failed' });

    const res = await server.inject({
      method: 'POST',
      url: `/api/teams/${team.id}/acknowledge`,
    });

    expect(res.statusCode).toBe(200);
  });

  it('should return 400 for non-stuck/non-failed team', async () => {
    const team = seedTeam({ status: 'running' });

    const res = await server.inject({
      method: 'POST',
      url: `/api/teams/${team.id}/acknowledge`,
    });

    expect(res.statusCode).toBe(400);
  });

  it('should return 400 for invalid team ID', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/teams/abc/acknowledge',
    });

    expect(res.statusCode).toBe(400);
  });

  it('should return 404 for unknown team', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/teams/99999/acknowledge',
    });

    expect(res.statusCode).toBe(404);
  });
});

// =============================================================================
// Tests: POST /api/teams/:id/restart
// =============================================================================

describe('POST /api/teams/:id/restart', () => {
  it('should return 200 on success', async () => {
    const team = seedTeam({ status: 'running' });
    const manager = getTeamManager();
    (manager.restart as ReturnType<typeof vi.fn>).mockResolvedValue({ id: team.id, status: 'launching' });

    const res = await server.inject({
      method: 'POST',
      url: `/api/teams/${team.id}/restart`,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
  });

  it('should return 404 for unknown team', async () => {
    const manager = getTeamManager();
    (manager.restart as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Team 99999 not found'));

    const res = await server.inject({
      method: 'POST',
      url: '/api/teams/99999/restart',
      payload: {},
    });

    expect(res.statusCode).toBe(404);
  });
});

// =============================================================================
// Tests: POST /api/teams/launch-batch
// =============================================================================

describe('POST /api/teams/launch-batch', () => {
  it('should return 400 for missing issues array', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/teams/launch-batch',
      payload: { projectId: 1 },
    });

    expect(res.statusCode).toBe(400);
  });

  it('should return 400 for empty issues array', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/teams/launch-batch',
      payload: { projectId: 1, issues: [] },
    });

    expect(res.statusCode).toBe(400);
  });

  it('should return 400 for missing projectId', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/teams/launch-batch',
      payload: { issues: [{ number: 1 }] },
    });

    expect(res.statusCode).toBe(400);
  });
});

// =============================================================================
// Tests: GET /api/teams/:id/tasks
// =============================================================================

describe('GET /api/teams/:id/tasks', () => {
  it('should return 200 with empty task list for team with no tasks', async () => {
    const team = seedTeam();

    const res = await server.inject({
      method: 'GET',
      url: `/api/teams/${team.id}/tasks`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  it('should return 200 with task list after upserting tasks', async () => {
    const team = seedTeam();
    const db = getDatabase();

    db.upsertTeamTask({
      teamId: team.id,
      taskId: 'task-1',
      subject: 'Implement feature A',
      status: 'in_progress',
      owner: 'dev',
    });
    db.upsertTeamTask({
      teamId: team.id,
      taskId: 'task-2',
      subject: 'Write tests',
      status: 'pending',
      owner: 'team-lead',
    });

    const res = await server.inject({
      method: 'GET',
      url: `/api/teams/${team.id}/tasks`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.length).toBe(2);
    expect(body[0].taskId).toBe('task-1');
    expect(body[0].subject).toBe('Implement feature A');
    expect(body[0].status).toBe('in_progress');
    expect(body[0].owner).toBe('dev');
    expect(body[1].taskId).toBe('task-2');
  });

  it('should return 404 for unknown team', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/teams/99999/tasks',
    });

    expect(res.statusCode).toBe(404);
  });

  it('should return 400 for invalid team ID', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/teams/abc/tasks',
    });

    expect(res.statusCode).toBe(400);
  });
});
