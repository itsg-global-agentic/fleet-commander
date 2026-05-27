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
//   - 200 OK with `{ decision: "ask" | "allow" | "deny" }` for PermissionRequest
//   - 400 Bad Request for unknown event types, missing cwd, malformed JSON
//   - 500 Internal Server Error on unexpected exceptions (logged server-side)
//
// When the cwd does not resolve to a registered team (e.g. user runs CC
// interactively in the main checkout, or CC fires WorktreeCreate before the
// worktree exists), the route still returns success: 204 for fire-and-forget
// hooks, 200 `{decision:"ask"}` for PermissionRequest. This matches the
// silent-swallow behavior of the legacy bash hooks; otherwise synchronous
// hooks (WorktreeCreate, PermissionRequest) would block CC entirely (issue
// #755).
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
import { evaluatePermission } from '../services/permission-policy.js';

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
  // CC 2.1.45+ — synchronous permission gate; FC responds with allow/deny/ask.
  // Only wired via http hooks (bash hooks cannot handle synchronous responses).
  // issue #736.
  PermissionRequest: 'permission_request',
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

        // Look up the team. When no team matches the cwd we still respond
        // successfully — see header comment. The bash hook path silently
        // swallows the same case; HTTP hooks would surface a 404 as a
        // visible CC error, and synchronous hooks (WorktreeCreate,
        // PermissionRequest) would block the entire CC turn (issue #755).
        const db = getDatabase();
        const teamRow = db.getTeamByWorktree(team);
        const snakeEvent = PASCAL_TO_SNAKE[eventType];

        if (!teamRow) {
          if (snakeEvent === 'permission_request') {
            // Safe fallback — CC shows its own prompt.
            return reply
              .code(200)
              .header('content-type', 'application/json')
              .send({ decision: 'ask' });
          }
          // Fire-and-forget and synchronous WorktreeCreate / WorktreeRemove:
          // CC only needs a 2xx. Empty 204 is enough.
          request.log.debug(
            { eventType, worktree: team },
            'HTTP hook: no team for cwd — silently accepting',
          );
          return reply.code(204).send();
        }

        // ── PermissionRequest: synchronous gate (CC blocks waiting for a response) ──
        //
        // Unlike all other hooks (fire-and-forget, 204), CC blocks its tool execution
        // until it receives a JSON response body with a `decision` field. We must
        // return HTTP 200 with Content-Type application/json.
        //
        // The safe fallback is 'ask' — CC will show its own interactive prompt. We
        // return 'ask' when the project is not configured for hook-based policy so
        // existing projects are unaffected.
        if (snakeEvent === 'permission_request') {
          // Resolve project to check permission_policy.
          const project = teamRow.projectId ? db.getProject(teamRow.projectId) : null;

          if (!project || project.permissionPolicy !== 'hook') {
            // Project not configured for hook-based policy — return safe fallback.
            return reply
              .code(200)
              .header('content-type', 'application/json')
              .send({ decision: 'ask' });
          }

          // Extract tool context from the CC hook payload.
          // CC 2.1.45+ PermissionRequest body: { tool_name, tool_input, cwd, ... }
          const toolName = (body['tool_name'] as string | undefined) ?? '';
          const toolInput = (body['tool_input'] as Record<string, unknown> | undefined) ?? {};

          // Parse allowed_domains_json into string[] | null.
          let projectAllowedDomains: string[] | null = null;
          if (project.allowedDomainsJson) {
            try {
              const parsed = JSON.parse(project.allowedDomainsJson);
              if (Array.isArray(parsed)) {
                projectAllowedDomains = parsed.filter((d): d is string => typeof d === 'string');
              }
            } catch {
              // Malformed JSON — treat as no domains allowed.
            }
          }

          // Determine the worktree path for boundary checks.
          // Use the worktree's repo path (project.repoPath) as the boundary root.
          // In practice the team runs inside project.repoPath + '/.claude/worktrees/' + teamName
          // but we use the cwd from the hook body to get the exact worktree directory.
          const worktreePath = (body['cwd'] as string | undefined) ?? project.repoPath;

          const result = evaluatePermission({
            toolName,
            toolInput,
            worktreePath,
            projectAllowedDomains,
          });

          // Fire-and-forget audit event AFTER returning the response to CC.
          // setImmediate ensures the response bytes are sent before we touch the DB.
          setImmediate(() => {
            try {
              const auditPayload = buildEventPayloadFromCc(
                {
                  ...body,
                  tool_name: toolName,
                  decision: result.decision,
                  reason: result.reason,
                },
                team,
                snakeEvent,
              );
              const manager = getTeamManager();
              processEvent(
                auditPayload,
                db as unknown as EventCollectorDb,
                sseBroker as unknown as SseBroker,
                manager as unknown as TeamMessageSender,
                manager as unknown as LastAssistantMessageSink,
              );
            } catch {
              // Best-effort audit — never surface errors to CC.
            }
          });

          return reply
            .code(200)
            .header('content-type', 'application/json')
            .send({ decision: result.decision });
        }

        // ── Fire-and-forget hooks (all other event types) ──
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
