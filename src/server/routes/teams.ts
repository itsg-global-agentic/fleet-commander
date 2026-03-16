// =============================================================================
// Fleet Commander — Team Routes (CRUD + lifecycle management)
// =============================================================================
// Fastify plugin that registers all team-related API endpoints:
// launch, stop, resume, restart, batch-launch, stop-all, list, detail, output.
// =============================================================================

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import { getTeamManager } from '../services/team-manager.js';
import { getDatabase } from '../db.js';

// ---------------------------------------------------------------------------
// Request body / param interfaces
// ---------------------------------------------------------------------------

interface LaunchBody {
  issueNumber: number;
  issueTitle?: string;
  prompt?: string;
}

interface LaunchBatchBody {
  issues: Array<{ number: number; title?: string }>;
  prompt?: string;
  delayMs?: number;
}

interface RestartBody {
  prompt?: string;
}

interface TeamIdParams {
  id: string;
}

interface OutputQuerystring {
  lines?: string;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const teamsRoutes: FastifyPluginCallback = (
  fastify: FastifyInstance,
  _opts: Record<string, unknown>,
  done: (err?: Error) => void,
) => {
  // -------------------------------------------------------------------------
  // POST /api/teams/launch — launch a new team
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/teams/launch',
    async (
      request: FastifyRequest<{ Body: LaunchBody }>,
      reply: FastifyReply,
    ) => {
      try {
        const { issueNumber, issueTitle, prompt } = request.body;

        if (!issueNumber || typeof issueNumber !== 'number' || issueNumber < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'issueNumber is required and must be a positive integer',
          });
        }

        const manager = getTeamManager();
        const team = await manager.launch(issueNumber, issueTitle, prompt);
        return reply.code(201).send(team);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        if (message.includes('already active')) {
          return reply.code(409).send({ error: 'Conflict', message });
        }

        request.log.error(err, 'Failed to launch team');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/teams/launch-batch — launch multiple teams
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/teams/launch-batch',
    async (
      request: FastifyRequest<{ Body: LaunchBatchBody }>,
      reply: FastifyReply,
    ) => {
      try {
        const { issues, prompt, delayMs } = request.body;

        if (!issues || !Array.isArray(issues) || issues.length === 0) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'issues array is required and must not be empty',
          });
        }

        // Validate each issue entry
        for (const issue of issues) {
          if (!issue.number || typeof issue.number !== 'number' || issue.number < 1) {
            return reply.code(400).send({
              error: 'Bad Request',
              message: `Invalid issue number: ${JSON.stringify(issue)}`,
            });
          }
        }

        const manager = getTeamManager();
        const teams = await manager.launchBatch(issues, prompt, delayMs);
        return reply.code(201).send(teams);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        request.log.error(err, 'Failed to launch batch');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/teams/stop-all — stop all active teams
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/teams/stop-all',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const manager = getTeamManager();
        const teams = await manager.stopAll();
        return reply.code(200).send(teams);
      } catch (err: unknown) {
        request.log.error(err, 'Failed to stop all teams');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/teams/:id/stop — stop a team
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/teams/:id/stop',
    async (
      request: FastifyRequest<{ Params: TeamIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        if (isNaN(teamId) || teamId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid team ID',
          });
        }

        const manager = getTeamManager();
        const team = await manager.stop(teamId);
        return reply.code(200).send(team);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        if (message.includes('not found')) {
          return reply.code(404).send({ error: 'Not Found', message });
        }

        request.log.error(err, 'Failed to stop team');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/teams/:id/resume — resume a stopped team
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/teams/:id/resume',
    async (
      request: FastifyRequest<{ Params: TeamIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        if (isNaN(teamId) || teamId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid team ID',
          });
        }

        const manager = getTeamManager();
        const team = await manager.resume(teamId);
        return reply.code(200).send(team);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        if (message.includes('not found')) {
          return reply.code(404).send({ error: 'Not Found', message });
        }
        if (message.includes('no longer exists')) {
          return reply.code(410).send({ error: 'Gone', message });
        }

        request.log.error(err, 'Failed to resume team');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/teams/:id/restart — restart a team
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/teams/:id/restart',
    async (
      request: FastifyRequest<{ Params: TeamIdParams; Body: RestartBody }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        if (isNaN(teamId) || teamId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid team ID',
          });
        }

        const { prompt } = request.body || {};
        const manager = getTeamManager();
        const team = await manager.restart(teamId, prompt);
        return reply.code(200).send(team);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        if (message.includes('not found')) {
          return reply.code(404).send({ error: 'Not Found', message });
        }

        request.log.error(err, 'Failed to restart team');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams — list all teams with dashboard data
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const db = getDatabase();
        const dashboard = db.getTeamDashboard();
        return reply.code(200).send(dashboard);
      } catch (err: unknown) {
        _request.log.error(err, 'Failed to list teams');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams/:id — full team detail
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams/:id',
    async (
      request: FastifyRequest<{ Params: TeamIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        if (isNaN(teamId) || teamId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid team ID',
          });
        }

        const db = getDatabase();
        const team = db.getTeam(teamId);
        if (!team) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Team ${teamId} not found`,
          });
        }

        return reply.code(200).send(team);
      } catch (err: unknown) {
        request.log.error(err, 'Failed to get team');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams/:id/status — compact status (MCP-compatible)
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams/:id/status',
    async (
      request: FastifyRequest<{ Params: TeamIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        if (isNaN(teamId) || teamId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid team ID',
          });
        }

        const db = getDatabase();
        const team = db.getTeam(teamId);
        if (!team) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Team ${teamId} not found`,
          });
        }

        // Compact MCP-compatible format
        return reply.code(200).send({
          id: team.id,
          issueNumber: team.issueNumber,
          worktreeName: team.worktreeName,
          status: team.status,
          phase: team.phase,
          pid: team.pid,
          prNumber: team.prNumber,
          lastEventAt: team.lastEventAt,
        });
      } catch (err: unknown) {
        request.log.error(err, 'Failed to get team status');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams/:id/output — rolling output buffer
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams/:id/output',
    async (
      request: FastifyRequest<{ Params: TeamIdParams; Querystring: OutputQuerystring }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        if (isNaN(teamId) || teamId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid team ID',
          });
        }

        const db = getDatabase();
        const team = db.getTeam(teamId);
        if (!team) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Team ${teamId} not found`,
          });
        }

        const linesParam = (request.query as OutputQuerystring).lines;
        const lines = linesParam ? parseInt(linesParam, 10) : undefined;

        const manager = getTeamManager();
        const output = manager.getOutput(teamId, lines);

        return reply.code(200).send({
          teamId,
          lines: output,
          count: output.length,
        });
      } catch (err: unknown) {
        request.log.error(err, 'Failed to get team output');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams/:id/events — events for this team
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams/:id/events',
    async (
      request: FastifyRequest<{ Params: TeamIdParams; Querystring: { limit?: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        if (isNaN(teamId) || teamId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid team ID',
          });
        }

        const db = getDatabase();
        const team = db.getTeam(teamId);
        if (!team) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Team ${teamId} not found`,
          });
        }

        const limitParam = (request.query as { limit?: string }).limit;
        const limit = limitParam ? parseInt(limitParam, 10) : 100;

        const events = db.getEventsByTeam(teamId, limit);
        return reply.code(200).send(events);
      } catch (err: unknown) {
        request.log.error(err, 'Failed to get team events');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  done();
};

export default teamsRoutes;
