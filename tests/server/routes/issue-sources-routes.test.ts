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

  it('should not include credentialsJson in list response', async () => {
    const db = getDatabase();
    db.insertIssueSource({
      projectId,
      provider: 'jira',
      label: 'Secure Jira',
      configJson: JSON.stringify({ projectKey: 'SEC' }),
      credentialsJson: JSON.stringify({ email: 'a@b.com', apiToken: 'secret-token' }),
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/issue-sources`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]).not.toHaveProperty('credentialsJson');
    expect(body.sources[0].hasCredentials).toBe(true);
  });

  it('should return hasCredentials: false when source has no credentials', async () => {
    const db = getDatabase();
    db.insertIssueSource({
      projectId,
      provider: 'github',
      label: 'No creds',
      configJson: JSON.stringify({ owner: 'a', repo: 'b' }),
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/issue-sources`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]).not.toHaveProperty('credentialsJson');
    expect(body.sources[0].hasCredentials).toBe(false);
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

  it('should not include credentialsJson in create response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/issue-sources`,
      payload: {
        provider: 'jira',
        label: 'Jira with creds',
        configJson: JSON.stringify({ projectKey: 'CRED' }),
        credentialsJson: JSON.stringify({ email: 'x@y.com', apiToken: 'super-secret' }),
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body).not.toHaveProperty('credentialsJson');
    expect(body.hasCredentials).toBe(true);
    expect(body.provider).toBe('jira');
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

  it('should not include credentialsJson in update response', async () => {
    const db = getDatabase();
    const source = db.insertIssueSource({
      projectId,
      provider: 'jira',
      label: 'Patch Test',
      configJson: JSON.stringify({ projectKey: 'PT' }),
      credentialsJson: JSON.stringify({ email: 'u@v.com', apiToken: 'old-token' }),
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/issue-sources/${source.id}`,
      payload: {
        credentialsJson: JSON.stringify({ email: 'u@v.com', apiToken: 'new-token' }),
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).not.toHaveProperty('credentialsJson');
    expect(body.hasCredentials).toBe(true);
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

// ---------------------------------------------------------------------------
// GET /api/projects/:projectId/issue-sources/:sourceId/credentials
// ---------------------------------------------------------------------------

describe('GET /api/projects/:projectId/issue-sources/:sourceId/credentials', () => {
  it('should return decrypted credentialsJson for existing source', async () => {
    const db = getDatabase();
    const creds = JSON.stringify({ email: 'cred@test.com', apiToken: 'the-secret' });
    const source = db.insertIssueSource({
      projectId,
      provider: 'jira',
      label: 'Cred Test',
      configJson: JSON.stringify({ projectKey: 'CT' }),
      credentialsJson: creds,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/issue-sources/${source.id}/credentials`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.credentialsJson).toBeTruthy();
    // Verify the decrypted credentials are returned (may be encrypted at rest,
    // but mapIssueSourceRow decrypts them)
    const parsed = JSON.parse(body.credentialsJson);
    expect(parsed.email).toBe('cred@test.com');
    expect(parsed.apiToken).toBe('the-secret');
  });

  it('should return null credentialsJson when source has no credentials', async () => {
    const db = getDatabase();
    const source = db.insertIssueSource({
      projectId,
      provider: 'github',
      label: 'No creds',
      configJson: JSON.stringify({ owner: 'a', repo: 'b' }),
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/issue-sources/${source.id}/credentials`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.credentialsJson).toBeNull();
  });

  it('should return 404 when source does not exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/issue-sources/99999/credentials`,
    });

    expect(res.statusCode).toBe(404);
  });

  it('should return 404 when source belongs to a different project', async () => {
    const db = getDatabase();
    const otherProject = db.insertProject({
      name: `cred-other-${Date.now()}`,
      repoPath: `/tmp/cred-other-${Date.now()}`,
      githubRepo: 'credother/repo',
    });

    const source = db.insertIssueSource({
      projectId: otherProject.id,
      provider: 'jira',
      configJson: JSON.stringify({ projectKey: 'OTH' }),
      credentialsJson: JSON.stringify({ email: 'a@b.com', apiToken: 'tok' }),
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/issue-sources/${source.id}/credentials`,
    });

    expect(res.statusCode).toBe(404);
  });

  it('should return 404 when project does not exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/99999/issue-sources/1/credentials',
    });

    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/projects/:projectId/issue-sources/test-connection
// ---------------------------------------------------------------------------

describe('POST /api/projects/:projectId/issue-sources/test-connection', () => {
  it('should return 404 when project does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/999999/issue-sources/test-connection',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        jiraUrl: 'https://example.atlassian.net',
        projectKey: 'PROJ',
        email: 'user@example.com',
        apiToken: 'token123',
      }),
    });

    expect(res.statusCode).toBe(404);
  });

  it('should return validation error when body is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/issue-sources/test-connection`,
    });

    expect(res.statusCode).toBe(400);
  });

  it('should return validation error when jiraUrl is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/issue-sources/test-connection`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        projectKey: 'PROJ',
        email: 'user@example.com',
        apiToken: 'token123',
      }),
    });

    expect(res.statusCode).toBe(400);
  });

  it('should return ok: false when jiraUrl does not start with https://', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/issue-sources/test-connection`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        jiraUrl: 'http://example.atlassian.net',
        projectKey: 'PROJ',
        email: 'user@example.com',
        apiToken: 'token123',
      }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('https://');
  });

  it('should return ok: false when connection fails (unreachable host)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/issue-sources/test-connection`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        jiraUrl: 'https://this-does-not-exist-fc-test.atlassian.net',
        projectKey: 'PROJ',
        email: 'user@example.com',
        apiToken: 'token123',
      }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    // Should have some error message about connection failure
    expect(body.error).toBeTruthy();
  });
});
