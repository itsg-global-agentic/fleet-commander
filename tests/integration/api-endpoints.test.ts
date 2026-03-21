// =============================================================================
// Fleet Commander -- API Integration Tests
// =============================================================================
// Spins up a real Fastify server with a temp SQLite database and exercises
// the HTTP API through Fastify's inject() helper (no network socket needed).
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Route plugins
import eventsRoutes from '../../src/server/routes/events.js';
import systemRoutes from '../../src/server/routes/system.js';
import prsRoutes from '../../src/server/routes/prs.js';
import streamRoutes from '../../src/server/routes/stream.js';

// DB helpers — we drive the singleton via env var + closeDatabase()
import { getDatabase, closeDatabase, FleetDatabase } from '../../src/server/db.js';

// Event collector throttle state reset (avoid cross-test bleed)
import { resetThrottleState } from '../../src/server/services/event-collector.js';

// SSE broker — imported so we can stop its heartbeat timer in cleanup
import { sseBroker } from '../../src/server/services/sse-broker.js';

// ---------------------------------------------------------------------------
// Test-level state
// ---------------------------------------------------------------------------

let server: FastifyInstance;
let dbPath: string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed a team directly in the DB so event routes can resolve worktree names. */
function seedTeam(
  overrides: {
    issueNumber?: number;
    worktreeName?: string;
    status?: string;
    phase?: string;
    prNumber?: number;
  } = {},
) {
  const db = getDatabase();
  return db.insertTeam({
    issueNumber: overrides.issueNumber ?? 100,
    worktreeName: overrides.worktreeName ?? 'kea-100',
    status: (overrides.status as any) ?? 'running',
    phase: (overrides.phase as any) ?? 'implementing',
    prNumber: overrides.prNumber ?? null,
  });
}

/** Seed a PR directly in the DB. */
function seedPR(prNumber: number, teamId: number) {
  const db = getDatabase();
  return db.insertPullRequest({
    prNumber,
    teamId,
    title: `PR #${prNumber}`,
    state: 'open',
    ciStatus: 'pending',
  });
}


// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 1. Create a temp DB file
  dbPath = path.join(
    os.tmpdir(),
    `fleet-integ-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );

  // 2. Point the singleton at the temp DB via env var, then close any
  //    existing singleton so the next getDatabase() picks up our path.
  closeDatabase();
  process.env['FLEET_DB_PATH'] = dbPath;

  // Force-initialise so schema is ready before routes register.
  getDatabase(dbPath);

  // 3. Build Fastify instance
  server = Fastify({ logger: false });
  await server.register(cors);

  // Register route plugins that are safe for integration testing.
  // We skip teamsRoutes (launch/stop/resume need child_process + git worktree)
  // and issueRoutes (needs gh CLI / issue-fetcher).
  // We register a subset of prsRoutes -- only the GET endpoints hit the DB.
  await server.register(eventsRoutes);
  await server.register(systemRoutes);

  // Register a simple health endpoint (mirrors the task spec)
  server.get('/api/health', async () => ({ status: 'ok' }));

  // Register the GET /api/teams and GET /api/teams/:id endpoints manually
  // to avoid pulling in team-manager dependencies from the full teamsRoutes plugin.
  server.get('/api/teams', async (_req, reply) => {
    const db = getDatabase();
    const dashboard = db.getTeamDashboard();
    return reply.code(200).send(dashboard);
  });

  server.get<{ Params: { id: string } }>(
    '/api/teams/:id',
    async (req, reply) => {
      const teamId = parseInt(req.params.id, 10);
      if (isNaN(teamId) || teamId < 1) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Invalid team ID' });
      }
      const db = getDatabase();
      const team = db.getTeam(teamId);
      if (!team) {
        return reply.code(404).send({ error: 'Not Found', message: `Team ${teamId} not found` });
      }
      return reply.code(200).send(team);
    },
  );

  // Register GET /api/prs manually to avoid gh CLI usage in POST routes
  server.get('/api/prs', async (_req, reply) => {
    const db = getDatabase();
    const prs = db.getAllPullRequests();
    return reply.code(200).send(prs);
  });

  await server.ready();
});

afterAll(async () => {
  // Stop SSE heartbeat so timer doesn't keep the process alive
  sseBroker.stop();

  await server.close();
  closeDatabase();

  // Clean up temp DB files
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      // best effort
    }
  }

  // Restore env
  delete process.env['FLEET_DB_PATH'];
});

beforeEach(() => {
  resetThrottleState();
});

// =============================================================================
// Health endpoint
// =============================================================================

describe('GET /api/health', () => {
  it('returns { status: "ok" }', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

// =============================================================================
// Events: POST + GET round-trip
// =============================================================================

describe('Events API', () => {
  it('POST /api/events creates an event for an existing team', async () => {
    seedTeam({ issueNumber: 100, worktreeName: 'kea-100' });

    const res = await server.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        event: 'session_start',
        team: 'kea-100',
        session_id: 'test-sess-1',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.team_id).toBeDefined();
    expect(body.processed).toBe(true);
    expect(body.event_id).toBeDefined();
    expect(body.event_id).toBeGreaterThan(0);
  });

  it('GET /api/events returns stored events', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/events?limit=10',
    });

    expect(res.statusCode).toBe(200);
    const events = res.json();
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
  });

  it('GET /api/events supports team_id filter', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/events?team_id=1&limit=50',
    });

    expect(res.statusCode).toBe(200);
    const events = res.json();
    expect(Array.isArray(events)).toBe(true);
    // Every event in the result should belong to team_id 1
    for (const ev of events) {
      expect(ev.teamId).toBe(1);
    }
  });

  it('GET /api/events supports type filter', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/events?type=SessionStart',
    });

    expect(res.statusCode).toBe(200);
    const events = res.json();
    expect(Array.isArray(events)).toBe(true);
    for (const ev of events) {
      expect(ev.eventType).toBe('SessionStart');
    }
  });

  it('POST /api/events rejects missing required fields', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/events',
      payload: { invalid: true },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('Bad Request');
  });

  it('POST /api/events rejects missing event field', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/events',
      payload: { team: 'kea-100' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('POST /api/events rejects missing team field', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/events',
      payload: { event: 'session_start' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('POST /api/events returns 404 for unknown team', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        event: 'session_start',
        team: 'kea-nonexistent-999',
      },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.message).toContain('not found');
  });

  it('GET /api/events rejects invalid team_id', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/events?team_id=abc',
    });

    expect(res.statusCode).toBe(400);
  });

  it('GET /api/events rejects invalid limit', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/events?limit=-5',
    });

    expect(res.statusCode).toBe(400);
  });
});

// =============================================================================
// Event -> DB verification: full round-trip
// =============================================================================

describe('Event -> DB verification', () => {
  it('POST event is persisted and returned by GET', async () => {
    // Seed a second team to avoid unique constraint with existing kea-100
    seedTeam({ issueNumber: 200, worktreeName: 'kea-200' });

    // POST a session_start event
    const postRes = await server.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        event: 'session_start',
        team: 'kea-200',
        session_id: 'verify-sess-1',
        agent_type: 'coordinator',
      },
    });
    expect(postRes.statusCode).toBe(200);
    const postBody = postRes.json();
    expect(postBody.processed).toBe(true);
    const eventId = postBody.event_id;

    // GET events filtered by team_id for the new team
    const getRes = await server.inject({
      method: 'GET',
      url: `/api/events?team_id=${postBody.team_id}`,
    });
    expect(getRes.statusCode).toBe(200);
    const events = getRes.json();

    // The event we just posted must be present
    const found = events.find((e: any) => e.id === eventId);
    expect(found).toBeDefined();
    expect(found.eventType).toBe('SessionStart');
    expect(found.sessionId).toBe('verify-sess-1');
    expect(found.agentName).toBe('coordinator');
  });

  it('multiple events create sequential IDs', async () => {
    seedTeam({ issueNumber: 300, worktreeName: 'kea-300' });

    const ids: number[] = [];
    for (const eventType of ['session_start', 'notification', 'session_end']) {
      const res = await server.inject({
        method: 'POST',
        url: '/api/events',
        payload: {
          event: eventType,
          team: 'kea-300',
          session_id: 'multi-sess',
        },
      });
      expect(res.statusCode).toBe(200);
      ids.push(res.json().event_id);
    }

    // IDs should be increasing
    expect(ids[1]).toBeGreaterThan(ids[0]);
    expect(ids[2]).toBeGreaterThan(ids[1]);
  });

  it('tool_use throttling works through the HTTP layer', async () => {
    seedTeam({ issueNumber: 400, worktreeName: 'kea-400' });

    // First tool_use goes through
    const r1 = await server.inject({
      method: 'POST',
      url: '/api/events',
      payload: { event: 'tool_use', team: 'kea-400', tool_name: 'Bash' },
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().processed).toBe(true);

    // Second tool_use within 5s window is deduplicated
    const r2 = await server.inject({
      method: 'POST',
      url: '/api/events',
      payload: { event: 'tool_use', team: 'kea-400', tool_name: 'Read' },
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().processed).toBe(false);
    expect(r2.json().event_id).toBeNull();
  });
});

// =============================================================================
// Teams: GET (read-only, no team-manager)
// =============================================================================

describe('Teams API (read-only)', () => {
  it('GET /api/teams returns dashboard data', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/teams' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    // At least the teams seeded earlier should appear
    expect(body.length).toBeGreaterThan(0);
  });

  it('GET /api/teams/:id returns team detail', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/teams/1' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(1);
    expect(body.worktreeName).toBeDefined();
  });

  it('GET /api/teams/:id returns 404 for unknown team', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/teams/9999' });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('Not Found');
  });

  it('GET /api/teams/:id returns 400 for non-numeric ID', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/teams/abc' });

    expect(res.statusCode).toBe(400);
  });
});

// =============================================================================
// PRs: GET (read-only)
// =============================================================================

describe('PRs API (read-only)', () => {
  it('GET /api/prs returns array of PRs', async () => {
    // Seed a PR so we have data
    seedPR(42, 1);

    const res = await server.inject({ method: 'GET', url: '/api/prs' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0].prNumber).toBe(42);
  });
});


// =============================================================================
// System: GET diagnostics and status
// =============================================================================

describe('System API', () => {
  it('GET /api/status returns server info', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/status' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.uptime).toBeDefined();
    expect(body.uptime.seconds).toBeGreaterThanOrEqual(0);
    expect(body.version).toBe('0.1.0');
  });

  it('GET /api/diagnostics/health returns fleet health', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/diagnostics/health',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.totalTeams).toBe('number');
    expect(typeof body.activeTeams).toBe('number');
    expect(body.totalTeams).toBeGreaterThan(0);
    expect(body.byStatus).toBeDefined();
    expect(body.byPhase).toBeDefined();
  });

  it('GET /api/diagnostics/stuck returns stuck candidates', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/diagnostics/stuck',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.count).toBe('number');
    expect(body.idleThresholdMin).toBeDefined();
    expect(body.stuckThresholdMin).toBeDefined();
    expect(Array.isArray(body.teams)).toBe(true);
  });

  it('GET /api/diagnostics/blocked returns blocked teams', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/diagnostics/blocked',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.count).toBe('number');
    expect(body.maxUniqueCiFailures).toBeDefined();
    expect(Array.isArray(body.teams)).toBe(true);
  });
});

// =============================================================================
// Team lifecycle: event flow updates team status
// =============================================================================

describe('Team lifecycle via events', () => {
  it('event on idle team transitions it back to running', async () => {
    // Seed a team in idle state
    const team = seedTeam({
      issueNumber: 500,
      worktreeName: 'kea-500',
      status: 'idle',
    });

    // Send an event -- this should transition idle -> running
    const eventRes = await server.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        event: 'notification',
        team: 'kea-500',
        message: 'Still alive',
      },
    });
    expect(eventRes.statusCode).toBe(200);

    // Verify the team status changed via GET /api/teams/:id
    const teamRes = await server.inject({
      method: 'GET',
      url: `/api/teams/${team.id}`,
    });
    expect(teamRes.statusCode).toBe(200);
    const updated = teamRes.json();
    expect(updated.status).toBe('running');
  });

  it('event on stuck team transitions it back to running', async () => {
    const team = seedTeam({
      issueNumber: 600,
      worktreeName: 'kea-600',
      status: 'stuck',
    });

    const eventRes = await server.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        event: 'session_start',
        team: 'kea-600',
        session_id: 'recovery-sess',
      },
    });
    expect(eventRes.statusCode).toBe(200);

    const teamRes = await server.inject({
      method: 'GET',
      url: `/api/teams/${team.id}`,
    });
    expect(teamRes.statusCode).toBe(200);
    expect(teamRes.json().status).toBe('running');
  });

  it('event updates lastEventAt on the team record', async () => {
    const team = seedTeam({
      issueNumber: 700,
      worktreeName: 'kea-700',
    });

    // Initially lastEventAt is null
    const beforeRes = await server.inject({
      method: 'GET',
      url: `/api/teams/${team.id}`,
    });
    const before = beforeRes.json();

    // Send an event
    await server.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        event: 'session_start',
        team: 'kea-700',
      },
    });

    // Now lastEventAt should be set
    const afterRes = await server.inject({
      method: 'GET',
      url: `/api/teams/${team.id}`,
    });
    const after = afterRes.json();
    expect(after.lastEventAt).toBeTruthy();
  });
});

// =============================================================================
// Content-type and general HTTP behavior
// =============================================================================

describe('HTTP behavior', () => {
  it('returns JSON content-type for API responses', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('returns 404 for unknown routes', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  it('handles empty POST body gracefully', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/events',
      // no payload
    });
    // Should return 400, not 500
    expect(res.statusCode).toBe(400);
  });
});
