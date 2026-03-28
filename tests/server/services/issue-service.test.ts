// =============================================================================
// Fleet Commander -- IssueService: business logic tests
// =============================================================================
// Tests IssueService methods by mocking the IssueFetcher singleton and using
// a real temp SQLite database for project queries.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

import { getDatabase, closeDatabase } from '../../../src/server/db.js';
import { sseBroker } from '../../../src/server/services/sse-broker.js';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const mockIssueTree = [
  {
    number: 10,
    title: 'Epic issue',
    state: 'open',
    labels: ['epic'],
    children: [
      {
        number: 11,
        title: 'Sub-issue 1',
        state: 'open',
        labels: ['ready'],
        children: [],
      },
      {
        number: 12,
        title: 'Sub-issue 2',
        state: 'closed',
        labels: [],
        children: [],
      },
    ],
  },
];

const mockFlatIssues = [
  { number: 11, title: 'Sub-issue 1', state: 'open', labels: ['ready'], children: [] },
  { number: 13, title: 'Available issue', state: 'open', labels: ['ready'], children: [] },
];

// ---------------------------------------------------------------------------
// Service mocks
// ---------------------------------------------------------------------------

const mockFetch = vi.fn().mockResolvedValue([]);
const mockFetchDependenciesForIssue = vi.fn().mockResolvedValue(null);
const mockEnrichWithTeamInfo = vi.fn().mockImplementation((issues: unknown[]) => issues);
const mockGetNextIssue = vi.fn().mockReturnValue(null);
const mockGetIssues = vi.fn().mockResolvedValue(mockIssueTree);
const mockGetIssuesByProject = vi.fn().mockReturnValue([]);
const mockGetCachedAt = vi.fn().mockReturnValue('2026-03-25T12:00:00Z');
const mockGetAvailableIssues = vi.fn().mockReturnValue(mockFlatIssues);
const mockGetIssue = vi.fn().mockReturnValue(null);
const mockRefresh = vi.fn().mockResolvedValue(mockIssueTree);
const mockStart = vi.fn();
const mockStop = vi.fn();

vi.mock('../../../src/server/services/issue-fetcher.js', () => ({
  getIssueFetcher: vi.fn(() => ({
    fetch: mockFetch,
    fetchDependenciesForIssue: mockFetchDependenciesForIssue,
    enrichWithTeamInfo: mockEnrichWithTeamInfo,
    getNextIssue: mockGetNextIssue,
    getIssues: mockGetIssues,
    getIssuesByProject: mockGetIssuesByProject,
    getCachedAt: mockGetCachedAt,
    getAvailableIssues: mockGetAvailableIssues,
    getIssue: mockGetIssue,
    start: mockStart,
    stop: mockStop,
    refresh: mockRefresh,
  })),
}));

// Import AFTER mocks
import { IssueService } from '../../../src/server/services/issue-service.js';
import { ServiceError } from '../../../src/server/services/service-error.js';

// ---------------------------------------------------------------------------
// Test-level state
// ---------------------------------------------------------------------------

let dbPath: string;
let service: IssueService;

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

beforeAll(() => {
  dbPath = path.join(
    os.tmpdir(),
    `fleet-issue-svc-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );

  closeDatabase();
  process.env['FLEET_DB_PATH'] = dbPath;
  getDatabase(dbPath);

  service = new IssueService();
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
  vi.clearAllMocks();
  // Restore default mock implementations
  mockEnrichWithTeamInfo.mockImplementation((issues: unknown[]) => issues);
  mockGetIssues.mockResolvedValue(mockIssueTree);
  mockGetIssuesByProject.mockReturnValue([]);
  mockGetCachedAt.mockReturnValue('2026-03-25T12:00:00Z');
  mockGetAvailableIssues.mockReturnValue(mockFlatIssues);
  mockGetIssue.mockReturnValue(null);
  mockGetNextIssue.mockReturnValue(null);
  mockRefresh.mockResolvedValue(mockIssueTree);
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
    name: overrides.name ?? `issue-svc-project-${Date.now()}`,
    repoPath: overrides.repoPath ?? `C:/fake/issue-svc-repo-${Date.now()}`,
    githubRepo: 'githubRepo' in overrides ? overrides.githubRepo : 'owner/repo',
  });
}

// =============================================================================
// Tests: getAllIssues
// =============================================================================

describe('IssueService.getAllIssues', () => {
  it('should return tree, groups, cachedAt, and count', async () => {
    const project = seedProject();
    mockGetIssuesByProject.mockReturnValue([
      { projectId: project.id, tree: mockIssueTree, cachedAt: '2026-03-25T12:00:00Z' },
    ]);

    const result = await service.getAllIssues();

    expect(result).toHaveProperty('tree');
    expect(result).toHaveProperty('groups');
    expect(result).toHaveProperty('cachedAt');
    expect(result).toHaveProperty('count');
    expect(Array.isArray(result.tree)).toBe(true);
    expect(Array.isArray(result.groups)).toBe(true);
  });

  it('should return empty tree when no projects have issues', async () => {
    mockGetIssuesByProject.mockReturnValue([]);

    const result = await service.getAllIssues();

    expect(result.tree).toHaveLength(0);
    expect(result.groups).toHaveLength(0);
    expect(result.count).toBe(0);
  });

  it('should include providers array in each group', async () => {
    const project = seedProject();
    const mixedProviderTree = [
      {
        number: 10,
        title: 'GitHub issue',
        state: 'open',
        labels: [],
        children: [],
        issueProvider: 'github',
      },
      {
        number: 20,
        title: 'Jira issue',
        state: 'open',
        labels: [],
        children: [],
        issueProvider: 'jira',
      },
    ];
    mockGetIssuesByProject.mockReturnValue([
      { projectId: project.id, tree: mixedProviderTree, cachedAt: '2026-03-25T12:00:00Z' },
    ]);

    const result = await service.getAllIssues();

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toHaveProperty('providers');
    expect(result.groups[0].providers).toContain('github');
    expect(result.groups[0].providers).toContain('jira');
  });

  it('should default to github provider when issueProvider is undefined', async () => {
    const project = seedProject();
    const treeWithoutProvider = [
      {
        number: 10,
        title: 'Legacy issue',
        state: 'open',
        labels: [],
        children: [],
        // No issueProvider set
      },
    ];
    mockGetIssuesByProject.mockReturnValue([
      { projectId: project.id, tree: treeWithoutProvider, cachedAt: '2026-03-25T12:00:00Z' },
    ]);

    const result = await service.getAllIssues();

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].providers).toEqual(['github']);
  });
});

// =============================================================================
// Tests: getProjectIssues
// =============================================================================

describe('IssueService.getProjectIssues', () => {
  it('should return issue tree for existing project', async () => {
    const project = seedProject();

    const result = await service.getProjectIssues(project.id);

    expect(result.projectId).toBe(project.id);
    expect(result.projectName).toBe(project.name);
    expect(Array.isArray(result.tree)).toBe(true);
    expect(result).toHaveProperty('cachedAt');
    expect(result).toHaveProperty('count');
  });

  it('should throw VALIDATION for invalid projectId', async () => {
    try {
      await service.getProjectIssues(NaN);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('VALIDATION');
    }
  });

  it('should throw NOT_FOUND for unknown project', async () => {
    try {
      await service.getProjectIssues(99999);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('NOT_FOUND');
    }
  });
});

// =============================================================================
// Tests: getNextIssue
// =============================================================================

describe('IssueService.getNextIssue', () => {
  it('should return null issue when no ready issues exist', () => {
    mockGetNextIssue.mockReturnValue(null);

    const result = service.getNextIssue();

    expect(result.issue).toBeNull();
    expect(result.reason).toContain('No available');
  });

  it('should return the highest priority issue when available', () => {
    const mockIssue = {
      number: 42,
      title: 'High priority issue',
      state: 'open',
      labels: ['ready'],
      children: [],
    };
    mockGetNextIssue.mockReturnValue(mockIssue);
    mockEnrichWithTeamInfo.mockReturnValue([mockIssue]);

    const result = service.getNextIssue();

    expect(result.issue).toBeDefined();
    expect(result.issue?.number).toBe(42);
    expect(result.reason).toContain('Highest priority');
  });
});

// =============================================================================
// Tests: getAvailableIssues
// =============================================================================

describe('IssueService.getAvailableIssues', () => {
  it('should return available issues with count', () => {
    const result = service.getAvailableIssues();

    expect(result).toHaveProperty('issues');
    expect(result).toHaveProperty('count');
    expect(Array.isArray(result.issues)).toBe(true);
    expect(result.count).toBe(mockFlatIssues.length);
  });

  it('should return empty list when no issues available', () => {
    mockGetAvailableIssues.mockReturnValue([]);
    mockEnrichWithTeamInfo.mockReturnValue([]);

    const result = service.getAvailableIssues();

    expect(result.issues).toHaveLength(0);
    expect(result.count).toBe(0);
  });
});

// =============================================================================
// Tests: getIssue
// =============================================================================

describe('IssueService.getIssue', () => {
  it('should throw VALIDATION for invalid issue number', () => {
    try {
      service.getIssue(0);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('VALIDATION');
    }
  });

  it('should throw VALIDATION for negative issue number', () => {
    try {
      service.getIssue(-5);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('VALIDATION');
    }
  });

  it('should throw NOT_FOUND when issue not in cache', () => {
    mockGetIssue.mockReturnValue(null);

    try {
      service.getIssue(999);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('NOT_FOUND');
      expect((err as ServiceError).message).toContain('999');
    }
  });

  it('should return enriched issue when found', () => {
    const mockIssue = {
      number: 42,
      title: 'Test issue',
      state: 'open',
      labels: [],
      children: [],
    };
    mockGetIssue.mockReturnValue(mockIssue);
    mockEnrichWithTeamInfo.mockReturnValue([mockIssue]);

    const result = service.getIssue(42);

    expect(result.number).toBe(42);
    expect(result.title).toBe('Test issue');
  });
});

// =============================================================================
// Tests: getProjectDependencies
// =============================================================================

describe('IssueService.getProjectDependencies', () => {
  it('should throw VALIDATION for invalid projectId', async () => {
    try {
      await service.getProjectDependencies(NaN);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('VALIDATION');
    }
  });

  it('should throw NOT_FOUND for unknown project', async () => {
    try {
      await service.getProjectDependencies(99999);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('NOT_FOUND');
    }
  });

  it('should throw VALIDATION when project has no GitHub repo', async () => {
    const project = seedProject({ githubRepo: null });

    try {
      await service.getProjectDependencies(project.id);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('VALIDATION');
      expect((err as ServiceError).message).toContain('no GitHub repo');
    }
  });
});

// =============================================================================
// Tests: getIssueDependencies
// =============================================================================

describe('IssueService.getIssueDependencies', () => {
  it('should throw VALIDATION for invalid issue number', async () => {
    try {
      await service.getIssueDependencies(0, 1);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('VALIDATION');
    }
  });

  it('should throw VALIDATION for invalid projectId', async () => {
    try {
      await service.getIssueDependencies(1, 0);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('VALIDATION');
    }
  });

  it('should throw NOT_FOUND for unknown project', async () => {
    try {
      await service.getIssueDependencies(1, 99999);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('NOT_FOUND');
    }
  });

  it('should return resolved when no deps found', async () => {
    const project = seedProject();
    mockFetchDependenciesForIssue.mockResolvedValue(null);

    const result = await service.getIssueDependencies(42, project.id) as Record<string, unknown>;

    expect(result.resolved).toBe(true);
    expect(result.openCount).toBe(0);
  });
});

// =============================================================================
// Tests: refresh
// =============================================================================

describe('IssueService.refresh', () => {
  it('should return refreshed tree with metadata', async () => {
    const result = await service.refresh();

    expect(result).toHaveProperty('refreshedAt');
    expect(result).toHaveProperty('issueCount');
    expect(result).toHaveProperty('tree');
    expect(Array.isArray(result.tree)).toBe(true);
    expect(mockRefresh).toHaveBeenCalled();
  });
});
