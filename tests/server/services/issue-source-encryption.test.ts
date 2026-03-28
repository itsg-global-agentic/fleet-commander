// =============================================================================
// Fleet Commander -- Issue Source credential encryption round-trip tests
// =============================================================================
// Verifies that credentialsJson is encrypted at rest in SQLite and decrypted
// transparently when read back via the DB layer.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

import { getDatabase, closeDatabase } from '../../../src/server/db.js';
import { sseBroker } from '../../../src/server/services/sse-broker.js';
import { isEncrypted, initEncryptionKey, resetEncryptionKey } from '../../../src/server/utils/crypto.js';

// ---------------------------------------------------------------------------
// Test-level state
// ---------------------------------------------------------------------------

let dbPath: string;
let projectId: number;

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

beforeAll(() => {
  dbPath = path.join(
    os.tmpdir(),
    `fleet-issue-src-enc-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );

  closeDatabase();
  resetEncryptionKey();
  process.env['FLEET_DB_PATH'] = dbPath;

  // Ensure an encryption key is available
  initEncryptionKey();

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

beforeEach(() => {
  const db = getDatabase();
  const project = db.insertProject({
    name: `enc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    repoPath: `/tmp/enc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    githubRepo: 'owner/repo',
  });
  projectId = project.id;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Issue source credentialsJson encryption', () => {
  it('should store credentialsJson encrypted and return it decrypted', () => {
    const db = getDatabase();
    const credentials = JSON.stringify({ email: 'user@example.com', apiToken: 'secret-token-123' });

    const source = db.insertIssueSource({
      projectId,
      provider: 'jira',
      configJson: JSON.stringify({ jiraUrl: 'https://test.atlassian.net', projectKey: 'TEST' }),
      credentialsJson: credentials,
    });

    // Returned value should be the original plaintext
    expect(source.credentialsJson).toBe(credentials);

    // Verify the raw DB value is encrypted
    const rawRow = db.raw
      .prepare('SELECT credentials_json FROM project_issue_sources WHERE id = ?')
      .get(source.id) as { credentials_json: string };

    expect(rawRow.credentials_json).not.toBe(credentials);
    expect(isEncrypted(rawRow.credentials_json)).toBe(true);
  });

  it('should handle null credentialsJson without encryption', () => {
    const db = getDatabase();

    const source = db.insertIssueSource({
      projectId,
      provider: 'github',
      configJson: JSON.stringify({ owner: 'test', repo: 'repo' }),
      credentialsJson: null,
    });

    expect(source.credentialsJson).toBeNull();

    const rawRow = db.raw
      .prepare('SELECT credentials_json FROM project_issue_sources WHERE id = ?')
      .get(source.id) as { credentials_json: string | null };

    expect(rawRow.credentials_json).toBeNull();
  });

  it('should encrypt credentialsJson on update', () => {
    const db = getDatabase();

    const source = db.insertIssueSource({
      projectId,
      provider: 'jira',
      configJson: JSON.stringify({ jiraUrl: 'https://test.atlassian.net', projectKey: 'TEST' }),
      credentialsJson: null,
    });

    expect(source.credentialsJson).toBeNull();

    const newCredentials = JSON.stringify({ email: 'updated@example.com', apiToken: 'new-secret' });
    const updated = db.updateIssueSource(source.id, { credentialsJson: newCredentials });

    // Returned value should be the plaintext
    expect(updated?.credentialsJson).toBe(newCredentials);

    // Raw DB value should be encrypted
    const rawRow = db.raw
      .prepare('SELECT credentials_json FROM project_issue_sources WHERE id = ?')
      .get(source.id) as { credentials_json: string };

    expect(rawRow.credentials_json).not.toBe(newCredentials);
    expect(isEncrypted(rawRow.credentials_json)).toBe(true);
  });

  it('should allow updating credentialsJson to null', () => {
    const db = getDatabase();

    const source = db.insertIssueSource({
      projectId,
      provider: 'jira',
      configJson: JSON.stringify({ jiraUrl: 'https://test.atlassian.net', projectKey: 'TEST' }),
      credentialsJson: JSON.stringify({ email: 'user@example.com', apiToken: 'secret' }),
    });

    const updated = db.updateIssueSource(source.id, { credentialsJson: null });
    expect(updated?.credentialsJson).toBeNull();

    const rawRow = db.raw
      .prepare('SELECT credentials_json FROM project_issue_sources WHERE id = ?')
      .get(source.id) as { credentials_json: string | null };

    expect(rawRow.credentials_json).toBeNull();
  });

  it('should round-trip encrypted credentials through getIssueSource', () => {
    const db = getDatabase();
    const credentials = JSON.stringify({ email: 'roundtrip@test.com', apiToken: 'rt-token' });

    const source = db.insertIssueSource({
      projectId,
      provider: 'jira',
      configJson: JSON.stringify({ jiraUrl: 'https://rt.atlassian.net', projectKey: 'RT' }),
      credentialsJson: credentials,
    });

    // Read back via getIssueSource
    const fetched = db.getIssueSource(source.id);
    expect(fetched).toBeDefined();
    expect(fetched!.credentialsJson).toBe(credentials);
  });

  it('should round-trip encrypted credentials through getIssueSources', () => {
    const db = getDatabase();
    const credentials = JSON.stringify({ email: 'list@test.com', apiToken: 'list-token' });

    db.insertIssueSource({
      projectId,
      provider: 'jira',
      configJson: JSON.stringify({ jiraUrl: 'https://list.atlassian.net', projectKey: 'LST' }),
      credentialsJson: credentials,
    });

    const sources = db.getIssueSources(projectId);
    const jiraSources = sources.filter((s) => s.provider === 'jira');
    expect(jiraSources.length).toBeGreaterThanOrEqual(1);
    expect(jiraSources[0].credentialsJson).toBe(credentials);
  });
});
