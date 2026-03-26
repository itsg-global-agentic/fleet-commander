// =============================================================================
// Fleet Commander — Team Routes (CRUD + lifecycle + intervention)
// =============================================================================
// Fastify plugin that registers all team-related API endpoints:
// launch, stop, resume, restart, batch-launch, stop-all, list, detail, output,
// export, send-message, set-phase, acknowledge.
// Business logic is delegated to TeamService.
// =============================================================================

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import { getTeamService } from '../services/team-service.js';
import { ServiceError } from '../services/service-error.js';
import type { TeamPhase } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Request body / param interfaces
// ---------------------------------------------------------------------------

interface LaunchBody {
  projectId: number;
  issueNumber: number;
  issueTitle?: string;
  prompt?: string;
  headless?: boolean;
  force?: boolean;
  queue?: boolean;
}

interface LaunchBatchBody {
  projectId: number;
  issues: Array<{ number: number; title?: string }>;
  prompt?: string;
  delayMs?: number;
  headless?: boolean;
}

interface RestartBody {
  prompt?: string;
}

interface TeamIdParams {
  id: string;
}

interface PaginationQuerystring {
  limit?: string;
  offset?: string;
}

interface OutputQuerystring {
  lines?: string;
}

interface ExportQuerystring {
  format?: string;
}

interface TimelineQuerystring {
  limit?: string;
}

interface SendMessageBody {
  message: string;
}

interface SetPhaseBody {
  phase: TeamPhase;
  reason?: string;
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
        const service = getTeamService();
        const team = await service.launchTeam(request.body);
        return reply.code(201).send(team);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          if (err.code === 'PROJECT_NOT_READY') {
            return reply.code(400).send({
              error: 'Project Not Ready',
              message: err.message,
              hint: 'Fix the project on the Projects page before launching.',
            });
          }
          if (err.code === 'BLOCKED_BY_DEPENDENCIES') {
            return reply.code(409).send({
              error: 'Blocked by Dependencies',
              message: err.message,
              hint: 'Set force: true to bypass dependency check, or queue: true to queue until blockers resolve',
            });
          }
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }

        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('already active') || message.includes('already completed')) {
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
        const service = getTeamService();
        const result = await service.launchBatch(request.body);
        return reply.code(201).send(result);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          if (err.code === 'PROJECT_NOT_READY') {
            return reply.code(400).send({
              error: 'Project Not Ready',
              message: err.message,
              hint: 'Fix the project on the Projects page before launching.',
            });
          }
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
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
        const service = getTeamService();
        const teams = await service.stopAll();
        return reply.code(200).send(teams);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
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
        const service = getTeamService();
        const team = await service.stopTeam(teamId);
        return reply.code(200).send(team);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }

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
  // POST /api/teams/:id/force-launch — force-launch a queued team
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/teams/:id/force-launch',
    async (
      request: FastifyRequest<{ Params: TeamIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        const service = getTeamService();
        const team = await service.forceLaunch(teamId);
        return reply.code(200).send(team);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }

        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('not found')) {
          return reply.code(404).send({ error: 'Not Found', message });
        }
        if (message.includes('not queued')) {
          return reply.code(409).send({ error: 'Conflict', message });
        }

        request.log.error(err, 'Failed to force-launch team');
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
        const service = getTeamService();
        const team = await service.resumeTeam(teamId);
        return reply.code(200).send(team);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }

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
        const { prompt } = request.body || {};
        const service = getTeamService();
        const team = await service.restartTeam(teamId, prompt);
        return reply.code(200).send(team);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }

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
  // GET /api/teams — list all teams with dashboard data (paginated)
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams',
    async (
      request: FastifyRequest<{ Querystring: PaginationQuerystring }>,
      reply: FastifyReply,
    ) => {
      try {
        const query = request.query as PaginationQuerystring;
        const rawLimit = query.limit ? parseInt(query.limit, 10) : undefined;
        const rawOffset = query.offset ? parseInt(query.offset, 10) : undefined;

        if (rawLimit !== undefined && (isNaN(rawLimit) || rawLimit < 1)) {
          return reply.code(400).send({ error: 'Bad Request', message: 'limit must be a positive integer' });
        }
        if (rawOffset !== undefined && (isNaN(rawOffset) || rawOffset < 0)) {
          return reply.code(400).send({ error: 'Bad Request', message: 'offset must be a non-negative integer' });
        }

        const limit = rawLimit !== undefined ? Math.min(rawLimit, 1000) : 100;
        const offset = rawOffset ?? 0;

        const service = getTeamService();
        const result = service.listTeams({ limit, offset });
        return reply.code(200).send(result);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to list teams');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams/:id — full team detail (assembles TeamDetail shape)
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

        const service = getTeamService();
        const detail = service.getTeamDetail(teamId);
        return reply.code(200).send(detail);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
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
        const service = getTeamService();
        const status = service.getTeamStatus(request.params.id);
        return reply.code(200).send(status);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
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
        const linesParam = (request.query as OutputQuerystring).lines;
        const lines = linesParam ? parseInt(linesParam, 10) : undefined;

        if (lines !== undefined && (isNaN(lines) || lines < 1)) {
          return reply.code(400).send({ error: 'Bad Request', message: 'lines must be a positive integer' });
        }
        const clampedLines = lines !== undefined ? Math.min(lines, 1000) : undefined;

        const service = getTeamService();
        const result = service.getOutput(teamId, clampedLines);
        return reply.code(200).send(result);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to get team output');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams/:id/stream-events — parsed NDJSON stream events from Claude Code
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams/:id/stream-events',
    async (
      request: FastifyRequest<{ Params: TeamIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        const service = getTeamService();
        const events = service.getStreamEvents(teamId);
        return reply.code(200).send(events);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to get team stream events');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams/:id/timeline — unified timeline (merged stream + hook events)
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams/:id/timeline',
    async (
      request: FastifyRequest<{ Params: TeamIdParams; Querystring: TimelineQuerystring }>,
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

        const limitParam = (request.query as TimelineQuerystring).limit;
        const rawLimit = limitParam ? parseInt(limitParam, 10) : undefined;
        if (rawLimit !== undefined && (isNaN(rawLimit) || rawLimit < 1)) {
          return reply.code(400).send({ error: 'Bad Request', message: 'limit must be a positive integer' });
        }
        const limit = rawLimit !== undefined ? Math.min(rawLimit, 5000) : 500;

        const service = getTeamService();
        const timeline = service.getTeamTimeline(teamId, limit);
        return reply.code(200).send(timeline);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to get team timeline');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams/:id/export — download team logs as file
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams/:id/export',
    async (
      request: FastifyRequest<{ Params: TeamIdParams; Querystring: ExportQuerystring }>,
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

        const format = (request.query as ExportQuerystring).format ?? 'json';
        const service = getTeamService();
        const result = service.exportTeam(teamId, format);

        reply.header('Content-Type', result.contentType);
        reply.header('Content-Disposition', `attachment; filename="${result.filename}"`);
        return result.data;
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to export team logs');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams/:id/events — events for this team (paginated)
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams/:id/events',
    async (
      request: FastifyRequest<{ Params: TeamIdParams; Querystring: PaginationQuerystring }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        const query = request.query as PaginationQuerystring;
        const rawLimit = query.limit ? parseInt(query.limit, 10) : undefined;
        const rawOffset = query.offset ? parseInt(query.offset, 10) : undefined;

        if (rawLimit !== undefined && (isNaN(rawLimit) || rawLimit < 1)) {
          return reply.code(400).send({ error: 'Bad Request', message: 'limit must be a positive integer' });
        }
        if (rawOffset !== undefined && (isNaN(rawOffset) || rawOffset < 0)) {
          return reply.code(400).send({ error: 'Bad Request', message: 'offset must be a non-negative integer' });
        }

        const limit = rawLimit !== undefined ? Math.min(rawLimit, 1000) : 500;
        const offset = rawOffset ?? 0;

        const service = getTeamService();
        const result = service.getEvents(teamId, limit, offset);
        return reply.code(200).send(result);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to get team events');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/teams/:id/send-message — send a PM message to a team
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/teams/:id/send-message',
    async (
      request: FastifyRequest<{ Params: TeamIdParams; Body: SendMessageBody }>,
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

        const { message } = request.body || {};
        const service = getTeamService();
        const { command, delivered } = service.sendMessage(teamId, message);

        if (!delivered) {
          return reply.code(422).send({
            ...command as object,
            error: 'Unprocessable Entity',
            message: 'Team is not running \u2014 message not delivered',
          });
        }

        return reply.code(201).send({
          ...command as object,
          status: 'delivered' as const,
          deliveredAt: new Date().toISOString(),
        });
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to send message to team');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/teams/:id/set-phase — manually set team phase
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/teams/:id/set-phase',
    async (
      request: FastifyRequest<{ Params: TeamIdParams; Body: SetPhaseBody }>,
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

        const { phase, reason } = request.body || {};
        const service = getTeamService();
        const updated = service.setPhase(teamId, phase, reason);
        return reply.code(200).send(updated);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to set team phase');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams/:id/roster — team member roster derived from events
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams/:id/roster',
    async (
      request: FastifyRequest<{ Params: TeamIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        const service = getTeamService();
        const roster = service.getRoster(teamId);
        return reply.code(200).send(roster);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to get team roster');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams/:id/transitions — state transition history
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams/:id/transitions',
    async (
      request: FastifyRequest<{ Params: TeamIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        const service = getTeamService();
        const transitions = service.getTransitions(teamId);
        return reply.code(200).send(transitions);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to get team transitions');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/teams/:id/acknowledge — clear stuck/failed alert
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/teams/:id/acknowledge',
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

        const service = getTeamService();
        const updated = service.acknowledgeAlert(teamId);
        return reply.code(200).send(updated);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to acknowledge team alert');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams/:id/tasks — task list for this team
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams/:id/tasks',
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

        const service = getTeamService();
        const tasks = service.getTasks(teamId);
        return reply.code(200).send(tasks);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to get team tasks');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams/:id/messages — agent messages for this team
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams/:id/messages',
    async (
      request: FastifyRequest<{ Params: TeamIdParams; Querystring: { limit?: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        const limitParam = (request.query as { limit?: string }).limit;
        const rawLimit = limitParam ? parseInt(limitParam, 10) : undefined;
        if (rawLimit !== undefined && (isNaN(rawLimit) || rawLimit < 1)) {
          return reply.code(400).send({ error: 'Bad Request', message: 'limit must be a positive integer' });
        }
        const limit = rawLimit !== undefined ? Math.min(rawLimit, 1000) : undefined;

        const service = getTeamService();
        const messages = service.getMessages(teamId, limit);
        return reply.code(200).send(messages);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to get agent messages');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams/:id/messages/summary — aggregated message counts
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams/:id/messages/summary',
    async (
      request: FastifyRequest<{ Params: TeamIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        const service = getTeamService();
        const summary = service.getMessageSummary(teamId);
        return reply.code(200).send(summary);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to get agent message summary');
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
