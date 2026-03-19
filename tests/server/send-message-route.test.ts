// =============================================================================
// Fleet Commander -- Send-message route: 201 vs 422 behavior
// =============================================================================
// Verifies that POST /api/teams/:id/send-message returns 201 when the message
// is delivered via stdin, and 422 when the team has no active stdin pipe.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import os from 'os';
import path from 'path';
import fs from 'fs';

import { getDatabase, closeDatabase } from '../../src/server/db.js';
import { sseBroker } from '../../src/server/services/sse-broker.js';

// We need to mock getTeamManager to control sendMessage() return value
import { getTeamManager } from '../../src/server/services/team-manager.js';
vi.mock('../../src/server/services/team-manager.js', () => {
  const mockSendMessage = vi.fn();
  return {
    getTeamManager: vi.fn(() => ({
      sendMessage: mockSendMessage,
    })),
  };
});

// Mock the issue-fetcher to avoid gh CLI calls
vi.mock('../../src/server/services/issue-fetcher.js', () => ({
  getIssueFetcher: vi.fn(() => ({
    fetch: vi.fn().mockResolvedValue([]),
  })),
}));

// Mock the github-poller to avoid gh CLI calls
vi.mock('../../src/server/services/github-poller.js', () => ({
  githubPoller: {
    getRecentPRs: vi.fn().mockReturnValue([]),
  },
}));

// Import routes after mocks
import teamsRoutes from '../../src/server/routes/teams.js';

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
    `fleet-sendmsg-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );

  closeDatabase();
  process.env['FLEET_DB_PATH'] = dbPath;
  getDatabase(dbPath);

  server = Fastify({ logger: false });
  await server.register(teamsRoutes);
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedTeam(overrides: { issueNumber?: number; worktreeName?: string; status?: string } = {}) {
  const db = getDatabase();
  return db.insertTeam({
    issueNumber: overrides.issueNumber ?? 100,
    worktreeName: overrides.worktreeName ?? `sendmsg-test-${Date.now()}`,
    status: (overrides.status as 'running') ?? 'running',
    phase: 'implementing' as 'implementing',
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('POST /api/teams/:id/send-message', () => {
  it('returns 201 when message is delivered via stdin', async () => {
    const team = seedTeam({ issueNumber: 801, worktreeName: 'sendmsg-801' });

    // Mock sendMessage to return true (delivery succeeded)
    const manager = getTeamManager();
    (manager.sendMessage as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const res = await server.inject({
      method: 'POST',
      url: `/api/teams/${team.id}/send-message`,
      payload: { message: 'Hello team' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('delivered');
    expect(body.deliveredAt).toBeDefined();
  });

  it('returns 422 when message is not delivered (no stdin pipe)', async () => {
    const team = seedTeam({ issueNumber: 802, worktreeName: 'sendmsg-802' });

    // Mock sendMessage to return false (no stdin pipe)
    const manager = getTeamManager();
    (manager.sendMessage as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const res = await server.inject({
      method: 'POST',
      url: `/api/teams/${team.id}/send-message`,
      payload: { message: 'Hello team' },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe('Unprocessable Entity');
    expect(body.message).toContain('not running');
    expect(body.message).toContain('not delivered');
    // Command record should still be present in the response
    expect(body.id).toBeDefined();
    expect(body.teamId).toBe(team.id);
  });

  it('still inserts command record in DB even when delivery fails', async () => {
    const team = seedTeam({ issueNumber: 803, worktreeName: 'sendmsg-803' });

    const manager = getTeamManager();
    (manager.sendMessage as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const res = await server.inject({
      method: 'POST',
      url: `/api/teams/${team.id}/send-message`,
      payload: { message: 'Pending message' },
    });

    expect(res.statusCode).toBe(422);

    // Verify command was persisted in DB (undelivered = still pending)
    const db = getDatabase();
    const commands = db.getPendingCommands(team.id);
    expect(commands.length).toBe(1);
    expect(commands[0]!.message).toBe('Pending message');
  });

  it('returns 400 for empty message', async () => {
    const team = seedTeam({ issueNumber: 804, worktreeName: 'sendmsg-804' });

    const res = await server.inject({
      method: 'POST',
      url: `/api/teams/${team.id}/send-message`,
      payload: { message: '' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for unknown team', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/teams/9999/send-message',
      payload: { message: 'Hello' },
    });

    expect(res.statusCode).toBe(404);
  });
});
