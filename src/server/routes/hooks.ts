// =============================================================================
// Fleet Commander — Native HTTP Hook Route
// =============================================================================
// Native HTTP hook endpoint for Claude Code 2.1.62+. When a target repo's
// .claude/settings.json uses `{ "type": "http", "url": "..." }` hook entries,
// CC POSTs each hook's stdin JSON directly to this route instead of spawning
// a bash+curl subshell.
//
// Endpoint: POST /api/hooks/:eventType
//   :eventType is the PascalCase CC hook name (SessionStart, PostToolUse, ...).
//
// Request body: the raw CC hook input object (the same JSON CC would have
// piped to a script's stdin). Common fields include session_id, cwd, tool_name,
// tool_input, message, error, etc.
//
// Response:
//   - 204 No Content on success (fire-and-forget — CC ignores the body)
//   - 400 Bad Request for unknown event types, missing cwd, malformed JSON
//   - 404 Not Found when the cwd does not resolve to a registered team
//   - 500 Internal Server Error on unexpected exceptions (logged server-side)
//
// All processing is best-effort: a route-level try/catch ensures failures
// never propagate to CC, matching the fire-and-forget contract of the legacy
// bash hooks.
// =============================================================================

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { processEvent, EventCollectorError } from '../services/event-collector.js';
import type {
  EventCollectorDb,
  LastAssistantMessageSink,
  SseBroker,
  TeamMessageSender,
} from '../services/event-collector.js';
import { getDatabase } from '../db.js';
import { sseBroker } from '../services/sse-broker.js';
import { getTeamManager } from '../services/team-manager.js';
import { buildEventPayloadFromCc } from '../utils/build-event-payload.js';
import { resolveTeamFromHookBody } from '../utils/team-resolution.js';

// ---------------------------------------------------------------------------
// Event name mapping — PascalCase (CC hook name) -> snake_case (FC event name)
// ---------------------------------------------------------------------------
// The event-collector pipeline historically uses snake_case event types
// (`session_start`, `tool_use`, ...). CC hooks fire under PascalCase names
// (`SessionStart`, `PostToolUse`, ...). The legacy shell hook performed this
// mapping in `run-hook.sh` (`bash run-hook.sh session_start ...`) before
// POSTing; the HTTP route does it here so the URL stays PascalCase and the
// event-collector contract is unchanged.
//
// Keep this map in sync with `hooks/settings.json.example` and
// `hooks/settings.json.http.example` — every hook type registered in either
// template must have an entry here.
const PASCAL_TO_SNAKE: Record<string, string> = {
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  Stop: 'stop',
  StopFailure: 'stop_failure',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Notification: 'notification',
  PreCompact: 'pre_compact',
  PostToolUse: 'tool_use',
  PostToolUseFailure: 'tool_error',
  TeammateIdle: 'teammate_idle',
  TaskCreated: 'task_created',
  // CC 2.1.49+ — fired when CC creates/removes a subworktree
  // via --worktree, EnterWorktree, or subagent isolation=worktree (issue #731).
  WorktreeCreate: 'worktree_create',
  WorktreeRemove: 'worktree_remove',
};

const VALID_EVENT_TYPES = new Set(Object.keys(PASCAL_TO_SNAKE));

// Stop-family events that should trigger queue reprocessing (so queued teams
// can launch when a slot frees up). Mirrors the same set used in
// routes/events.ts so both code paths converge.
const STOP_FAMILY = new Set(['stop', 'stop_failure', 'session_end']);

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

interface HookParams {
  eventType: string;
}

const hooksRoutes: FastifyPluginCallback = (
  fastify: FastifyInstance,
  _opts: Record<string, unknown>,
  done: (err?: Error) => void,
) => {
  fastify.post(
    '/api/hooks/:eventType',
    async (
      request: FastifyRequest<{ Params: HookParams }>,
      reply: FastifyReply,
    ) => {
      // Top-level try/catch — CC must never see a 5xx panic. On any unhandled
      // exception we log and return 500 with a generic body so the hook
      // path stays fire-and-forget from CC's perspective.
      try {
        const { eventType } = request.params;

        if (!VALID_EVENT_TYPES.has(eventType)) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: `Unknown hook event type: ${eventType}`,
          });
        }

        const body = request.body as Record<string, unknown> | undefined;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Hook body must be a JSON object',
          });
        }

        // Resolve team from cwd / transcript_path. CC always populates one of
        // these; if neither is present the hook config is broken so we reject
        // with 400 (not 404) to surface the actual problem.
        const team = resolveTeamFromHookBody(body);
        if (!team) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Hook body missing cwd / transcript_path — cannot resolve team',
          });
        }

        // Verify the team exists before processing so we can return 404
        // explicitly. processEvent would also throw TEAM_NOT_FOUND, but
        // checking upfront keeps the error path symmetric with the legacy
        // /api/events route and yields a cleaner log line.
        const db = getDatabase();
        const teamRow = db.getTeamByWorktree(team);
        if (!teamRow) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Team not found for worktree: ${team}`,
          });
        }

        const snakeEvent = PASCAL_TO_SNAKE[eventType];
        const payload = buildEventPayloadFromCc(body, team, snakeEvent);

        const manager = getTeamManager();
        try {
          processEvent(
            payload,
            db as unknown as EventCollectorDb,
            sseBroker as unknown as SseBroker,
            manager as unknown as TeamMessageSender,
            manager as unknown as LastAssistantMessageSink,
          );
        } catch (err) {
          if (err instanceof EventCollectorError) {
            const status = err.code === 'TEAM_NOT_FOUND' ? 404 : 400;
            return reply.code(status).send({
              error: status === 404 ? 'Not Found' : 'Bad Request',
              message: err.message,
            });
          }
          throw err;
        }

        // Queue reprocessing on stop-family events — mirrors routes/events.ts.
        if (STOP_FAMILY.has(snakeEvent) && teamRow.projectId) {
          manager.processQueue(teamRow.projectId).catch((qErr) => {
            request.log.error(
              qErr,
              'processQueue error after stop/session_end/stop_failure HTTP hook',
            );
          });
        }

        // Fire-and-forget — CC ignores the body so 204 is the correct minimal
        // success signal.
        return reply.code(204).send();
      } catch (err: unknown) {
        // Unexpected exception — log with as much context as we have and
        // return a generic 500. We deliberately do NOT propagate the error
        // (no Fastify default error handler) to keep CC's hook path
        // non-blocking.
        const body = request.body as Record<string, unknown> | undefined;
        request.log.error(
          { err, eventType: request.params.eventType, cwd: body?.cwd },
          'HTTP hook processing failed',
        );
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to process hook event',
        });
      }
    },
  );

  done();
};

export default hooksRoutes;

// Exported for tests so they can verify the canonical event-name map
// matches the templates and CC docs.
export { PASCAL_TO_SNAKE, VALID_EVENT_TYPES };
