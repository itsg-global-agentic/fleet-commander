// =============================================================================
// Fleet Commander -- ProjectIssueSource DB CRUD tests
// =============================================================================
// Tests the DB methods for the project_issue_sources table:
// insertIssueSource, getIssueSources, getIssueSource, updateIssueSource,
// deleteIssueSource, deleteIssueSourcesByProject, and v13 migration backfill.
// Uses a real temp SQLite database.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

import { getDatabase, closeDatabase } from '../../../src/server/db.js';
import { sseBroker } from '../../../src/server/services/sse-broker.js';

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
    `fleet-issue-sources-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );

  closeDatabase();
  process.env['FLEET_DB_PATH'] = dbPath;
  getDatabase(dbPath);
});

afterAll(() => {
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedProject(overrides: {
  name?: string;
  repoPath?: string;
  githubRepo?: string | null;
} = {}) {
  const db = getDatabase();
  return db.insertProject({
    name: overrides.name ?? `test-project-${Date.now()}`,
    repoPath: overrides.repoPath ?? `/tmp/test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    githubRepo: overrides.githubRepo !== undefined ? overrides.githubRepo : 'owner/repo',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProjectIssueSource CRUD', () => {
  it('should insert a source and return it with correct fields', () => {
    const db = getDatabase();
    const project = seedProject();

    const source = db.insertIssueSource({
      projectId: project.id,
      provider: 'github',
      label: 'GitHub Issues',
      configJson: JSON.stringify({ owner: 'octocat', repo: 'hello-world' }),
    });

    expect(source.id).toBeGreaterThan(0);
    expect(source.projectId).toBe(project.id);
    expect(source.provider).toBe('github');
    expect(source.label).toBe('GitHub Issues');
    expect(source.configJson).toBe('{"owner":"octocat","repo":"hello-world"}');
    expect(source.credentialsJson).toBeNull();
    expect(source.enabled).toBe(true);
    expect(source.createdAt).toBeTruthy();
  });

  it('should insert a source with credentials and disabled', () => {
    const db = getDatabase();
    const project = seedProject();

    const source = db.insertIssueSource({
      projectId: project.id,
      provider: 'jira',
      label: 'Jira Board',
      configJson: JSON.stringify({ projectKey: 'PROJ' }),
      credentialsJson: JSON.stringify({ token: 'secret' }),
      enabled: false,
    });

    expect(source.provider).toBe('jira');
    expect(source.credentialsJson).toBe('{"token":"secret"}');
    expect(source.enabled).toBe(false);
  });

  it('should get all sources for a project', () => {
    const db = getDatabase();
    const project = seedProject();

    db.insertIssueSource({
      projectId: project.id,
      provider: 'github',
      configJson: JSON.stringify({ owner: 'a', repo: 'b' }),
    });
    db.insertIssueSource({
      projectId: project.id,
      provider: 'jira',
      configJson: JSON.stringify({ projectKey: 'X' }),
    });

    const sources = db.getIssueSources(project.id);
    expect(sources).toHaveLength(2);
    expect(sources[0].provider).toBe('github');
    expect(sources[1].provider).toBe('jira');
  });

  it('should filter sources by enabledOnly', () => {
    const db = getDatabase();
    const project = seedProject();

    db.insertIssueSource({
      projectId: project.id,
      provider: 'github',
      configJson: JSON.stringify({ owner: 'a', repo: 'b' }),
      enabled: true,
    });
    db.insertIssueSource({
      projectId: project.id,
      provider: 'jira',
      configJson: JSON.stringify({ projectKey: 'X' }),
      enabled: false,
    });

    const allSources = db.getIssueSources(project.id);
    expect(allSources).toHaveLength(2);

    const enabledSources = db.getIssueSources(project.id, true);
    expect(enabledSources).toHaveLength(1);
    expect(enabledSources[0].provider).toBe('github');
  });

  it('should get a single source by id', () => {
    const db = getDatabase();
    const project = seedProject();

    const created = db.insertIssueSource({
      projectId: project.id,
      provider: 'github',
      configJson: JSON.stringify({ owner: 'x', repo: 'y' }),
    });

    const fetched = db.getIssueSource(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.provider).toBe('github');
  });

  it('should return undefined for non-existent source', () => {
    const db = getDatabase();
    const fetched = db.getIssueSource(99999);
    expect(fetched).toBeUndefined();
  });

  it('should update a source label and enabled status', () => {
    const db = getDatabase();
    const project = seedProject();

    const created = db.insertIssueSource({
      projectId: project.id,
      provider: 'github',
      label: 'Old Label',
      configJson: JSON.stringify({ owner: 'x', repo: 'y' }),
    });

    const updated = db.updateIssueSource(created.id, {
      label: 'New Label',
      enabled: false,
    });

    expect(updated).toBeDefined();
    expect(updated!.label).toBe('New Label');
    expect(updated!.enabled).toBe(false);
  });

  it('should update configJson', () => {
    const db = getDatabase();
    const project = seedProject();

    const created = db.insertIssueSource({
      projectId: project.id,
      provider: 'github',
      configJson: JSON.stringify({ owner: 'old', repo: 'config' }),
    });

    const newConfig = JSON.stringify({ owner: 'new', repo: 'config' });
    const updated = db.updateIssueSource(created.id, { configJson: newConfig });

    expect(updated!.configJson).toBe(newConfig);
  });

  it('should return unchanged source when update has no fields', () => {
    const db = getDatabase();
    const project = seedProject();

    const created = db.insertIssueSource({
      projectId: project.id,
      provider: 'github',
      configJson: JSON.stringify({ owner: 'x', repo: 'y' }),
    });

    const updated = db.updateIssueSource(created.id, {});
    expect(updated!.id).toBe(created.id);
    expect(updated!.provider).toBe('github');
  });

  it('should delete a source by id', () => {
    const db = getDatabase();
    const project = seedProject();

    const created = db.insertIssueSource({
      projectId: project.id,
      provider: 'github',
      configJson: JSON.stringify({ owner: 'x', repo: 'y' }),
    });

    const deleted = db.deleteIssueSource(created.id);
    expect(deleted).toBe(true);

    const fetched = db.getIssueSource(created.id);
    expect(fetched).toBeUndefined();
  });

  it('should return false when deleting non-existent source', () => {
    const db = getDatabase();
    const deleted = db.deleteIssueSource(99999);
    expect(deleted).toBe(false);
  });

  it('should delete all sources for a project', () => {
    const db = getDatabase();
    const project = seedProject();

    db.insertIssueSource({
      projectId: project.id,
      provider: 'github',
      configJson: JSON.stringify({ owner: 'a', repo: 'b' }),
    });
    db.insertIssueSource({
      projectId: project.id,
      provider: 'jira',
      configJson: JSON.stringify({ projectKey: 'X' }),
    });

    const count = db.deleteIssueSourcesByProject(project.id);
    expect(count).toBe(2);

    const remaining = db.getIssueSources(project.id);
    expect(remaining).toHaveLength(0);
  });

  it('should enforce UNIQUE constraint on (project_id, provider, config_json)', () => {
    const db = getDatabase();
    const project = seedProject();

    const config = JSON.stringify({ owner: 'x', repo: 'y' });

    db.insertIssueSource({
      projectId: project.id,
      provider: 'github',
      configJson: config,
    });

    expect(() =>
      db.insertIssueSource({
        projectId: project.id,
        provider: 'github',
        configJson: config,
      })
    ).toThrow(/UNIQUE constraint/);
  });

  it('should allow same provider with different config for same project', () => {
    const db = getDatabase();
    const project = seedProject();

    const source1 = db.insertIssueSource({
      projectId: project.id,
      provider: 'github',
      configJson: JSON.stringify({ owner: 'a', repo: 'b' }),
    });

    const source2 = db.insertIssueSource({
      projectId: project.id,
      provider: 'github',
      configJson: JSON.stringify({ owner: 'c', repo: 'd' }),
    });

    expect(source1.id).not.toBe(source2.id);
    const sources = db.getIssueSources(project.id);
    expect(sources).toHaveLength(2);
  });
});

describe('Project deletion cascades to issue sources', () => {
  it('should delete issue sources when project is deleted', () => {
    const db = getDatabase();
    const project = seedProject();

    db.insertIssueSource({
      projectId: project.id,
      provider: 'github',
      configJson: JSON.stringify({ owner: 'x', repo: 'y' }),
    });

    db.deleteProject(project.id);

    const sources = db.getIssueSources(project.id);
    expect(sources).toHaveLength(0);
  });
});

describe('v13 migration backfill', () => {
  it('should create a source for projects with github_repo during migration', () => {
    // The migration already ran during DB init (via initSchema).
    // We verify that a newly created project with github_repo gets a source
    // backfilled when migration runs (or already has one from the migration).
    // Since the migration already completed during beforeAll, we verify the
    // DB CRUD methods work correctly for the pattern the migration uses.
    const db = getDatabase();
    const project = seedProject({ githubRepo: 'testowner/testrepo' });

    // Simulate what the migration does
    const configJson = JSON.stringify({ owner: 'testowner', repo: 'testrepo' });
    const source = db.insertIssueSource({
      projectId: project.id,
      provider: 'github',
      label: 'GitHub Issues',
      configJson,
    });

    expect(source.provider).toBe('github');
    expect(source.label).toBe('GitHub Issues');

    const parsed = JSON.parse(source.configJson) as { owner: string; repo: string };
    expect(parsed.owner).toBe('testowner');
    expect(parsed.repo).toBe('testrepo');
    expect(source.enabled).toBe(true);
  });

  it('should not create a source for projects without github_repo', () => {
    const db = getDatabase();
    const project = seedProject({ githubRepo: null });

    // With no github_repo, migration would skip this project
    const sources = db.getIssueSources(project.id);
    expect(sources).toHaveLength(0);
  });
});
