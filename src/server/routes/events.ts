import type { FastifyInstance, FastifyPluginCallback, FastifyRequest, FastifyReply } from 'fastify';
import { processEvent, EventCollectorError } from '../services/event-collector.js';
import type { EventPayload, EventCollectorDb, SseBroker, TeamMessageSender } from '../services/event-collector.js';
import { getDatabase } from '../db.js';
import { sseBroker } from '../services/sse-broker.js';
import { getTeamManager } from '../services/team-manager.js';

interface EventQuerystring {
  team_id?: string;
  type?: string;
  since?: string;
  limit?: string;
}

const eventsRoutes: FastifyPluginCallback = (
  fastify: FastifyInstance,
  _opts: Record<string, unknown>,
  done: (err?: Error) => void
) => {
  // POST /api/events — receive a hook event
  fastify.post(
    '/api/events',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = request.body as Record<string, unknown>;
        if (!body || typeof body !== 'object' || !body.event || !body.team) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Missing required fields: event, team',
          });
        }

        const payload: EventPayload = {
          event: String(body.event),
          team: String(body.team),
          timestamp: body.timestamp ? String(body.timestamp) : undefined,
          session_id: body.session_id ? String(body.session_id) : undefined,
          tool_name: body.tool_name ? String(body.tool_name) : undefined,
          agent_type: body.agent_type ? String(body.agent_type) : undefined,
          teammate_name: body.teammate_name ? String(body.teammate_name) : undefined,
          message: body.message ? String(body.message) : undefined,
          error: body.error ? String(body.error) : undefined,
          tool_use_id: body.tool_use_id ? String(body.tool_use_id) : undefined,
          tool_input: body.tool_input ? String(body.tool_input) : undefined,
          stop_reason: body.stop_reason ? String(body.stop_reason) : undefined,
          error_details: body.error_details ? String(body.error_details) : undefined,
          last_assistant_message: body.last_assistant_message ? String(body.last_assistant_message) : undefined,
          worktree_root: body.worktree_root ? String(body.worktree_root) : undefined,
          msg_to: body.msg_to ? String(body.msg_to) : undefined,
          msg_summary: body.msg_summary ? String(body.msg_summary) : undefined,
        };

        const db = getDatabase();
        const manager = getTeamManager();
        const result = processEvent(payload, db as unknown as EventCollectorDb, sseBroker as unknown as SseBroker, manager as unknown as TeamMessageSender);

        // When a stop event is received, a team may be finishing —
        // trigger queue processing so queued teams can launch.
        if (payload.event === 'stop' || payload.event === 'stop_failure' || payload.event === 'session_end') {
          const team = db.getTeamByWorktree(payload.team);
          if (team?.projectId) {
            getTeamManager().processQueue(team.projectId).catch((err) => {
              request.log.error(err, 'processQueue error after stop/session_end/stop_failure event');
            });
          }
        }

        return reply.code(200).send(result);
      } catch (err: unknown) {
        if (err instanceof EventCollectorError) {
          const status = err.code === 'TEAM_NOT_FOUND' ? 404 : 400;
          return reply.code(status).send({
            error: status === 404 ? 'Not Found' : 'Bad Request',
            message: err.message,
          });
        }
        request.log.error(err, 'Unexpected error processing event');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to process event',
        });
      }
    }
  );

  // GET /api/events — query events with filters
  fastify.get(
    '/api/events',
    async (
      request: FastifyRequest<{ Querystring: EventQuerystring }>,
      reply: FastifyReply
    ) => {
      try {
        const query = request.query;
        const db = getDatabase();
        const teamId = query.team_id ? parseInt(query.team_id, 10) : undefined;
        const eventType = query.type || undefined;
        const since = query.since || undefined;
        const limit = query.limit ? parseInt(query.limit, 10) : 100;

        if (query.team_id && (isNaN(teamId!) || teamId! < 1)) {
          return reply.code(400).send({ error: 'Bad Request', message: 'Invalid team_id' });
        }
        if (query.limit && (isNaN(limit) || limit < 1)) {
          return reply.code(400).send({ error: 'Bad Request', message: 'Invalid limit' });
        }

        const events = db.getAllEvents({ teamId, eventType, since, limit });
        return reply.code(200).send(events);
      } catch (err: unknown) {
        request.log.error(err, 'Unexpected error querying events');
        return reply.code(500).send({ error: 'Internal Server Error', message: 'Failed to query events' });
      }
    }
  );

  done();
};

export default eventsRoutes;
