// =============================================================================
// Fleet Commander -- Jira Issue Key Collision Tests
// =============================================================================
// Focused tests for the Jira collision bug (#614): two Jira teams with
// different project prefixes but same trailing number (e.g. FRONTEND-42 and
// BACKEND-42) should be correctly distinguished in enrichWithTeamInfo,
// getIssueByKey, getAvailableIssues, and findInTreeByKey.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

import { getDatabase, closeDatabase } from '../../../src/server/db.js';
import { sseBroker } from '../../../src/server/services/sse-broker.js';

// ---------------------------------------------------------------------------
// Mock the issue provider and GitHub provider to avoid real network calls
// ---------------------------------------------------------------------------

vi.mock('../../../src/server/providers/index.js', () => ({
  getIssueProvider: vi.fn(() => ({
    fetchIssues: vi.fn().mockResolvedValue([]),
    getDependencies: vi.fn().mockResolvedValue([]),
  })),
  resetProviders: vi.fn(),
}));

vi.mock('../../../src/server/providers/github-issue-provider.js', () => ({
  GitHubIssueProvider: class MockGitHubProvider {},
  parseDependenciesFromBody: vi.fn().mockReturnValue([]),
  runWithConcurrency: vi.fn(),
  parseRepo: vi.fn().mockReturnValue(['owner', 'repo']),
}));

vi.mock('../../../src/server/providers/jira-issue-provider.js', () => ({
  JiraIssueProvider: class MockJiraProvider {},
}));

// Import after mocks
import { IssueFetcher } from '../../../src/server/services/issue-fetcher.js';
import type { IssueNode } from '../../../src/server/services/issue-fetcher.js';

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let dbPath: string;

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

beforeAll(() => {
  dbPath = path.join(
    os.tmpdir(),
    `fleet-jira-collision-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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

function makeIssueNode(overrides: Partial<IssueNode> & { number: number }): IssueNode {
  return {
    title: `Issue ${overrides.number}`,
    state: 'open',
    labels: [],
    url: `https://example.com/issue/${overrides.number}`,
    children: [],
    activeTeam: null,
    ...overrides,
  };
}

function seedProject(name: string): { id: number } {
  const db = getDatabase();
  return db.insertProject({
    name,
    repoPath: `C:/fake/${name}-${Date.now()}`,
    githubRepo: null,
  });
}

function seedTeam(projectId: number, issueNumber: number, issueKey: string, status = 'running'): number {
  const db = getDatabase();
  const team = db.insertTeam({
    projectId,
    issueNumber,
    issueTitle: `Team for ${issueKey}`,
    worktreeName: `${issueKey.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
    headless: true,
    issueKey,
    issueProvider: 'jira',
  });
  db.updateTeamSilent(team.id, { status });
  return team.id;
}

// =============================================================================
// Tests: enrichWithTeamInfo — dual-keyed map
// =============================================================================

describe('enrichWithTeamInfo with Jira collision scenario', () => {
  let fetcher: IssueFetcher;

  beforeEach(() => {
    fetcher = new IssueFetcher();
  });

  it('should distinguish FRONTEND-42 from BACKEND-42 by issueKey', () => {
    const project = seedProject('collision-test-a');

    // Create two teams with same issueNumber (42) but different issueKeys
    seedTeam(project.id, 42, 'FRONTEND-42', 'running');
    seedTeam(project.id, 42, 'BACKEND-42', 'idle');

    const issues: IssueNode[] = [
      makeIssueNode({ number: 42, issueKey: 'FRONTEND-42', issueProvider: 'jira', title: 'Frontend fix' }),
      makeIssueNode({ number: 42, issueKey: 'BACKEND-42', issueProvider: 'jira', title: 'Backend fix' }),
    ];

    const enriched = fetcher.enrichWithTeamInfo(issues, project.id);

    // Both should have activeTeam set, and they should be DIFFERENT teams
    expect(enriched[0]!.activeTeam).not.toBeNull();
    expect(enriched[1]!.activeTeam).not.toBeNull();

    // They should be different teams (different ids)
    expect(enriched[0]!.activeTeam!.id).not.toBe(enriched[1]!.activeTeam!.id);

    // Verify the correct team is matched to the correct issue
    const frontendTeam = enriched.find((i) => i.issueKey === 'FRONTEND-42');
    const backendTeam = enriched.find((i) => i.issueKey === 'BACKEND-42');
    expect(frontendTeam?.activeTeam?.status).toBe('running');
    expect(backendTeam?.activeTeam?.status).toBe('idle');
  });

  it('should fall back to issueNumber for nodes without issueKey', () => {
    const project = seedProject('collision-test-b');
    seedTeam(project.id, 99, 'PROJ-99', 'running');

    const issues: IssueNode[] = [
      // Node without issueKey — should match by number
      makeIssueNode({ number: 99, title: 'Legacy issue without key' }),
    ];

    const enriched = fetcher.enrichWithTeamInfo(issues, project.id);

    expect(enriched[0]!.activeTeam).not.toBeNull();
    expect(enriched[0]!.activeTeam!.status).toBe('running');
  });

  it('should return null activeTeam for nodes with no matching team', () => {
    const project = seedProject('collision-test-c');

    const issues: IssueNode[] = [
      makeIssueNode({ number: 777, issueKey: 'NOPE-777', issueProvider: 'jira', title: 'No team' }),
    ];

    const enriched = fetcher.enrichWithTeamInfo(issues, project.id);

    expect(enriched[0]!.activeTeam).toBeNull();
  });
});

// =============================================================================
// Tests: getIssueByKey
// =============================================================================

describe('IssueFetcher.getIssueByKey', () => {
  it('should find an issue by its Jira-style issueKey', () => {
    const fetcher = new IssueFetcher();

    // Inject issues into the cache via the private cacheByProject map
    const issues: IssueNode[] = [
      makeIssueNode({ number: 42, issueKey: 'PROJ-42', issueProvider: 'jira', title: 'Jira issue' }),
      makeIssueNode({ number: 43, issueKey: 'PROJ-43', issueProvider: 'jira', title: 'Another Jira issue' }),
    ];
    (fetcher as any).cacheByProject.set(1, { issues, cachedAt: new Date().toISOString() });

    const found = fetcher.getIssueByKey('PROJ-42', 1);
    expect(found).toBeDefined();
    expect(found!.issueKey).toBe('PROJ-42');
    expect(found!.title).toBe('Jira issue');
  });

  it('should return undefined for a non-existent key', () => {
    const fetcher = new IssueFetcher();

    const issues: IssueNode[] = [
      makeIssueNode({ number: 42, issueKey: 'PROJ-42', issueProvider: 'jira' }),
    ];
    (fetcher as any).cacheByProject.set(1, { issues, cachedAt: new Date().toISOString() });

    const found = fetcher.getIssueByKey('NONEXIST-999', 1);
    expect(found).toBeUndefined();
  });

  it('should search all projects when projectId is not specified', () => {
    const fetcher = new IssueFetcher();

    const issuesA: IssueNode[] = [
      makeIssueNode({ number: 10, issueKey: 'ALPHA-10', issueProvider: 'jira' }),
    ];
    const issuesB: IssueNode[] = [
      makeIssueNode({ number: 20, issueKey: 'BETA-20', issueProvider: 'jira' }),
    ];
    (fetcher as any).cacheByProject.set(1, { issues: issuesA, cachedAt: new Date().toISOString() });
    (fetcher as any).cacheByProject.set(2, { issues: issuesB, cachedAt: new Date().toISOString() });

    const found = fetcher.getIssueByKey('BETA-20');
    expect(found).toBeDefined();
    expect(found!.issueKey).toBe('BETA-20');
  });

  it('should fall back to numeric lookup for numeric string keys', () => {
    const fetcher = new IssueFetcher();

    const issues: IssueNode[] = [
      makeIssueNode({ number: 42, issueKey: '42', issueProvider: 'github' }),
    ];
    (fetcher as any).cacheByProject.set(1, { issues, cachedAt: new Date().toISOString() });

    const found = fetcher.getIssueByKey('42', 1);
    expect(found).toBeDefined();
    expect(found!.number).toBe(42);
  });

  it('should find issues nested in children by key', () => {
    const fetcher = new IssueFetcher();

    const child = makeIssueNode({ number: 99, issueKey: 'PROJ-99', issueProvider: 'jira', title: 'Nested' });
    const parent = makeIssueNode({ number: 100, issueKey: 'PROJ-100', issueProvider: 'jira', title: 'Parent', children: [child] });
    (fetcher as any).cacheByProject.set(1, { issues: [parent], cachedAt: new Date().toISOString() });

    const found = fetcher.getIssueByKey('PROJ-99', 1);
    expect(found).toBeDefined();
    expect(found!.title).toBe('Nested');
  });
});

// =============================================================================
// Tests: getAvailableIssues — dual-keyed filtering
// =============================================================================

describe('getAvailableIssues with issueKey filtering', () => {
  it('should filter by issueKey when available', () => {
    const fetcher = new IssueFetcher();

    const issues: IssueNode[] = [
      makeIssueNode({ number: 42, issueKey: 'FRONTEND-42', issueProvider: 'jira', title: 'Frontend' }),
      makeIssueNode({ number: 42, issueKey: 'BACKEND-42', issueProvider: 'jira', title: 'Backend' }),
      makeIssueNode({ number: 43, issueKey: 'FRONTEND-43', issueProvider: 'jira', title: 'Available' }),
    ];
    (fetcher as any).cacheByProject.set(1, { issues, cachedAt: new Date().toISOString() });

    // Only FRONTEND-42 has an active team (by key)
    const available = fetcher.getAvailableIssues([], 1, ['FRONTEND-42']);

    // BACKEND-42 and FRONTEND-43 should be available; FRONTEND-42 should be filtered out
    expect(available).toHaveLength(2);
    expect(available.find((i) => i.issueKey === 'FRONTEND-42')).toBeUndefined();
    expect(available.find((i) => i.issueKey === 'BACKEND-42')).toBeDefined();
    expect(available.find((i) => i.issueKey === 'FRONTEND-43')).toBeDefined();
  });

  it('should still filter by number for backward compatibility', () => {
    const fetcher = new IssueFetcher();

    const issues: IssueNode[] = [
      makeIssueNode({ number: 42, title: 'GitHub issue' }),
      makeIssueNode({ number: 43, title: 'Another issue' }),
    ];
    (fetcher as any).cacheByProject.set(1, { issues, cachedAt: new Date().toISOString() });

    const available = fetcher.getAvailableIssues([42], 1);

    expect(available).toHaveLength(1);
    expect(available[0]!.number).toBe(43);
  });
});
