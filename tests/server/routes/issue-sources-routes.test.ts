// =============================================================================
// Fleet Commander -- Issue Sources Routes: HTTP contract tests
// =============================================================================
// Tests the issue-sources route plugin for correct HTTP status codes, response
// shapes, parameter validation, and error handling. Uses a real temp SQLite
// database with the route plugin mounted on a Fastify instance.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import os from 'os';
import path from 'path';
import fs from 'fs';

import { getDatabase, closeDatabase } from '../../../src/server/db.js';
import { sseBroker } from '../../../src/server/services/sse-broker.js';

// Import routes
import issueSourcesRoutes from '../../../src/server/routes/issue-sources.js';

// ---------------------------------------------------------------------------
// Test-level state
// ---------------------------------------------------------------------------

let dbPath: string;
let app: FastifyInstance;
let projectId: number;

// ---------------------------------------------------------------------------
// DB + app lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  dbPath = path.join(
    os.tmpdir(),
    `fleet-issue-src-routes-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );

  closeDatabase();
  process.env['FLEET_DB_PATH'] = dbPath;
  getDatabase(dbPath);

  app = Fastify({ logger: false });
  await app.register(issueSourcesRoutes);
  await app.ready();
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

  delete process.env['FLEET_DB_PATH'];
});

beforeEach(() => {
  // Seed a fresh project for each test
  const db = getDatabase();
  const project = db.insertProject({
    name: `routes-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    repoPath: `/tmp/routes-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    githubRepo: 'owner/repo',
  });
  projectId = project.id;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/projects/:projectId/issue-sources', () => {
  it('should return empty sources array when none exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/issue-sources`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sources).toEqual([]);
  });

  it('should return all sources for a project', async () => {
    const db = getDatabase();
    db.insertIssueSource({
      projectId,
      provider: 'github',
      label: 'GH',
      configJson: JSON.stringify({ owner: 'a', repo: 'b' }),
    });
    db.insertIssueSource({
      projectId,
      provider: 'jira',
      label: 'Jira',
      configJson: JSON.stringify({ projectKey: 'X' }),
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/issue-sources`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sources).toHaveLength(2);
    expect(body.sources[0].provider).toBe('github');
    expect(body.sources[1].provider).toBe('jira');
  });

  it('should return 404 when project does not exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/99999/issue-sources',
    });

    expect(res.statusCode).toBe(404);
  });

  it('should return 400 for invalid projectId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/abc/issue-sources',
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/projects/:projectId/issue-sources', () => {
  it('should create a source and return 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/issue-sources`,
      payload: {
        provider: 'github',
        label: 'GitHub Issues',
        configJson: JSON.stringify({ owner: 'octocat', repo: 'hello-world' }),
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.provider).toBe('github');
    expect(body.label).toBe('GitHub Issues');
    expect(body.enabled).toBe(true);
    expect(body.projectId).toBe(projectId);
  });

  it('should return 400 when provider is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/issue-sources`,
      payload: {
        configJson: JSON.stringify({ owner: 'a', repo: 'b' }),
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('should return 400 when configJson is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/issue-sources`,
      payload: {
        provider: 'github',
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('should return 400 when configJson is invalid JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/issue-sources`,
      payload: {
        provider: 'github',
        configJson: 'not-json',
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('should return 404 when project does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/99999/issue-sources',
      payload: {
        provider: 'github',
        configJson: JSON.stringify({ owner: 'a', repo: 'b' }),
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it('should return 409 when creating duplicate source', async () => {
    const config = JSON.stringify({ owner: 'dup', repo: 'test' });

    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/issue-sources`,
      payload: { provider: 'github', configJson: config },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/issue-sources`,
      payload: { provider: 'github', configJson: config },
    });

    expect(res.statusCode).toBe(409);
  });
});

describe('PATCH /api/projects/:projectId/issue-sources/:sourceId', () => {
  it('should update a source and return the updated record', async () => {
    const db = getDatabase();
    const source = db.insertIssueSource({
      projectId,
      provider: 'github',
      label: 'Old Label',
      configJson: JSON.stringify({ owner: 'a', repo: 'b' }),
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/issue-sources/${source.id}`,
      payload: {
        label: 'New Label',
        enabled: false,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.label).toBe('New Label');
    expect(body.enabled).toBe(false);
  });

  it('should return 404 when source does not exist', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/issue-sources/99999`,
      payload: { label: 'test' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('should return 404 when source belongs to a different project', async () => {
    const db = getDatabase();
    const otherProject = db.insertProject({
      name: `other-${Date.now()}`,
      repoPath: `/tmp/other-${Date.now()}`,
      githubRepo: 'other/repo',
    });

    const source = db.insertIssueSource({
      projectId: otherProject.id,
      provider: 'github',
      configJson: JSON.stringify({ owner: 'x', repo: 'y' }),
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/issue-sources/${source.id}`,
      payload: { label: 'test' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('should return 400 when configJson is invalid JSON', async () => {
    const db = getDatabase();
    const source = db.insertIssueSource({
      projectId,
      provider: 'github',
      configJson: JSON.stringify({ owner: 'a', repo: 'b' }),
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/issue-sources/${source.id}`,
      payload: { configJson: 'not-json' },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/projects/:projectId/issue-sources/:sourceId', () => {
  it('should delete a source and return 204', async () => {
    const db = getDatabase();
    const source = db.insertIssueSource({
      projectId,
      provider: 'github',
      configJson: JSON.stringify({ owner: 'a', repo: 'b' }),
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/issue-sources/${source.id}`,
    });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    // Verify deletion
    const fetched = db.getIssueSource(source.id);
    expect(fetched).toBeUndefined();
  });

  it('should return 404 when source does not exist', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/issue-sources/99999`,
    });

    expect(res.statusCode).toBe(404);
  });

  it('should return 404 when source belongs to a different project', async () => {
    const db = getDatabase();
    const otherProject = db.insertProject({
      name: `del-other-${Date.now()}`,
      repoPath: `/tmp/del-other-${Date.now()}`,
      githubRepo: 'delother/repo',
    });

    const source = db.insertIssueSource({
      projectId: otherProject.id,
      provider: 'github',
      configJson: JSON.stringify({ owner: 'x', repo: 'y' }),
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/issue-sources/${source.id}`,
    });

    expect(res.statusCode).toBe(404);
  });
});
