// =============================================================================
// Fleet Commander — System Routes (diagnostics + status)
// =============================================================================
// Fastify plugin that registers system-level endpoints:
// stuck diagnostics, blocked teams, fleet health summary, server status.
// Diagnostics logic is delegated to DiagnosticsService.
// =============================================================================

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import fs from 'fs';
import path from 'path';
import { getDatabase } from '../db.js';
import { sseBroker } from '../services/sse-broker.js';
import { getDiagnosticsService } from '../services/diagnostics-service.js';
import { ServiceError } from '../services/service-error.js';
import config from '../config.js';
import { resolveClaudePath } from '../utils/resolve-claude-path.js';

// ---------------------------------------------------------------------------
// Server start time (captured at module load)
// ---------------------------------------------------------------------------

const SERVER_START_TIME = Date.now();

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const systemRoutes: FastifyPluginCallback = (
  fastify: FastifyInstance,
  _opts: Record<string, unknown>,
  done: (err?: Error) => void,
) => {
  // -------------------------------------------------------------------------
  // GET /api/diagnostics/stuck — teams that are idle or stuck
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/diagnostics/stuck',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const db = getDatabase();
        const candidates = db.getStuckCandidates(
          config.idleThresholdMin,
          config.stuckThresholdMin,
        );

        return reply.code(200).send({
          idleThresholdMin: config.idleThresholdMin,
          stuckThresholdMin: config.stuckThresholdMin,
          count: candidates.length,
          teams: candidates,
        });
      } catch (err: unknown) {
        _request.log.error(err, 'Failed to get stuck diagnostics');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/diagnostics/blocked — teams blocked by CI failures
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/diagnostics/blocked',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const service = getDiagnosticsService();
        const result = service.getBlockedTeams();
        return reply.code(200).send(result);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        _request.log.error(err, 'Failed to get blocked diagnostics');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/diagnostics/health — fleet health summary (counts by status)
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/diagnostics/health',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const service = getDiagnosticsService();
        const summary = service.getHealthSummary();
        return reply.code(200).send(summary);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        _request.log.error(err, 'Failed to get fleet health');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/status — server info (uptime, active teams, SSE, db size)
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/status',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const db = getDatabase();
        const activeTeams = db.getActiveTeams();
        const uptimeMs = Date.now() - SERVER_START_TIME;
        const uptimeSec = Math.floor(uptimeMs / 1000);

        return reply.code(200).send({
          status: 'ok',
          uptime: {
            seconds: uptimeSec,
            formatted: formatUptime(uptimeSec),
          },
          activeTeams: activeTeams.length,
          sseConnections: sseBroker.getClientCount(),
          dbSizeBytes: db.getDbFileSize(),
          serverStartedAt: new Date(SERVER_START_TIME).toISOString(),
          version: getPackageVersion(),
        });
      } catch (err: unknown) {
        _request.log.error(err, 'Failed to get server status');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/debug/teams — raw database state for debugging
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/debug/teams',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const db = getDatabase();
        const allTeams = db.getTeams();
        const dashboard = db.getTeamDashboard();
        const activeTeams = db.getActiveTeams();

        return reply.code(200).send({
          rawTeams: allTeams,
          dashboardTeams: dashboard,
          activeTeams,
          teamCount: allTeams.length,
          dashboardCount: dashboard.length,
          activeCount: activeTeams.length,
        });
      } catch (err: unknown) {
        _request.log.error(err, 'Failed to get debug teams');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/system/browse-dirs — list subdirectories for path picker
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/system/browse-dirs',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { path: dirPath } = request.query as { path?: string };
        const targetPath = dirPath ||
          (process.platform === 'win32' ? 'C:/Git' : (process.env['HOME'] || '/home') + '/projects');

        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(targetPath, { withFileTypes: true });
        } catch {
          return reply.code(200).send({ parentPath: targetPath.replace(/\\/g, '/'), dirs: [] });
        }

        const dirs = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => {
            const fullPath = path.join(targetPath, e.name).replace(/\\/g, '/');
            let isGitRepo = false;
            try {
              isGitRepo = fs.existsSync(path.join(fullPath, '.git'));
            } catch {
              // ignore permission errors
            }
            return { name: e.name, path: fullPath, isGitRepo };
          })
          .sort((a, b) =>
            (b.isGitRepo ? 1 : 0) - (a.isGitRepo ? 1 : 0) || a.name.localeCompare(b.name),
          );

        return reply.code(200).send({
          parentPath: targetPath.replace(/\\/g, '/'),
          dirs,
        });
      } catch (err: unknown) {
        request.log.error(err, 'Failed to browse directories');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/settings — current runtime config (read-only, non-sensitive)
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/settings',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        return reply.code(200).send({
          host: config.host,
          port: config.port,
          idleThresholdMin: config.idleThresholdMin,
          stuckThresholdMin: config.stuckThresholdMin,
          launchTimeoutMin: config.launchTimeoutMin,
          maxUniqueCiFailures: config.maxUniqueCiFailures,
          earlyCrashThresholdSec: config.earlyCrashThresholdSec,
          earlyCrashMinTools: config.earlyCrashMinTools,
          githubPollIntervalMs: config.githubPollIntervalMs,
          issuePollIntervalMs: config.issuePollIntervalMs,
          stuckCheckIntervalMs: config.stuckCheckIntervalMs,
          usagePollIntervalMs: config.usagePollIntervalMs,
          sseHeartbeatMs: config.sseHeartbeatMs,
          outputBufferLines: config.outputBufferLines,
          claudeCmd: config.claudeCmd,
          resolvedClaudeCmd: resolveClaudePath(),
          enableAgentTeams: config.enableAgentTeams,
          fleetCommanderRoot: config.fleetCommanderRoot,
          dbPath: config.dbPath,
        });
      } catch (err: unknown) {
        _request.log.error(err, 'Failed to get settings');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/system/factory-reset — wipe all data and re-seed defaults
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/system/factory-reset',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = request.body as Record<string, unknown> | null;
        const confirm = (body?.confirm as string) ?? '';

        const service = getDiagnosticsService();
        const result = await service.factoryReset(confirm);

        request.log.info('Factory reset completed — all data cleared');
        return reply.code(200).send(result);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Factory reset failed');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  done();
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read version from package.json (cached after first call) */
let _cachedVersion: string | null = null;
function getPackageVersion(): string {
  if (_cachedVersion) return _cachedVersion;
  try {
    const pkgPath = path.join(config.fleetCommanderRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    _cachedVersion = pkg.version ?? '0.0.0';
  } catch {
    _cachedVersion = '0.0.0';
  }
  return _cachedVersion!;
}

function formatUptime(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join(' ');
}

export default systemRoutes;
