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
import { getTeamManager } from '../services/team-manager.js';
import { sseBroker } from '../services/sse-broker.js';
import { DEFAULT_MESSAGE_TEMPLATES } from '../../shared/message-templates.js';
import { getIssueFetcher } from '../services/issue-fetcher.js';
import { uninstallHooks } from '../utils/hook-installer.js';
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
          githubPollIntervalMs: config.githubPollIntervalMs,
          issuePollIntervalMs: config.issuePollIntervalMs,
          stuckCheckIntervalMs: config.stuckCheckIntervalMs,
          usagePollIntervalMs: config.usagePollIntervalMs,
          sseHeartbeatMs: config.sseHeartbeatMs,
          outputBufferLines: config.outputBufferLines,
          claudeCmd: config.claudeCmd,
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
        // Require explicit confirmation to prevent accidental resets
        const body = request.body as Record<string, unknown> | null;
        if (!body || body.confirm !== 'FACTORY_RESET') {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Factory reset requires { "confirm": "FACTORY_RESET" } in body',
          });
        }

        const db = getDatabase();
        const manager = getTeamManager();

        // 1. Stop all running teams
        const activeTeams = db.getActiveTeams();
        for (const team of activeTeams) {
          try {
            await manager.stop(team.id);
          } catch {
            // Best-effort — continue stopping remaining teams
          }
        }

        // 2. Uninstall hooks from all projects before deleting them
        const projects = db.getProjects();
        for (const project of projects) {
          uninstallHooks(project.repoPath, request.log);
        }

        // 3. Delete all data and re-seed default templates
        const templatesSeeded = db.factoryReset(
          DEFAULT_MESSAGE_TEMPLATES.map((t) => ({ id: t.id, template: t.template })),
        );

        // 4. Clear in-memory caches (issue fetcher, team manager)
        //    Stop the polling timer first so it doesn't re-fetch while we clear,
        //    then wipe the cache. Do NOT restart — there are no projects left.
        const issueFetcher = getIssueFetcher();
        issueFetcher.stop();
        issueFetcher.clearAll();

        // 5. Broadcast empty state to all SSE clients
        sseBroker.broadcast('snapshot', { teams: [] });

        request.log.info('Factory reset completed — all data cleared');

        return reply.code(200).send({
          status: 'ok',
          message: 'Factory reset complete. All projects, teams, and data have been cleared.',
          templatesSeeded,
        });
      } catch (err: unknown) {
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
