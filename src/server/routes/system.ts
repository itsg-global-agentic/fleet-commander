// =============================================================================
// Fleet Commander — System Routes (diagnostics + status)
// =============================================================================
// Fastify plugin that registers system-level endpoints:
// stuck diagnostics, blocked teams, fleet health summary, server status.
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
import config from '../config.js';

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
        const db = getDatabase();

        // Find teams whose PR has ci_status = 'failing' and ci_fail_count >= threshold
        const teams = db.getActiveTeams();
        const blockedTeams = [];

        for (const team of teams) {
          if (!team.prNumber) continue;

          const pr = db.getPullRequest(team.prNumber);
          if (!pr) continue;

          if (pr.ciStatus === 'failing' && pr.ciFailCount >= config.maxUniqueCiFailures) {
            blockedTeams.push({
              teamId: team.id,
              worktreeName: team.worktreeName,
              issueNumber: team.issueNumber,
              issueTitle: team.issueTitle,
              status: team.status,
              phase: team.phase,
              prNumber: pr.prNumber,
              ciStatus: pr.ciStatus,
              ciFailCount: pr.ciFailCount,
              maxAllowed: config.maxUniqueCiFailures,
            });
          }
        }

        return reply.code(200).send({
          maxUniqueCiFailures: config.maxUniqueCiFailures,
          count: blockedTeams.length,
          teams: blockedTeams,
        });
      } catch (err: unknown) {
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
        const db = getDatabase();
        const allTeams = db.getTeams();

        // Count teams by status
        const statusCounts: Record<string, number> = {};
        for (const team of allTeams) {
          statusCounts[team.status] = (statusCounts[team.status] ?? 0) + 1;
        }

        // Count teams by phase
        const phaseCounts: Record<string, number> = {};
        for (const team of allTeams) {
          phaseCounts[team.phase] = (phaseCounts[team.phase] ?? 0) + 1;
        }

        const activeTeams = db.getActiveTeams();
        const stuckCandidates = db.getStuckCandidates(
          config.idleThresholdMin,
          config.stuckThresholdMin,
        );

        return reply.code(200).send({
          totalTeams: allTeams.length,
          activeTeams: activeTeams.length,
          stuckOrIdle: stuckCandidates.length,
          byStatus: statusCounts,
          byPhase: phaseCounts,
        });
      } catch (err: unknown) {
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
          version: '0.1.0',
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

  done();
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
