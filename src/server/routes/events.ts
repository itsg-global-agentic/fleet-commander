import type { FastifyInstance, FastifyPluginCallback, FastifyRequest, FastifyReply } from 'fastify';
import { processEvent, EventCollectorError } from '../services/event-collector.js';
import type { EventPayload, EventCollectorDb, SseBroker, TeamMessageSender, LastAssistantMessageSink } from '../services/event-collector.js';
import { getDatabase } from '../db.js';
import { sseBroker } from '../services/sse-broker.js';
import { getTeamManager } from '../services/team-manager.js';
import { getEventService } from '../services/event-service.js';
import { ServiceError } from '../services/service-error.js';
import { parseOptionalIdParam } from '../utils/parse-params.js';
import { buildEventPayloadFromCc } from '../utils/build-event-payload.js';

interface EventQuerystring {
  team_id?: string;
  type?: string;
  since?: string;
  limit?: string;
  offset?: string;
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
 * Server parses cc_stdin with JSON.parse() and delegates the field
 * extraction to `buildEventPayloadFromCc` (shared with the HTTP hook route).
 *
 * We preserve the raw `cc_stdin` string the shell sent (rather than
 * re-serializing the parsed object) because:
 *   - the TaskCreated handler in event-collector parses cc_stdin back into
 *     an object, which works either way;
 *   - the dedup fingerprint hashes the full payload — a stable cc_stdin
 *     string keeps fingerprints comparable across CC versions whose JSON
 *     key order may vary;
 *   - existing unit tests in event-collector.test.ts assert on the original
 *     cc_stdin string for malformed / non-object inputs.
 */
function buildPayloadFromCcStdin(body: Record<string, unknown>): EventPayload {
  const eventType = String(body.event);
  const team = String(body.team);
  const timestamp = str(body.timestamp);
  const ccStdinRaw = String(body.cc_stdin);

  let cc: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(ccStdinRaw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      cc = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed JSON — preserve the raw string in cc_stdin (so TaskCreated
    // and the dedup fingerprint still work) but skip field extraction.
    return {
      event: eventType,
      team,
      timestamp,
      cc_stdin: ccStdinRaw,
    };
  }

  // Delegate to the shared builder, then overwrite cc_stdin with the raw
  // string the shell originally sent (the builder re-serializes the parsed
  // object, which is canonical but not guaranteed bit-identical to the
  // shell's input).
  const payload = buildEventPayloadFromCc(cc, team, eventType, timestamp);
  payload.cc_stdin = ccStdinRaw;
  return payload;
}

/**
 * Legacy format: shell extracts fields individually and sends them as top-level
 * body fields. Maintains backward compatibility with old hook installations.
 */
function buildPayloadFromLegacy(body: Record<string, unknown>): EventPayload {
  // duration_ms may arrive as either a number or a stringified number depending on
  // shell parsing. Coerce defensively and only accept finite numeric values.
  let durationMs: number | undefined;
  if (body.duration_ms !== undefined && body.duration_ms !== null) {
    const n = Number(body.duration_ms);
    if (Number.isFinite(n)) {
      durationMs = n;
    }
  }

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
    worktree_path: str(body.worktree_path),
    msg_to: str(body.msg_to),
    msg_summary: str(body.msg_summary),
    owner: str(body.owner),
    duration_ms: durationMs,
    // Issue #733: future-proof legacy shell that pre-extracts effort. The
    // canonical extraction path is cc_stdin; this field exists so direct route
    // callers can also surface a runtime effort change.
    effort: str(body.effort),
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
        const result = processEvent(
          payload,
          db as unknown as EventCollectorDb,
          sseBroker as unknown as SseBroker,
          manager as unknown as TeamMessageSender,
          manager as unknown as LastAssistantMessageSink,
        );

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
        const body = request.body as Record<string, unknown> | undefined;
        request.log.error(
          { err, event: body?.event, team: body?.team },
          'Event processing failed',
        );
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to process event',
        });
      }
    }
  );

  // GET /api/events — query events with filters (paginated)
  fastify.get(
    '/api/events',
    async (
      request: FastifyRequest<{ Querystring: EventQuerystring }>,
      reply: FastifyReply
    ) => {
      try {
        const query = request.query;

        const rawOffset = query.offset ? parseInt(query.offset, 10) : undefined;
        if (rawOffset !== undefined && (isNaN(rawOffset) || rawOffset < 0)) {
          return reply.code(400).send({ error: 'Bad Request', message: 'offset must be a non-negative integer' });
        }

        const rawLimit = query.limit ? parseInt(query.limit, 10) : undefined;
        if (rawLimit !== undefined && (isNaN(rawLimit) || rawLimit < 1)) {
          return reply.code(400).send({ error: 'Bad Request', message: 'limit must be a positive integer' });
        }
        const limit = rawLimit !== undefined ? Math.min(rawLimit, 1000) : undefined;

        const service = getEventService();
        const result = service.queryEvents({
          teamId: parseOptionalIdParam(query.team_id, 'team_id'),
          eventType: query.type || undefined,
          since: query.since || undefined,
          limit,
          offset: rawOffset,
        });
        return reply.code(200).send(result);
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
