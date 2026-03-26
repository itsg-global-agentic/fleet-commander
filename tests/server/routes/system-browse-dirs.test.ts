// =============================================================================
// Fleet Commander -- System browse-dirs Routes: path traversal prevention tests
// =============================================================================
// Tests the GET /api/system/browse-dirs endpoint for correct path validation,
// traversal prevention, and directory listing within the allowed browse root.
// Uses a real temp directory structure to test filesystem browsing.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import os from 'os';
import path from 'path';
import fs from 'fs';

// ---------------------------------------------------------------------------
// Temp directory structure for testing
// ---------------------------------------------------------------------------

const TEST_ROOT = path.join(
  os.tmpdir(),
  `fleet-browse-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

const SUBDIR = path.join(TEST_ROOT, 'projects');
const GIT_REPO = path.join(SUBDIR, 'my-repo');
const PLAIN_DIR = path.join(SUBDIR, 'plain-dir');
const HIDDEN_DIR = path.join(SUBDIR, '.hidden');

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the route plugin
// ---------------------------------------------------------------------------

vi.mock('../../../src/server/config.js', () => {
  const os = require('os');
  const path = require('path');
  // Re-derive TEST_ROOT from same seed — not possible, so just use os.tmpdir()
  // pattern. We set browseRoot in beforeAll via the module reference.
  return {
    default: {
      host: '127.0.0.1',
      port: 4680,
      browseRoot: '', // Overridden in beforeAll
    },
    validateConfig: vi.fn(),
    safeParseInt: vi.fn((v: string) => parseInt(v, 10)),
    defaultDbPath: vi.fn(),
  };
});

vi.mock('../../../src/server/services/diagnostics-service.js', () => ({
  getDiagnosticsService: vi.fn(() => ({
    getStuckTeams: vi.fn().mockReturnValue([]),
    getBlockedTeams: vi.fn().mockReturnValue([]),
    getHealthSummary: vi.fn().mockReturnValue({}),
    getServerStatus: vi.fn().mockReturnValue({}),
    getDebugTeams: vi.fn().mockReturnValue([]),
    factoryReset: vi.fn().mockResolvedValue({ success: true }),
  })),
}));

vi.mock('../../../src/server/utils/resolve-claude-path.js', () => ({
  resolveClaudePath: vi.fn().mockReturnValue('claude'),
}));

vi.mock('../../../src/server/utils/version.js', () => ({
  getPackageVersion: vi.fn().mockReturnValue('0.0.0-test'),
}));

// Import the route plugin AFTER mocks
import systemRoutes from '../../../src/server/routes/system.js';
import config from '../../../src/server/config.js';

// ---------------------------------------------------------------------------
// Test-level state
// ---------------------------------------------------------------------------

let server: FastifyInstance;

// ---------------------------------------------------------------------------
// Setup and teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Create test directory structure
  fs.mkdirSync(GIT_REPO, { recursive: true });
  fs.mkdirSync(PLAIN_DIR, { recursive: true });
  fs.mkdirSync(HIDDEN_DIR, { recursive: true });
  // Create a .git directory inside GIT_REPO to simulate a git repo
  fs.mkdirSync(path.join(GIT_REPO, '.git'), { recursive: true });

  // Set browseRoot to our test root (mutate the frozen mock)
  (config as Record<string, unknown>).browseRoot = TEST_ROOT;

  server = Fastify({ logger: false });
  await server.register(systemRoutes);
  await server.ready();
});

afterAll(async () => {
  await server.close();

  // Clean up temp directories
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/system/browse-dirs', () => {
  it('should list directories within the allowed browse root', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/system/browse-dirs?path=${encodeURIComponent(SUBDIR)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.dirs).toBeDefined();
    expect(Array.isArray(body.dirs)).toBe(true);

    // Should contain our test directories (excluding hidden ones)
    const names = body.dirs.map((d: { name: string }) => d.name);
    expect(names).toContain('my-repo');
    expect(names).toContain('plain-dir');
    expect(names).not.toContain('.hidden');
  });

  it('should detect git repos by presence of .git directory', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/system/browse-dirs?path=${encodeURIComponent(SUBDIR)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    const repoEntry = body.dirs.find((d: { name: string }) => d.name === 'my-repo');
    expect(repoEntry).toBeDefined();
    expect(repoEntry.isGitRepo).toBe(true);

    const plainEntry = body.dirs.find((d: { name: string }) => d.name === 'plain-dir');
    expect(plainEntry).toBeDefined();
    expect(plainEntry.isGitRepo).toBe(false);
  });

  it('should return 403 for paths outside the allowed browse root', async () => {
    // Use the parent of the test root to try to escape
    const outsidePath = path.dirname(TEST_ROOT);

    const res = await server.inject({
      method: 'GET',
      url: `/api/system/browse-dirs?path=${encodeURIComponent(outsidePath)}`,
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Forbidden');
    expect(body.message).toContain('outside the allowed browsing root');
  });

  it('should return 403 for path traversal via ../', async () => {
    // Try to traverse out of the browse root
    const traversalPath = path.join(TEST_ROOT, 'projects', '..', '..');

    const res = await server.inject({
      method: 'GET',
      url: `/api/system/browse-dirs?path=${encodeURIComponent(traversalPath)}`,
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Forbidden');
  });

  it('should return 403 for absolute paths outside the root', async () => {
    // Try to access a completely different path
    const outsidePath = process.platform === 'win32' ? 'C:\\Windows' : '/etc';

    const res = await server.inject({
      method: 'GET',
      url: `/api/system/browse-dirs?path=${encodeURIComponent(outsidePath)}`,
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Forbidden');
  });

  it('should return 200 with empty dirs for non-existent path within allowed root', async () => {
    const nonExistentPath = path.join(TEST_ROOT, 'does-not-exist');

    const res = await server.inject({
      method: 'GET',
      url: `/api/system/browse-dirs?path=${encodeURIComponent(nonExistentPath)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.dirs).toEqual([]);
  });

  it('should use the browse root as default when no path param is given', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/system/browse-dirs',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // parentPath should be the resolved browse root (forward slashes)
    expect(body.parentPath).toBe(TEST_ROOT.replace(/\\/g, '/'));
  });

  it('should allow browsing the browse root itself', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/system/browse-dirs?path=${encodeURIComponent(TEST_ROOT)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const names = body.dirs.map((d: { name: string }) => d.name);
    expect(names).toContain('projects');
  });

  it('should return normalized forward-slash paths', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/system/browse-dirs?path=${encodeURIComponent(SUBDIR)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // parentPath should use forward slashes
    expect(body.parentPath).not.toContain('\\');
    // All dir paths should also use forward slashes
    for (const dir of body.dirs) {
      expect(dir.path).not.toContain('\\');
    }
  });
});
