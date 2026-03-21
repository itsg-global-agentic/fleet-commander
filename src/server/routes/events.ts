import type { FastifyInstance, FastifyPluginCallback, FastifyRequest, FastifyReply } from 'fastify';
import { processEvent, EventCollectorError } from '../services/event-collector.js';
import type { EventPayload, EventCollectorDb, SseBroker, TeamMessageSender } from '../services/event-collector.js';
import { getDatabase } from '../db.js';
import { sseBroker } from '../services/sse-broker.js';
import { getTeamManager } from '../services/team-manager.js';
import { getEventService } from '../services/event-service.js';
import { ServiceError } from '../services/service-error.js';

interface EventQuerystring {
  team_id?: string;
  type?: string;
  since?: string;
  limit?: string;
}

// ---------------------------------------------------------------------------
// Payload builders — new cc_stdin format vs legacy field-by-field
// ---------------------------------------------------------------------------

/** Helper to safely extract a string from an unknown value */
function str(val: unknown): string | undefined {
  if (val === undefined || val === null || val === '') return undefined;
  return String(val);
}

/**
 * New format: shell sends event, team, timestamp, and raw cc_stdin.
 * Server parses cc_stdin with JSON.parse() and extracts all CC fields.
 */
function buildPayloadFromCcStdin(body: Record<string, unknown>): EventPayload {
  const payload: EventPayload = {
    event: String(body.event),
    team: String(body.team),
    timestamp: str(body.timestamp),
    cc_stdin: String(body.cc_stdin),
  };

  // Parse raw CC stdin JSON
  let cc: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(String(body.cc_stdin));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      cc = parsed as Record<string, unknown>;
    }
  } catch {
    // If cc_stdin is not valid JSON, store it as-is but extract nothing
    return payload;
  }

  // Extract known CC fields
  payload.session_id = str(cc.session_id);
  payload.tool_name = str(cc.tool_name);
  payload.agent_type = str(cc.agent_type);
  payload.teammate_name = str(cc.teammate_name);
  payload.message = str(cc.message);
  payload.error = str(cc.error);
  payload.tool_use_id = str(cc.tool_use_id);
  payload.error_details = str(cc.error_details);
  payload.last_assistant_message = str(cc.last_assistant_message);

  // tool_input: CC sends this as an object; stringify it for storage
  if (cc.tool_input !== undefined && cc.tool_input !== null) {
    payload.tool_input = typeof cc.tool_input === 'string'
      ? cc.tool_input
      : JSON.stringify(cc.tool_input);
  }

  // Extract SendMessage routing fields from parsed tool_input
  if (payload.tool_name === 'SendMessage' && cc.tool_input && typeof cc.tool_input === 'object') {
    const toolInput = cc.tool_input as Record<string, unknown>;
    payload.msg_to = str(toolInput.to);
    payload.msg_summary = str(toolInput.summary);
  }

  // New fields that CC provides but were previously dropped by shell regex
  payload.model = str(cc.model);
  payload.source = str(cc.source);
  payload.notification_type = str(cc.notification_type);
  payload.agent_id = str(cc.agent_id);
  payload.cwd = str(cc.cwd);

  return payload;
}

/**
 * Legacy format: shell extracts fields individually and sends them as top-level
 * body fields. Maintains backward compatibility with old hook installations.
 */
function buildPayloadFromLegacy(body: Record<string, unknown>): EventPayload {
  return {
    event: String(body.event),
    team: String(body.team),
    timestamp: str(body.timestamp),
    session_id: str(body.session_id),
    tool_name: str(body.tool_name),
    agent_type: str(body.agent_type),
    teammate_name: str(body.teammate_name),
    message: str(body.message),
    error: str(body.error),
    tool_use_id: str(body.tool_use_id),
    tool_input: str(body.tool_input),
    error_details: str(body.error_details),
    last_assistant_message: str(body.last_assistant_message),
    worktree_root: str(body.worktree_root),
    msg_to: str(body.msg_to),
    msg_summary: str(body.msg_summary),
  };
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

        // Build EventPayload — detect new format (cc_stdin) vs legacy field-by-field
        const payload: EventPayload = body.cc_stdin
          ? buildPayloadFromCcStdin(body)
          : buildPayloadFromLegacy(body);

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
        const service = getEventService();
        const events = service.queryEvents({
          teamId: query.team_id ? parseInt(query.team_id, 10) : undefined,
          eventType: query.type || undefined,
          since: query.since || undefined,
          limit: query.limit ? parseInt(query.limit, 10) : undefined,
        });
        return reply.code(200).send(events);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Unexpected error querying events');
        return reply.code(500).send({ error: 'Internal Server Error', message: 'Failed to query events' });
      }
    }
  );

  done();
};

export default eventsRoutes;

// Exported for testing
export { buildPayloadFromCcStdin, buildPayloadFromLegacy };
