// =============================================================================
// Fleet Commander -- POST /api/issues/refresh: HTTP contract tests
// =============================================================================
// Tests the issues route plugin for the refresh endpoint specifically:
//   - no-body call refreshes ALL projects (legacy behaviour)
//   - { projectId: <n> } body scopes the refresh to one project
//   - invalid projectId values produce a 400 with a ServiceError code
//
// Mocks the IssueService (exposed via getIssueService) so we exercise only
// the HTTP layer / parameter validation. Mirrors the structure of
// `issue-relations-routes.test.ts`.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import os from 'os';
import path from 'path';
import fs from 'fs';

import { getDatabase, closeDatabase } from '../../../src/server/db.js';
import { sseBroker } from '../../../src/server/services/sse-broker.js';

// Import routes
import issueRoutes from '../../../src/server/routes/issues.js';

// ---------------------------------------------------------------------------
// Service mock — only `refresh` is exercised here, but other methods need to
// exist on the singleton so the imported routes file does not crash if the
// Fastify lifecycle touches them.
// ---------------------------------------------------------------------------

vi.mock('../../../src/server/services/issue-service.js', () => {
  const mockService = {
    getAllIssues: vi.fn(),
    getProjectIssues: vi.fn(),
    getNextIssue: vi.fn(),
    getAvailableIssues: vi.fn(),
    getIssue: vi.fn(),
    getIssueByKey: vi.fn(),
    getProjectDependencies: vi.fn(),
    getIssueDependencies: vi.fn(),
    getExecutionPlan: vi.fn(),
    refresh: vi.fn(),
  };
  return {
    getIssueService: () => mockService,
    __mockService: mockService,
  };
});

// ---------------------------------------------------------------------------
// Test-level state
// ---------------------------------------------------------------------------

let dbPath: string;
let app: FastifyInstance;

let mockService: {
  getAllIssues: ReturnType<typeof vi.fn>;
  getProjectIssues: ReturnType<typeof vi.fn>;
  getNextIssue: ReturnType<typeof vi.fn>;
  getAvailableIssues: ReturnType<typeof vi.fn>;
  getIssue: ReturnType<typeof vi.fn>;
  getIssueByKey: ReturnType<typeof vi.fn>;
  getProjectDependencies: ReturnType<typeof vi.fn>;
  getIssueDependencies: ReturnType<typeof vi.fn>;
  getExecutionPlan: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
};

// ---------------------------------------------------------------------------
// DB + app lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  dbPath = path.join(
    os.tmpdir(),
    `fleet-issues-refresh-routes-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );

  closeDatabase();
  process.env['FLEET_DB_PATH'] = dbPath;
  getDatabase(dbPath);

  app = Fastify({ logger: false });
  await app.register(issueRoutes);
  await app.ready();

  const mod = await import('../../../src/server/services/issue-service.js');
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
// POST /api/issues/refresh
// ---------------------------------------------------------------------------

describe('POST /api/issues/refresh', () => {
  it('should refresh all projects when no body is sent', async () => {
    mockService.refresh.mockResolvedValueOnce({
      refreshedAt: '2026-04-01T00:00:00.000Z',
      issueCount: 5,
      tree: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/issues/refresh',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.refreshedAt).toBe('2026-04-01T00:00:00.000Z');
    expect(body.issueCount).toBe(5);
    expect(Array.isArray(body.tree)).toBe(true);
    expect(mockService.refresh).toHaveBeenCalledWith(undefined);
  });

  it('should refresh all projects when body is empty object', async () => {
    mockService.refresh.mockResolvedValueOnce({
      refreshedAt: null,
      issueCount: 0,
      tree: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/issues/refresh',
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(mockService.refresh).toHaveBeenCalledWith(undefined);
  });

  it('should pass projectId to the service when provided', async () => {
    mockService.refresh.mockResolvedValueOnce({
      refreshedAt: '2026-04-01T00:00:00.000Z',
      issueCount: 3,
      tree: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/issues/refresh',
      payload: { projectId: 5 },
    });

    expect(res.statusCode).toBe(200);
    expect(mockService.refresh).toHaveBeenCalledWith(5);
  });

  it('should return 400 when projectId is non-numeric', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/issues/refresh',
      payload: { projectId: 'abc' },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('VALIDATION');
    expect(mockService.refresh).not.toHaveBeenCalled();
  });

  it('should return 400 when projectId is zero', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/issues/refresh',
      payload: { projectId: 0 },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('VALIDATION');
    expect(mockService.refresh).not.toHaveBeenCalled();
  });

  it('should return 400 when projectId is negative', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/issues/refresh',
      payload: { projectId: -1 },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('VALIDATION');
    expect(mockService.refresh).not.toHaveBeenCalled();
  });

  it('should propagate ServiceError statusCode and code from service', async () => {
    const { ServiceError } = await import('../../../src/server/services/service-error.js');
    mockService.refresh.mockRejectedValueOnce(
      new ServiceError('Provider unavailable', 'EXTERNAL_ERROR', 502),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/issues/refresh',
      payload: { projectId: 5 },
    });

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('EXTERNAL_ERROR');
  });

  it('should return 500 for unexpected errors', async () => {
    mockService.refresh.mockRejectedValueOnce(new Error('boom'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/issues/refresh',
    });

    expect(res.statusCode).toBe(500);
  });
});
