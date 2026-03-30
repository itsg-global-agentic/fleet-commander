// =============================================================================
// Fleet Commander -- Issue Relations Routes: HTTP contract tests
// =============================================================================
// Tests the issue-relations route plugin for correct HTTP status codes,
// response shapes, parameter validation, and error handling.
//
// Since the routes delegate to the IssueRelationsService (which calls real
// providers), we mock the service methods and test the HTTP layer only.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import os from 'os';
import path from 'path';
import fs from 'fs';

import { getDatabase, closeDatabase } from '../../../src/server/db.js';
import { sseBroker } from '../../../src/server/services/sse-broker.js';

// Import routes
import issueRelationsRoutes from '../../../src/server/routes/issue-relations.js';

// Mock the issue-relations-service module
vi.mock('../../../src/server/services/issue-relations-service.js', () => {
  const mockService = {
    getRelations: vi.fn(),
    addBlockedBy: vi.fn(),
    removeBlockedBy: vi.fn(),
    setParent: vi.fn(),
    removeParent: vi.fn(),
    addChild: vi.fn(),
    removeChild: vi.fn(),
  };
  return {
    getIssueRelationsService: () => mockService,
    __mockService: mockService,
  };
});

// ---------------------------------------------------------------------------
// Test-level state
// ---------------------------------------------------------------------------

let dbPath: string;
let app: FastifyInstance;
let projectId: number;

// Get mock service reference
let mockService: {
  getRelations: ReturnType<typeof vi.fn>;
  addBlockedBy: ReturnType<typeof vi.fn>;
  removeBlockedBy: ReturnType<typeof vi.fn>;
  setParent: ReturnType<typeof vi.fn>;
  removeParent: ReturnType<typeof vi.fn>;
  addChild: ReturnType<typeof vi.fn>;
  removeChild: ReturnType<typeof vi.fn>;
};

// ---------------------------------------------------------------------------
// DB + app lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  dbPath = path.join(
    os.tmpdir(),
    `fleet-rel-routes-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );

  closeDatabase();
  process.env['FLEET_DB_PATH'] = dbPath;
  getDatabase(dbPath);

  app = Fastify({ logger: false });
  await app.register(issueRelationsRoutes);
  await app.ready();

  // Create a test project
  const db = getDatabase();
  projectId = db.insertProject({
    name: 'test-project',
    repoPath: '/tmp/test',
    githubRepo: 'owner/repo',
  }).id;

  // Get the mock service
  const mod = await import('../../../src/server/services/issue-relations-service.js');
  mockService = (mod as unknown as { __mockService: typeof mockService }).__mockService;
});

afterAll(async () => {
  await app.close();
  sseBroker.stop();
  closeDatabase();

  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      // best effort
    }
  }
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET /api/projects/:projectId/issues/:issueKey/relations
// ---------------------------------------------------------------------------

describe('GET /api/projects/:projectId/issues/:issueKey/relations', () => {
  it('should return 200 with relations data', async () => {
    const mockRelations = {
      parent: null,
      children: [],
      blockedBy: [{ key: '10', title: 'Blocker', state: 'open' }],
      blocking: [],
    };
    mockService.getRelations.mockResolvedValueOnce(mockRelations);

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/issues/42/relations`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.parent).toBeNull();
    expect(body.blockedBy).toHaveLength(1);
    expect(body.blockedBy[0].key).toBe('10');
    expect(mockService.getRelations).toHaveBeenCalledWith(projectId, '42');
  });

  it('should return 400 for invalid projectId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/abc/issues/42/relations',
    });

    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/projects/:projectId/issues/:issueKey/blocked-by
// ---------------------------------------------------------------------------

describe('POST /api/projects/:projectId/issues/:issueKey/blocked-by', () => {
  it('should return 201 on success', async () => {
    mockService.addBlockedBy.mockResolvedValueOnce(undefined);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/issues/42/blocked-by`,
      payload: { blockerKey: '10' },
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(mockService.addBlockedBy).toHaveBeenCalledWith(projectId, '42', '10');
  });

  it('should return 400 when blockerKey is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/issues/42/blocked-by`,
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it('should return 400 when body is empty', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/issues/42/blocked-by`,
    });

    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/projects/:projectId/issues/:issueKey/blocked-by/:blockerKey
// ---------------------------------------------------------------------------

describe('DELETE /api/projects/:projectId/issues/:issueKey/blocked-by/:blockerKey', () => {
  it('should return 204 on success', async () => {
    mockService.removeBlockedBy.mockResolvedValueOnce(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/issues/42/blocked-by/10`,
    });

    expect(res.statusCode).toBe(204);
    expect(mockService.removeBlockedBy).toHaveBeenCalledWith(projectId, '42', '10');
  });
});

// ---------------------------------------------------------------------------
// POST /api/projects/:projectId/issues/:issueKey/parent
// ---------------------------------------------------------------------------

describe('POST /api/projects/:projectId/issues/:issueKey/parent', () => {
  it('should return 201 on success', async () => {
    mockService.setParent.mockResolvedValueOnce(undefined);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/issues/42/parent`,
      payload: { parentKey: '10' },
    });

    expect(res.statusCode).toBe(201);
    expect(mockService.setParent).toHaveBeenCalledWith(projectId, '42', '10');
  });

  it('should return 400 when parentKey is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/issues/42/parent`,
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/projects/:projectId/issues/:issueKey/parent
// ---------------------------------------------------------------------------

describe('DELETE /api/projects/:projectId/issues/:issueKey/parent', () => {
  it('should return 204 on success', async () => {
    mockService.removeParent.mockResolvedValueOnce(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/issues/42/parent`,
    });

    expect(res.statusCode).toBe(204);
    expect(mockService.removeParent).toHaveBeenCalledWith(projectId, '42');
  });
});

// ---------------------------------------------------------------------------
// POST /api/projects/:projectId/issues/:issueKey/children
// ---------------------------------------------------------------------------

describe('POST /api/projects/:projectId/issues/:issueKey/children', () => {
  it('should return 201 on success', async () => {
    mockService.addChild.mockResolvedValueOnce(undefined);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/issues/42/children`,
      payload: { childKey: '10' },
    });

    expect(res.statusCode).toBe(201);
    expect(mockService.addChild).toHaveBeenCalledWith(projectId, '42', '10');
  });

  it('should return 400 when childKey is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/issues/42/children`,
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/projects/:projectId/issues/:issueKey/children/:childKey
// ---------------------------------------------------------------------------

describe('DELETE /api/projects/:projectId/issues/:issueKey/children/:childKey', () => {
  it('should return 204 on success', async () => {
    mockService.removeChild.mockResolvedValueOnce(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/issues/42/children/10`,
    });

    expect(res.statusCode).toBe(204);
    expect(mockService.removeChild).toHaveBeenCalledWith(projectId, '42', '10');
  });
});

// ---------------------------------------------------------------------------
// Error handling — 502 when provider mutation fails
// ---------------------------------------------------------------------------

describe('Error handling', () => {
  it('should return 502 when service throws ServiceError with 502', async () => {
    const { ServiceError } = await import('../../../src/server/services/service-error.js');
    mockService.addBlockedBy.mockRejectedValueOnce(
      new ServiceError('GitHub API failed', 'EXTERNAL_ERROR', 502),
    );

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/issues/42/blocked-by`,
      payload: { blockerKey: '10' },
    });

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('EXTERNAL_ERROR');
  });

  it('should return 404 when service throws ServiceError with 404', async () => {
    const { ServiceError } = await import('../../../src/server/services/service-error.js');
    mockService.getRelations.mockRejectedValueOnce(
      new ServiceError('Project not found', 'NOT_FOUND', 404),
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/999/issues/42/relations`,
    });

    expect(res.statusCode).toBe(404);
  });
});
