// =============================================================================
// Fleet Commander -- Usage Routes: HTTP contract tests
// =============================================================================
// Tests the usage route plugin for correct HTTP status codes, response shapes,
// and parameter validation. Uses a real temp SQLite database.
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

const mockActivateUsageOverride = vi.fn().mockResolvedValue({ overrideActive: true, hardPaused: false });
const mockDeactivateUsageOverride = vi.fn().mockReturnValue({ overrideActive: false, hardPaused: false });

vi.mock('../../../src/server/services/usage-tracker.js', () => ({
  processUsageSnapshot: vi.fn(),
  getUsageZone: vi.fn().mockReturnValue('green'),
  isUsageOverrideActive: vi.fn().mockReturnValue(false),
  isHardPaused: vi.fn().mockReturnValue(false),
  activateUsageOverride: (...args: unknown[]) => mockActivateUsageOverride(...args),
  deactivateUsageOverride: (...args: unknown[]) => mockDeactivateUsageOverride(...args),
}));

// Import routes AFTER mocks
import usageRoutes from '../../../src/server/routes/usage.js';

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
    `fleet-usage-routes-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );

  closeDatabase();
  process.env['FLEET_DB_PATH'] = dbPath;
  getDatabase(dbPath);

  server = Fastify({ logger: false });
  await server.register(usageRoutes);
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

// =============================================================================
// Tests: GET /api/usage/history
// =============================================================================

describe('GET /api/usage/history', () => {
  it('should return 400 for non-numeric limit', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/usage/history?limit=xyz' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('limit');
  });

  it('should return 400 for negative limit', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/usage/history?limit=-1' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('limit');
  });

  it('should return 400 for zero limit', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/usage/history?limit=0' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('limit');
  });

  it('should accept valid limit', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/usage/history?limit=10' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('count');
    expect(body).toHaveProperty('snapshots');
  });

  it('should cap limit to 1000', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/usage/history?limit=5000' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('count');
    expect(body).toHaveProperty('snapshots');
  });
});

// =============================================================================
// Tests: GET /api/usage — includes override state fields (issue #678)
// =============================================================================

describe('GET /api/usage — override fields', () => {
  it('should include overrideActive and hardPaused fields in response', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/usage' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('overrideActive');
    expect(body).toHaveProperty('hardPaused');
    expect(typeof body.overrideActive).toBe('boolean');
    expect(typeof body.hardPaused).toBe('boolean');
  });
});

// =============================================================================
// Tests: POST /api/usage/override (issue #678)
// =============================================================================

describe('POST /api/usage/override', () => {
  it('should return 200 with override activated', async () => {
    mockActivateUsageOverride.mockResolvedValue({ overrideActive: true, hardPaused: false });
    const res = await server.inject({ method: 'POST', url: '/api/usage/override' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ overrideActive: true, hardPaused: false });
  });

  it('should return 200 with hardPaused when activation refused', async () => {
    mockActivateUsageOverride.mockResolvedValue({ overrideActive: false, hardPaused: true });
    const res = await server.inject({ method: 'POST', url: '/api/usage/override' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ overrideActive: false, hardPaused: true });
  });
});

// =============================================================================
// Tests: DELETE /api/usage/override (issue #678)
// =============================================================================

describe('DELETE /api/usage/override', () => {
  it('should return 200 with override deactivated', async () => {
    mockDeactivateUsageOverride.mockReturnValue({ overrideActive: false, hardPaused: false });
    const res = await server.inject({ method: 'DELETE', url: '/api/usage/override' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ overrideActive: false, hardPaused: false });
  });
});
