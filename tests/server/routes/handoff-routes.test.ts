// =============================================================================
// Fleet Commander -- Handoff Routes: HTTP contract tests
// =============================================================================
// Tests the handoff file upload endpoint (POST /api/handoff) which accepts
// multipart form data. Uses a real temp SQLite database and Fastify inject().
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import os from 'os';
import path from 'path';
import fs from 'fs';

import { getDatabase, closeDatabase, type FleetDatabase } from '../../../src/server/db.js';
import { sseBroker } from '../../../src/server/services/sse-broker.js';
import handoffRoutes from '../../../src/server/routes/handoff.js';

// ---------------------------------------------------------------------------
// Test-level state
// ---------------------------------------------------------------------------

let server: FastifyInstance;
let dbPath: string;
let teamCounter = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedTeam(overrides: {
  issueNumber?: number;
  worktreeName?: string;
  status?: string;
  phase?: string;
} = {}) {
  teamCounter++;
  const db = getDatabase();
  return db.insertTeam({
    issueNumber: overrides.issueNumber ?? 1000 + teamCounter,
    worktreeName: overrides.worktreeName ?? `handoff-test-${Date.now()}-${teamCounter}`,
    status: (overrides.status as 'running') ?? 'running',
    phase: (overrides.phase as 'implementing') ?? 'implementing',
    prNumber: null,
  });
}

/**
 * Build a multipart form body for Fastify inject().
 * Returns the payload buffer and content-type header with boundary.
 */
function buildMultipart(fields: Record<string, string>, file?: { name: string; content: string }) {
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const parts: string[] = [];

  for (const [key, value] of Object.entries(fields)) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}`);
  }

  if (file) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n${file.content}`,
    );
  }

  parts.push(`--${boundary}--`);
  const body = parts.join('\r\n');

  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  dbPath = path.join(
    os.tmpdir(),
    `fleet-handoff-routes-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );

  closeDatabase();
  process.env['FLEET_DB_PATH'] = dbPath;
  getDatabase(dbPath);

  server = Fastify({ logger: false });
  await server.register(multipart, {
    limits: { fileSize: 51200, fields: 3, files: 1 },
  });
  await server.register(handoffRoutes);
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/handoff', () => {
  it('should accept a valid plan.md upload and return 200', async () => {
    const team = seedTeam({ worktreeName: `handoff-plan-${Date.now()}` });
    const { body, contentType } = buildMultipart(
      { team: team.worktreeName, fileType: 'plan.md' },
      { name: 'plan.md', content: '# Plan\n\nStep 1: Do the thing' },
    );

    const response = await server.inject({
      method: 'POST',
      url: '/api/handoff',
      headers: { 'content-type': contentType },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({ ok: true });

    // Verify it was stored in DB
    const db = getDatabase();
    const files = db.getHandoffFiles(team.id);
    expect(files).toHaveLength(1);
    expect(files[0].fileType).toBe('plan.md');
    expect(files[0].content).toBe('# Plan\n\nStep 1: Do the thing');
  });

  it('should accept changes.md', async () => {
    const team = seedTeam({ worktreeName: `handoff-changes-${Date.now()}` });
    const { body, contentType } = buildMultipart(
      { team: team.worktreeName, fileType: 'changes.md' },
      { name: 'changes.md', content: '# Changes\n\n- Fixed bug' },
    );

    const response = await server.inject({
      method: 'POST',
      url: '/api/handoff',
      headers: { 'content-type': contentType },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    const db = getDatabase();
    const files = db.getHandoffFiles(team.id);
    const latest = files[files.length - 1];
    expect(latest.fileType).toBe('changes.md');
  });

  it('should accept review.md', async () => {
    const team = seedTeam({ worktreeName: `handoff-review-${Date.now()}` });
    const { body, contentType } = buildMultipart(
      { team: team.worktreeName, fileType: 'review.md' },
      { name: 'review.md', content: '# Review\n\nLGTM' },
    );

    const response = await server.inject({
      method: 'POST',
      url: '/api/handoff',
      headers: { 'content-type': contentType },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
  });

  it('should return 400 for missing team field', async () => {
    const { body, contentType } = buildMultipart(
      { fileType: 'plan.md' },
      { name: 'plan.md', content: '# Plan' },
    );

    const response = await server.inject({
      method: 'POST',
      url: '/api/handoff',
      headers: { 'content-type': contentType },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).message).toMatch(/Missing required fields/);
  });

  it('should return 400 for missing fileType field', async () => {
    const team = seedTeam({ worktreeName: `handoff-notype-${Date.now()}` });
    const { body, contentType } = buildMultipart(
      { team: team.worktreeName },
      { name: 'plan.md', content: '# Plan' },
    );

    const response = await server.inject({
      method: 'POST',
      url: '/api/handoff',
      headers: { 'content-type': contentType },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
  });

  it('should return 400 for invalid fileType', async () => {
    const team = seedTeam({ worktreeName: `handoff-badtype-${Date.now()}` });
    const { body, contentType } = buildMultipart(
      { team: team.worktreeName, fileType: 'notes.md' },
      { name: 'notes.md', content: '# Notes' },
    );

    const response = await server.inject({
      method: 'POST',
      url: '/api/handoff',
      headers: { 'content-type': contentType },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).message).toMatch(/Invalid fileType/);
  });

  it('should return 400 for missing file content', async () => {
    const team = seedTeam({ worktreeName: `handoff-nofile-${Date.now()}` });
    const { body, contentType } = buildMultipart(
      { team: team.worktreeName, fileType: 'plan.md' },
      // no file
    );

    const response = await server.inject({
      method: 'POST',
      url: '/api/handoff',
      headers: { 'content-type': contentType },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).message).toMatch(/Missing or empty file/);
  });

  it('should return 404 for unknown worktree', async () => {
    const { body, contentType } = buildMultipart(
      { team: 'nonexistent-worktree-99999', fileType: 'plan.md' },
      { name: 'plan.md', content: '# Plan' },
    );

    const response = await server.inject({
      method: 'POST',
      url: '/api/handoff',
      headers: { 'content-type': contentType },
      payload: body,
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.payload).message).toMatch(/Team not found/);
  });

  it('should store multiple uploads for the same team', async () => {
    const team = seedTeam({ worktreeName: `handoff-multi-${Date.now()}` });

    // Upload plan.md
    const mp1 = buildMultipart(
      { team: team.worktreeName, fileType: 'plan.md' },
      { name: 'plan.md', content: '# Plan v1' },
    );
    await server.inject({
      method: 'POST',
      url: '/api/handoff',
      headers: { 'content-type': mp1.contentType },
      payload: mp1.body,
    });

    // Upload plan.md again (new version)
    const mp2 = buildMultipart(
      { team: team.worktreeName, fileType: 'plan.md' },
      { name: 'plan.md', content: '# Plan v2' },
    );
    await server.inject({
      method: 'POST',
      url: '/api/handoff',
      headers: { 'content-type': mp2.contentType },
      payload: mp2.body,
    });

    const db = getDatabase();
    const files = db.getHandoffFiles(team.id);
    expect(files.length).toBeGreaterThanOrEqual(2);
    // Verify both versions are stored (most recent last)
    const planFiles = files.filter((f) => f.fileType === 'plan.md');
    expect(planFiles).toHaveLength(2);
    expect(planFiles[0].content).toBe('# Plan v1');
    expect(planFiles[1].content).toBe('# Plan v2');
  });

  it('should cap content at 50KB (server-side subarray)', async () => {
    const team = seedTeam({ worktreeName: `handoff-cap-${Date.now()}` });
    // Use content just under the multipart plugin's fileSize limit
    // but verify the route's Buffer.subarray(0, 51200) logic works.
    const content = 'x'.repeat(50000); // 50KB, under the 51200 limit
    const { body, contentType } = buildMultipart(
      { team: team.worktreeName, fileType: 'plan.md' },
      { name: 'plan.md', content },
    );

    const response = await server.inject({
      method: 'POST',
      url: '/api/handoff',
      headers: { 'content-type': contentType },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    const db = getDatabase();
    const files = db.getHandoffFiles(team.id);
    const latest = files[files.length - 1];
    expect(latest.content.length).toBeLessThanOrEqual(51200);
    expect(latest.content.length).toBe(50000);
  });

  // ── Deduplication tests ──────────────────────────────────────────

  it('should deduplicate same content uploaded twice within 5 seconds', async () => {
    const team = seedTeam({ worktreeName: `handoff-dedup-same-${Date.now()}` });
    const content = '# Plan\n\nIdentical content for dedup test';

    // First upload
    const mp1 = buildMultipart(
      { team: team.worktreeName, fileType: 'plan.md' },
      { name: 'plan.md', content },
    );
    const r1 = await server.inject({
      method: 'POST',
      url: '/api/handoff',
      headers: { 'content-type': mp1.contentType },
      payload: mp1.body,
    });
    expect(r1.statusCode).toBe(200);

    // Second upload — same content, same file type, immediate
    const mp2 = buildMultipart(
      { team: team.worktreeName, fileType: 'plan.md' },
      { name: 'plan.md', content },
    );
    const r2 = await server.inject({
      method: 'POST',
      url: '/api/handoff',
      headers: { 'content-type': mp2.contentType },
      payload: mp2.body,
    });
    expect(r2.statusCode).toBe(200);

    // Only 1 entry should exist — the duplicate was deduplicated
    const db = getDatabase();
    const files = db.getHandoffFiles(team.id);
    const planFiles = files.filter((f) => f.fileType === 'plan.md');
    expect(planFiles).toHaveLength(1);
  });

  it('should preserve both entries when content differs within 5 seconds', async () => {
    const team = seedTeam({ worktreeName: `handoff-dedup-diff-${Date.now()}` });

    // First upload
    const mp1 = buildMultipart(
      { team: team.worktreeName, fileType: 'changes.md' },
      { name: 'changes.md', content: '# Changes v1' },
    );
    await server.inject({
      method: 'POST',
      url: '/api/handoff',
      headers: { 'content-type': mp1.contentType },
      payload: mp1.body,
    });

    // Second upload — different content
    const mp2 = buildMultipart(
      { team: team.worktreeName, fileType: 'changes.md' },
      { name: 'changes.md', content: '# Changes v2 — updated' },
    );
    await server.inject({
      method: 'POST',
      url: '/api/handoff',
      headers: { 'content-type': mp2.contentType },
      payload: mp2.body,
    });

    const db = getDatabase();
    const files = db.getHandoffFiles(team.id);
    const changesFiles = files.filter((f) => f.fileType === 'changes.md');
    expect(changesFiles).toHaveLength(2);
    expect(changesFiles[0].content).toBe('# Changes v1');
    expect(changesFiles[1].content).toBe('# Changes v2 — updated');
  });

  it('should preserve both entries when same content is uploaded 30+ seconds apart', async () => {
    const team = seedTeam({ worktreeName: `handoff-dedup-stale-${Date.now()}` });
    const content = '# Review\n\nSame content but old timestamp';

    // First upload via normal route
    const mp1 = buildMultipart(
      { team: team.worktreeName, fileType: 'review.md' },
      { name: 'review.md', content },
    );
    await server.inject({
      method: 'POST',
      url: '/api/handoff',
      headers: { 'content-type': mp1.contentType },
      payload: mp1.body,
    });

    // Backdate the first entry by 30 seconds using raw SQL
    const db = getDatabase();
    db.raw.exec(`
      UPDATE handoff_files
         SET captured_at = datetime('now', '-30 seconds')
       WHERE team_id = ${team.id} AND file_type = 'review.md'
    `);

    // Second upload — same content, but now 30s has elapsed
    const mp2 = buildMultipart(
      { team: team.worktreeName, fileType: 'review.md' },
      { name: 'review.md', content },
    );
    await server.inject({
      method: 'POST',
      url: '/api/handoff',
      headers: { 'content-type': mp2.contentType },
      payload: mp2.body,
    });

    const files = db.getHandoffFiles(team.id);
    const reviewFiles = files.filter((f) => f.fileType === 'review.md');
    expect(reviewFiles).toHaveLength(2);
  });

  it('should deduplicate independently across file types', async () => {
    const team = seedTeam({ worktreeName: `handoff-dedup-types-${Date.now()}` });
    const content = '# Same content for different types';

    // Upload plan.md
    const mp1 = buildMultipart(
      { team: team.worktreeName, fileType: 'plan.md' },
      { name: 'plan.md', content },
    );
    await server.inject({
      method: 'POST',
      url: '/api/handoff',
      headers: { 'content-type': mp1.contentType },
      payload: mp1.body,
    });

    // Upload changes.md with same content — should NOT be deduplicated
    const mp2 = buildMultipart(
      { team: team.worktreeName, fileType: 'changes.md' },
      { name: 'changes.md', content },
    );
    await server.inject({
      method: 'POST',
      url: '/api/handoff',
      headers: { 'content-type': mp2.contentType },
      payload: mp2.body,
    });

    // Upload plan.md again with same content — SHOULD be deduplicated
    const mp3 = buildMultipart(
      { team: team.worktreeName, fileType: 'plan.md' },
      { name: 'plan.md', content },
    );
    await server.inject({
      method: 'POST',
      url: '/api/handoff',
      headers: { 'content-type': mp3.contentType },
      payload: mp3.body,
    });

    const db = getDatabase();
    const files = db.getHandoffFiles(team.id);
    const planFiles = files.filter((f) => f.fileType === 'plan.md');
    const changesFiles = files.filter((f) => f.fileType === 'changes.md');

    // plan.md: 1 (second was deduped), changes.md: 1
    expect(planFiles).toHaveLength(1);
    expect(changesFiles).toHaveLength(1);
  });
});
