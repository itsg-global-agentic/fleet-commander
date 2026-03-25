// =============================================================================
// Fleet Commander -- TeamService: business logic tests
// =============================================================================
// Tests TeamService methods directly with a real temp SQLite database.
// Service dependencies (team-manager, issue-fetcher, github-poller, sse-broker)
// are mocked to isolate business logic from child processes and CLI calls.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

import { getDatabase, closeDatabase } from '../../../src/server/db.js';
import { sseBroker } from '../../../src/server/services/sse-broker.js';

// ---------------------------------------------------------------------------
// Service mocks -- must be set up BEFORE importing TeamService
// ---------------------------------------------------------------------------

const mockSendMessage = vi.fn();
const mockGetOutput = vi.fn().mockReturnValue([]);
const mockGetParsedEvents = vi.fn().mockReturnValue([]);
const mockLaunch = vi.fn().mockResolvedValue({ id: 99, status: 'launching' });
const mockStop = vi.fn().mockResolvedValue({ id: 1, status: 'done' });
const mockStopAll = vi.fn().mockResolvedValue([]);
const mockForceLaunch = vi.fn().mockResolvedValue({ id: 1, status: 'launching' });
const mockResume = vi.fn().mockResolvedValue({ id: 1, status: 'running' });
const mockRestart = vi.fn().mockResolvedValue({ id: 1, status: 'launching' });
const mockLaunchBatch = vi.fn().mockResolvedValue([]);
const mockQueueTeamWithBlockers = vi.fn().mockResolvedValue({ id: 1, status: 'queued' });

vi.mock('../../../src/server/services/team-manager.js', () => ({
  getTeamManager: vi.fn(() => ({
    sendMessage: mockSendMessage,
    getOutput: mockGetOutput,
    getParsedEvents: mockGetParsedEvents,
    launch: mockLaunch,
    stop: mockStop,
    stopAll: mockStopAll,
    forceLaunch: mockForceLaunch,
    resume: mockResume,
    restart: mockRestart,
    launchBatch: mockLaunchBatch,
    queueTeamWithBlockers: mockQueueTeamWithBlockers,
  })),
}));

vi.mock('../../../src/server/services/issue-fetcher.js', () => ({
  getIssueFetcher: vi.fn(() => ({
    fetch: vi.fn().mockResolvedValue([]),
    fetchDependenciesForIssue: vi.fn().mockResolvedValue(null),
    enrichWithTeamInfo: vi.fn().mockReturnValue([]),
    getIssues: vi.fn().mockResolvedValue([]),
    getIssuesByProject: vi.fn().mockReturnValue([]),
    getCachedAt: vi.fn().mockReturnValue(null),
    getAvailableIssues: vi.fn().mockReturnValue([]),
    getIssue: vi.fn().mockReturnValue(null),
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock('../../../src/server/services/github-poller.js', () => ({
  githubPoller: {
    getRecentPRs: vi.fn().mockReturnValue([]),
    trackBlockedIssue: vi.fn(),
  },
}));

// Mock project-service to control readiness checks
const mockGetProjectReadiness = vi.fn().mockReturnValue({ ready: true, errors: [] });

vi.mock('../../../src/server/services/project-service.js', () => ({
  getProjectService: vi.fn(() => ({
    getProjectReadiness: mockGetProjectReadiness,
  })),
}));

// Import AFTER mocks
import { TeamService } from '../../../src/server/services/team-service.js';
import { ServiceError } from '../../../src/server/services/service-error.js';

// ---------------------------------------------------------------------------
// Test-level state
// ---------------------------------------------------------------------------

let dbPath: string;
let service: TeamService;

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

beforeAll(() => {
  dbPath = path.join(
    os.tmpdir(),
    `fleet-team-svc-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );

  closeDatabase();
  process.env['FLEET_DB_PATH'] = dbPath;
  getDatabase(dbPath);

  service = new TeamService();
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
  mockGetProjectReadiness.mockReturnValue({ ready: true, errors: [] });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let teamCounter = 0;

function seedTeam(overrides: {
  issueNumber?: number;
  worktreeName?: string;
  status?: string;
  phase?: string;
  projectId?: number;
  launchedAt?: string;
  prNumber?: number | null;
} = {}) {
  teamCounter++;
  const db = getDatabase();
  return db.insertTeam({
    issueNumber: overrides.issueNumber ?? 2000 + teamCounter,
    worktreeName: overrides.worktreeName ?? `svc-test-${Date.now()}-${teamCounter}`,
    status: (overrides.status as 'running') ?? 'running',
    phase: (overrides.phase as 'implementing') ?? 'implementing',
    projectId: overrides.projectId ?? null,
    launchedAt: overrides.launchedAt ?? new Date().toISOString(),
    prNumber: overrides.prNumber ?? null,
  });
}

function seedProject(overrides: {
  name?: string;
  repoPath?: string;
} = {}) {
  const db = getDatabase();
  return db.insertProject({
    name: overrides.name ?? `svc-project-${Date.now()}`,
    repoPath: overrides.repoPath ?? `C:/fake/svc-repo-${Date.now()}`,
  });
}

// =============================================================================
// Tests: launchTeam
// =============================================================================

describe('TeamService.launchTeam', () => {
  it('should throw VALIDATION for missing projectId', async () => {
    await expect(
      service.launchTeam({ projectId: 0, issueNumber: 1 }),
    ).rejects.toThrow(ServiceError);

    try {
      await service.launchTeam({ projectId: 0, issueNumber: 1 });
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('VALIDATION');
    }
  });

  it('should throw VALIDATION for missing issueNumber', async () => {
    await expect(
      service.launchTeam({ projectId: 1, issueNumber: 0 }),
    ).rejects.toThrow(ServiceError);

    try {
      await service.launchTeam({ projectId: 1, issueNumber: 0 });
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('VALIDATION');
    }
  });

  it('should throw PROJECT_NOT_READY when project is not ready', async () => {
    mockGetProjectReadiness.mockReturnValue({
      ready: false,
      errors: ['Hooks not installed'],
    });

    try {
      await service.launchTeam({ projectId: 1, issueNumber: 1 });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('PROJECT_NOT_READY');
    }
  });

  it('should bypass readiness check when force=true', async () => {
    mockGetProjectReadiness.mockReturnValue({
      ready: false,
      errors: ['Hooks not installed'],
    });

    const result = await service.launchTeam({
      projectId: 1,
      issueNumber: 1,
      force: true,
    });

    expect(result).toBeDefined();
    expect(mockLaunch).toHaveBeenCalled();
  });

  it('should delegate to manager.launch on success', async () => {
    const result = await service.launchTeam({ projectId: 1, issueNumber: 42 });

    expect(result).toEqual({ id: 99, status: 'launching' });
    expect(mockLaunch).toHaveBeenCalledWith(1, 42, undefined, undefined, undefined, undefined);
  });
});

// =============================================================================
// Tests: launchBatch
// =============================================================================

describe('TeamService.launchBatch', () => {
  it('should throw VALIDATION for missing projectId', async () => {
    try {
      await service.launchBatch({ projectId: 0, issues: [{ number: 1 }] });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('VALIDATION');
    }
  });

  it('should throw VALIDATION for empty issues array', async () => {
    try {
      await service.launchBatch({ projectId: 1, issues: [] });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('VALIDATION');
    }
  });

  it('should throw VALIDATION for invalid issue number', async () => {
    try {
      await service.launchBatch({ projectId: 1, issues: [{ number: -1 }] });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('VALIDATION');
    }
  });

  it('should throw PROJECT_NOT_READY when project is not ready', async () => {
    mockGetProjectReadiness.mockReturnValue({
      ready: false,
      errors: ['Hooks not installed'],
    });

    try {
      await service.launchBatch({ projectId: 1, issues: [{ number: 1 }] });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('PROJECT_NOT_READY');
    }
  });
});

// =============================================================================
// Tests: getTeamDetail
// =============================================================================

describe('TeamService.getTeamDetail', () => {
  it('should return enriched detail for existing team', () => {
    const team = seedTeam();
    mockGetOutput.mockReturnValue(['line1']);
    mockGetParsedEvents.mockReturnValue([]);

    const detail = service.getTeamDetail(team.id) as Record<string, unknown>;

    expect(detail.id).toBe(team.id);
    expect(detail.issueNumber).toBe(team.issueNumber);
    expect(detail.status).toBe('running');
    expect(detail.durationMin).toBeDefined();
    expect(typeof detail.durationMin).toBe('number');
    expect(detail.outputTail).toBe('line1');
  });

  it('should throw NOT_FOUND for unknown team', () => {
    try {
      service.getTeamDetail(99999);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('NOT_FOUND');
    }
  });

  it('should compute duration correctly', () => {
    const launched = new Date();
    launched.setMinutes(launched.getMinutes() - 30);
    const team = seedTeam({ launchedAt: launched.toISOString() });
    mockGetOutput.mockReturnValue([]);

    const detail = service.getTeamDetail(team.id) as Record<string, unknown>;
    const durationMin = detail.durationMin as number;

    // Should be approximately 30 minutes (allow a margin)
    expect(durationMin).toBeGreaterThanOrEqual(29);
    expect(durationMin).toBeLessThanOrEqual(31);
  });
});

// =============================================================================
// Tests: sendMessage
// =============================================================================

describe('TeamService.sendMessage', () => {
  it('should throw VALIDATION for empty message', () => {
    try {
      service.sendMessage(1, '');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('VALIDATION');
    }
  });

  it('should throw VALIDATION for whitespace-only message', () => {
    try {
      service.sendMessage(1, '   ');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('VALIDATION');
    }
  });

  it('should throw NOT_FOUND for unknown team', () => {
    try {
      service.sendMessage(99999, 'hello');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('NOT_FOUND');
    }
  });

  it('should return delivered=true when stdin delivery succeeds', () => {
    const team = seedTeam();
    mockSendMessage.mockReturnValue(true);

    const result = service.sendMessage(team.id, 'hello');

    expect(result.delivered).toBe(true);
    expect(result.command).toBeDefined();
    expect(mockSendMessage).toHaveBeenCalledWith(team.id, 'hello', 'user');
  });

  it('should return delivered=false when stdin delivery fails', () => {
    const team = seedTeam();
    mockSendMessage.mockReturnValue(false);

    const result = service.sendMessage(team.id, 'hello');

    expect(result.delivered).toBe(false);
    expect(result.command).toBeDefined();
  });
});

// =============================================================================
// Tests: setPhase
// =============================================================================

describe('TeamService.setPhase', () => {
  it('should update phase for valid input', () => {
    const team = seedTeam();

    const updated = service.setPhase(team.id, 'reviewing') as Record<string, unknown>;

    expect(updated).toBeDefined();
    // Verify the DB was updated
    const db = getDatabase();
    const refreshed = db.getTeam(team.id);
    expect(refreshed?.phase).toBe('reviewing');
  });

  it('should throw VALIDATION for invalid phase', () => {
    const team = seedTeam();

    try {
      service.setPhase(team.id, 'invalid_phase' as 'init');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('VALIDATION');
    }
  });

  it('should throw NOT_FOUND for unknown team', () => {
    try {
      service.setPhase(99999, 'reviewing');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('NOT_FOUND');
    }
  });

  it('should throw CONFLICT for terminal status (done)', () => {
    const team = seedTeam({ status: 'done' });

    try {
      service.setPhase(team.id, 'reviewing');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('CONFLICT');
    }
  });

  it('should throw CONFLICT for terminal status (failed)', () => {
    const team = seedTeam({ status: 'failed' });

    try {
      service.setPhase(team.id, 'reviewing');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('CONFLICT');
    }
  });
});

// =============================================================================
// Tests: acknowledgeAlert
// =============================================================================

describe('TeamService.acknowledgeAlert', () => {
  it('should transition stuck team to idle', () => {
    const team = seedTeam({ status: 'stuck' });

    const updated = service.acknowledgeAlert(team.id) as Record<string, unknown>;

    expect(updated).toBeDefined();
    const db = getDatabase();
    const refreshed = db.getTeam(team.id);
    expect(refreshed?.status).toBe('idle');
  });

  it('should transition failed team to done', () => {
    const team = seedTeam({ status: 'failed' });

    const updated = service.acknowledgeAlert(team.id) as Record<string, unknown>;

    expect(updated).toBeDefined();
    const db = getDatabase();
    const refreshed = db.getTeam(team.id);
    expect(refreshed?.status).toBe('done');
  });

  it('should throw VALIDATION for running team', () => {
    const team = seedTeam({ status: 'running' });

    try {
      service.acknowledgeAlert(team.id);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('VALIDATION');
    }
  });

  it('should throw NOT_FOUND for unknown team', () => {
    try {
      service.acknowledgeAlert(99999);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('NOT_FOUND');
    }
  });
});

// =============================================================================
// Tests: listTeams
// =============================================================================

describe('TeamService.listTeams', () => {
  it('should return paginated response with limit/offset', () => {
    seedTeam();

    const result = service.listTeams({ limit: 10, offset: 0 });

    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('limit');
    expect(result).toHaveProperty('offset');
  });

  it('should return bare array when called without pagination', () => {
    seedTeam();

    const result = service.listTeams();

    expect(Array.isArray(result)).toBe(true);
  });
});

// =============================================================================
// Tests: getOutput
// =============================================================================

describe('TeamService.getOutput', () => {
  it('should throw VALIDATION for invalid team ID', () => {
    try {
      service.getOutput(NaN);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('VALIDATION');
    }
  });

  it('should throw NOT_FOUND for unknown team', () => {
    try {
      service.getOutput(99999);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('NOT_FOUND');
    }
  });

  it('should return output for existing team', () => {
    const team = seedTeam();
    mockGetOutput.mockReturnValue(['line1', 'line2']);

    const result = service.getOutput(team.id);

    expect(result.teamId).toBe(team.id);
    expect(result.lines).toEqual(['line1', 'line2']);
    expect(result.count).toBe(2);
  });
});

// =============================================================================
// Tests: getEvents
// =============================================================================

describe('TeamService.getEvents', () => {
  it('should throw VALIDATION for invalid team ID', () => {
    try {
      service.getEvents(NaN);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('VALIDATION');
    }
  });

  it('should throw NOT_FOUND for unknown team', () => {
    try {
      service.getEvents(99999);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('NOT_FOUND');
    }
  });

  it('should return paginated events for existing team', () => {
    const team = seedTeam();

    const result = service.getEvents(team.id);

    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('limit');
    expect(result).toHaveProperty('offset');
  });
});

// =============================================================================
// Tests: stopTeam
// =============================================================================

describe('TeamService.stopTeam', () => {
  it('should throw VALIDATION for invalid team ID', async () => {
    try {
      await service.stopTeam(NaN);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('VALIDATION');
    }
  });

  it('should delegate to manager.stop', async () => {
    const team = seedTeam();
    mockStop.mockResolvedValue({ id: team.id, status: 'done' });

    const result = await service.stopTeam(team.id);

    expect(result).toEqual({ id: team.id, status: 'done' });
    expect(mockStop).toHaveBeenCalledWith(team.id);
  });
});

// =============================================================================
// Tests: exportTeam
// =============================================================================

describe('TeamService.exportTeam', () => {
  it('should return JSON export by default', () => {
    const team = seedTeam({ worktreeName: `export-test-${Date.now()}` });
    mockGetParsedEvents.mockReturnValue([]);
    mockGetOutput.mockReturnValue([]);

    const result = service.exportTeam(team.id);

    expect(result.contentType).toBe('application/json');
    expect(result.filename).toContain('.json');
    expect(result.data).toBeDefined();
  });

  it('should return text export for format=txt', () => {
    const team = seedTeam({ worktreeName: `export-txt-test-${Date.now()}` });
    mockGetParsedEvents.mockReturnValue([]);
    mockGetOutput.mockReturnValue(['output line']);

    const result = service.exportTeam(team.id, 'txt');

    expect(result.contentType).toBe('text/plain');
    expect(result.filename).toContain('.txt');
    expect(typeof result.data).toBe('string');
    expect((result.data as string)).toContain('output line');
  });

  it('should throw NOT_FOUND for unknown team', () => {
    try {
      service.exportTeam(99999);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('NOT_FOUND');
    }
  });
});
