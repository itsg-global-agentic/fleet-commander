// =============================================================================
// Fleet Commander -- HTTP Hook Routes: HTTP contract tests (issue #735)
// =============================================================================
// Tests POST /api/hooks/:eventType — the native HTTP hook endpoint that
// replaces the bash + curl fire-and-forget chain. Mirrors the structure of
// tests/server/routes/handoff-routes.test.ts (Fastify inject + real
// temporary SQLite DB).
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import os from 'os';
import path from 'path';
import fs from 'fs';

import { getDatabase, closeDatabase } from '../../../src/server/db.js';
import { sseBroker } from '../../../src/server/services/sse-broker.js';
import {
  resetThrottleState,
  resetEventDedupState,
  resetSubagentTrackers,
  resetPrPollState,
} from '../../../src/server/services/event-collector.js';
import hooksRoutes from '../../../src/server/routes/hooks.js';

// ---------------------------------------------------------------------------
// Stub the team-manager service so the hook route can call processQueue and
// sendMessage without spinning up real child processes.
// ---------------------------------------------------------------------------

vi.mock('../../../src/server/services/team-manager.js', () => ({
  getTeamManager: vi.fn(() => ({
    sendMessage: vi.fn(),
    processQueue: vi.fn().mockResolvedValue(undefined),
    noteLastAssistantMessage: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let server: FastifyInstance;
let dbPath: string;
let counter = 0;

function seedTeam(
  worktreeName: string,
  overrides: { status?: 'queued' | 'launching' | 'running' | 'idle' | 'stuck' | 'done' | 'failed' } = {},
) {
  counter++;
  const db = getDatabase();
  return db.insertTeam({
    issueNumber: 700 + counter,
    worktreeName,
    status: overrides.status ?? 'running',
    phase: 'implementing',
    prNumber: null,
  });
}

beforeAll(async () => {
  dbPath = path.join(
    os.tmpdir(),
    `fleet-hooks-routes-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  closeDatabase();
  process.env['FLEET_DB_PATH'] = dbPath;
  getDatabase(dbPath);

  server = Fastify({ logger: false });
  await server.register(hooksRoutes);
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
  // Reset module-level state so each test starts clean. Without this, the
  // dedup window from a previous test can swallow a fresh stop event.
  resetThrottleState();
  resetEventDedupState();
  resetSubagentTrackers();
  resetPrPollState();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCwd(worktree: string): string {
  return `C:/Git/test-repo/.claude/worktrees/${worktree}`;
}

async function postHook(eventType: string, body: Record<string, unknown>) {
  return server.inject({
    method: 'POST',
    url: `/api/hooks/${eventType}`,
    payload: body,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Happy-path tests
// ---------------------------------------------------------------------------

describe('POST /api/hooks/SessionStart', () => {
  it('returns 204 on success and persists an events row', async () => {
    const worktree = `hooks-sess-${Date.now()}`;
    const team = seedTeam(worktree, { status: 'launching' });

    const res = await postHook('SessionStart', {
      session_id: 'sess-abc',
      cwd: makeCwd(worktree),
      source: 'startup',
    });

    expect(res.statusCode).toBe(204);
    expect(res.payload).toBe('');

    const db = getDatabase();
    const events = db.getEventsByTeam(team.id);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].eventType).toBe('SessionStart');
    expect(events[0].sessionId).toBe('sess-abc');
  });
});

describe('POST /api/hooks/PostToolUse', () => {
  it('returns 204 and stores the tool name and tool_input on the event', async () => {
    const worktree = `hooks-tool-${Date.now()}`;
    const team = seedTeam(worktree);

    const res = await postHook('PostToolUse', {
      session_id: 'sess-tool',
      cwd: makeCwd(worktree),
      tool_name: 'Bash',
      tool_input: { command: 'echo hi', description: 'greet' },
    });

    expect(res.statusCode).toBe(204);

    const db = getDatabase();
    const events = db.getEventsByTeam(team.id);
    const toolEvent = events.find((e) => e.eventType === 'ToolUse');
    expect(toolEvent).toBeDefined();
    expect(toolEvent?.toolName).toBe('Bash');
    // Payload JSON contains the stringified tool_input
    expect(toolEvent?.payload).toContain('echo hi');
  });
});

describe('POST /api/hooks/Stop', () => {
  it('persists background_tasks JSON on the team row when present', async () => {
    const worktree = `hooks-bg-${Date.now()}`;
    const team = seedTeam(worktree);

    const res = await postHook('Stop', {
      session_id: 'sess-stop',
      cwd: makeCwd(worktree),
      background_tasks: [
        { id: 'bg-1', state: 'pending' },
        { id: 'bg-2', state: 'pending' },
      ],
    });

    expect(res.statusCode).toBe(204);

    const db = getDatabase();
    const refreshed = db.getTeam(team.id);
    expect(refreshed?.backgroundTasksJson).toBeTruthy();
    // Round-trip: the stored JSON must parse to an array with both entries.
    const parsed = JSON.parse(refreshed!.backgroundTasksJson!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
  });

  it('does not write background_tasks_json when the field is absent', async () => {
    const worktree = `hooks-nobg-${Date.now()}`;
    const team = seedTeam(worktree);

    await postHook('Stop', {
      session_id: 'sess-nobg',
      cwd: makeCwd(worktree),
    });

    const db = getDatabase();
    const refreshed = db.getTeam(team.id);
    expect(refreshed?.backgroundTasksJson ?? null).toBeNull();
  });
});

describe('POST /api/hooks/SubagentStop', () => {
  it('returns 204 and records the event with the subagent name', async () => {
    const worktree = `hooks-sub-${Date.now()}`;
    const team = seedTeam(worktree);

    const res = await postHook('SubagentStop', {
      session_id: 'sess-sub',
      cwd: makeCwd(worktree),
      teammate_name: 'fleet-dev',
    });

    expect(res.statusCode).toBe(204);
    const db = getDatabase();
    const events = db.getEventsByTeam(team.id);
    expect(events.some((e) => e.eventType === 'SubagentStop')).toBe(true);
  });
});

describe('POST /api/hooks/PostToolUseFailure', () => {
  it('maps to tool_error and stores error_details on the event payload', async () => {
    const worktree = `hooks-err-${Date.now()}`;
    const team = seedTeam(worktree);

    const res = await postHook('PostToolUseFailure', {
      session_id: 'sess-err',
      cwd: makeCwd(worktree),
      tool_name: 'Bash',
      tool_use_id: 'tu-1',
      error: 'exit 1',
      error_details: 'command not found',
    });

    expect(res.statusCode).toBe(204);

    const db = getDatabase();
    const events = db.getEventsByTeam(team.id);
    const errEvent = events.find((e) => e.eventType === 'ToolError');
    expect(errEvent).toBeDefined();
    expect(errEvent?.payload).toContain('command not found');
  });
});

// ---------------------------------------------------------------------------
// Error-path tests
// ---------------------------------------------------------------------------

describe('POST /api/hooks — error paths', () => {
  it('returns 400 for an unknown event type', async () => {
    const worktree = `hooks-unknown-${Date.now()}`;
    seedTeam(worktree);

    const res = await postHook('UnknownEvent', {
      cwd: makeCwd(worktree),
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).message).toMatch(/Unknown hook event type/);
  });

  it('returns 400 for an empty body (no cwd / transcript_path)', async () => {
    const res = await postHook('SessionStart', {});
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).message).toMatch(/cwd/);
  });

  it('returns 400 when cwd / transcript_path are both missing on a payload with other fields', async () => {
    const res = await postHook('PostToolUse', {
      session_id: 'sess-x',
      tool_name: 'Read',
    });
    expect(res.statusCode).toBe(400);
  });

  it('silently accepts (204) when the cwd resolves to a team that does not exist', async () => {
    // Issue #755: 404 caused WorktreeCreate to block CC turns and PostToolUse
    // to spam visible errors. Matches bash-hook silent-swallow behavior.
    const res = await postHook('SessionStart', {
      cwd: makeCwd('nonexistent-team-99999'),
    });
    expect(res.statusCode).toBe(204);
    expect(res.payload).toBe('');
  });

  it('returns 204 for a PostToolUse with no matching team (regression: issue #755)', async () => {
    const res = await postHook('PostToolUse', {
      session_id: 'sess-no-team',
      cwd: makeCwd('definitely-not-a-team'),
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.payload).toBe('');
  });

  it('returns 204 for a WorktreeCreate with no matching team (launch-blocker regression: issue #755)', async () => {
    // WorktreeCreate is synchronous — a non-2xx aborts the worktree creation
    // and breaks every team launch in hook_mode=http.
    const res = await postHook('WorktreeCreate', {
      session_id: 'sess-wt-create',
      cwd: 'C:/Git/some-project',
      hookSpecificOutput: {
        worktreePath: 'C:/Git/some-project/.claude/worktrees/foo',
      },
    });
    expect(res.statusCode).toBe(204);
  });

  it('does not insert an events row when the cwd has no matching team (issue #755)', async () => {
    // Silent-accept must skip the entire pipeline. If we wrote a row we would
    // pollute the events table with orphan rows from interactive CC sessions.
    // We seed a control team and ensure its event count is unchanged after a
    // no-team hook fires — i.e. the no-team hook neither created a phantom
    // row nor accidentally attached to a real team.
    const worktree = `hooks-noteam-control-${Date.now()}`;
    const controlTeam = seedTeam(worktree);
    const db = getDatabase();
    const beforeControl = db.getEventsByTeamCount(controlTeam.id);

    const res = await postHook('PostToolUse', {
      session_id: 'sess-no-team-no-row',
      cwd: makeCwd('still-not-a-team-77777'),
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/whatever' },
    });
    expect(res.statusCode).toBe(204);

    const afterControl = db.getEventsByTeamCount(controlTeam.id);
    expect(afterControl).toBe(beforeControl);
  });

  it('returns 400 when the body is null', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/hooks/SessionStart',
      payload: 'null',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when the body is a JSON array (not an object)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/hooks/SessionStart',
      payload: '[1, 2, 3]',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Event-name map coverage
// ---------------------------------------------------------------------------

describe('PASCAL_TO_SNAKE event name map', () => {
  it('covers all hook types declared in settings.json.example', async () => {
    // Load the bash example so this stays in sync with the deployment
    // template. The HTTP template uses the same set of hook types so we
    // only need to check one.
    const examplePath = path.join(
      process.cwd(),
      'hooks',
      'settings.json.example',
    );
    const example = JSON.parse(fs.readFileSync(examplePath, 'utf-8')) as {
      hooks: Record<string, unknown>;
    };
    const declaredTypes = Object.keys(example.hooks ?? {});

    // Dynamically import the map so we don't have to re-export it from the
    // route module just for tests.
    const { PASCAL_TO_SNAKE } = await import(
      '../../../src/server/routes/hooks.js'
    );
    for (const eventType of declaredTypes) {
      expect(PASCAL_TO_SNAKE).toHaveProperty(eventType);
    }
  });

  it('includes PermissionRequest in the map', async () => {
    const { PASCAL_TO_SNAKE } = await import(
      '../../../src/server/routes/hooks.js'
    );
    expect(PASCAL_TO_SNAKE).toHaveProperty('PermissionRequest');
    expect(PASCAL_TO_SNAKE['PermissionRequest']).toBe('permission_request');
  });
});

// ---------------------------------------------------------------------------
// POST /api/hooks/PermissionRequest — synchronous permission gate (issue #736)
// ---------------------------------------------------------------------------

describe('POST /api/hooks/PermissionRequest', () => {
  /**
   * Helper to seed a project + team for permission tests.
   * Returns { project, team, cwd }.
   */
  function seedPermissionTeam(
    overrides: { permissionPolicy?: 'skip' | 'hook' | null; allowedDomainsJson?: string | null } = {},
  ) {
    counter++;
    const db = getDatabase();
    const worktreePath = `C:/Git/test-repo/.claude/worktrees/perm-test-${counter}`;
    const project = db.insertProject({
      name: `perm-project-${counter}`,
      repoPath: `C:/Git/fake-perm-repo-${counter}`,
      permissionPolicy: overrides.permissionPolicy ?? null,
      allowedDomainsJson: overrides.allowedDomainsJson ?? null,
    });
    const team = db.insertTeam({
      issueNumber: 900 + counter,
      worktreeName: `perm-test-${counter}`,
      projectId: project.id,
      status: 'running',
      phase: 'implementing',
      prNumber: null,
    });
    return { project, team, cwd: worktreePath };
  }

  it('returns 200 with { decision: "ask" } as safe fallback when project has no permission_policy', async () => {
    const { cwd } = seedPermissionTeam({ permissionPolicy: null });

    const res = await postHook('PermissionRequest', {
      session_id: 'sess-perm-ask',
      cwd,
      tool_name: 'Read',
      tool_input: { file_path: `${cwd}/src/index.ts` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { decision: string };
    expect(body.decision).toBe('ask');
  });

  it('returns 200 with { decision: "ask" } when permissionPolicy is "skip"', async () => {
    const { cwd } = seedPermissionTeam({ permissionPolicy: 'skip' });

    const res = await postHook('PermissionRequest', {
      session_id: 'sess-perm-skip',
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { decision: string };
    expect(body.decision).toBe('ask');
  });

  it('returns 200 with { decision: "allow" } for a Read tool on permission_policy="hook" project', async () => {
    const { cwd } = seedPermissionTeam({ permissionPolicy: 'hook' });

    const res = await postHook('PermissionRequest', {
      session_id: 'sess-perm-read',
      cwd,
      tool_name: 'Read',
      tool_input: { file_path: `${cwd}/src/index.ts` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { decision: string };
    expect(body.decision).toBe('allow');
  });

  it('returns 200 with { decision: "allow" } for a Write tool inside the worktree', async () => {
    const { cwd } = seedPermissionTeam({ permissionPolicy: 'hook' });

    const res = await postHook('PermissionRequest', {
      session_id: 'sess-perm-write-in',
      cwd,
      tool_name: 'Write',
      tool_input: { file_path: `${cwd}/src/output.ts` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { decision: string };
    expect(body.decision).toBe('allow');
  });

  it('returns 200 with { decision: "deny" } for a Write tool targeting a path outside the worktree', async () => {
    const { cwd } = seedPermissionTeam({ permissionPolicy: 'hook' });

    const res = await postHook('PermissionRequest', {
      session_id: 'sess-perm-write-out',
      cwd,
      tool_name: 'Write',
      tool_input: { file_path: 'C:/Windows/System32/evil.bat' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { decision: string };
    expect(body.decision).toBe('deny');
  });

  it('returns 200 with { decision: "deny" } for WebFetch when domain is not in allowed_domains_json', async () => {
    const { cwd } = seedPermissionTeam({
      permissionPolicy: 'hook',
      allowedDomainsJson: '["api.github.com"]',
    });

    const res = await postHook('PermissionRequest', {
      session_id: 'sess-perm-net-deny',
      cwd,
      tool_name: 'WebFetch',
      tool_input: { url: 'https://evil.example.com/steal' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { decision: string };
    expect(body.decision).toBe('deny');
  });

  it('returns 200 with { decision: "allow" } for WebFetch when domain is in allowed_domains_json', async () => {
    const { cwd } = seedPermissionTeam({
      permissionPolicy: 'hook',
      allowedDomainsJson: '["api.github.com"]',
    });

    const res = await postHook('PermissionRequest', {
      session_id: 'sess-perm-net-allow',
      cwd,
      tool_name: 'WebFetch',
      tool_input: { url: 'https://api.github.com/repos/foo/bar' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { decision: string };
    expect(body.decision).toBe('allow');
  });

  it('returns 200 with { decision: "deny" } for WebFetch when allowed_domains_json is null', async () => {
    const { cwd } = seedPermissionTeam({
      permissionPolicy: 'hook',
      allowedDomainsJson: null,
    });

    const res = await postHook('PermissionRequest', {
      session_id: 'sess-perm-net-null-domains',
      cwd,
      tool_name: 'WebFetch',
      tool_input: { url: 'https://api.github.com/repos/foo/bar' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { decision: string };
    expect(body.decision).toBe('deny');
  });

  it('returns 200 with decision=ask when the cwd resolves to an unknown team', async () => {
    // Issue #755: a 404 here would block CC waiting for a synchronous
    // permission decision. `ask` falls back to CC's own native prompt —
    // exactly the experience the user would get without FC hooks
    // installed. `allow` would silently auto-approve every tool call in
    // unrelated user sessions (privilege-escalation foot-gun).
    const res = await postHook('PermissionRequest', {
      session_id: 'sess-perm-ask-no-team',
      cwd: makeCwd('nonexistent-perm-team-99998'),
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/foo' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { decision: string };
    expect(body.decision).toBe('ask');
  });
});
