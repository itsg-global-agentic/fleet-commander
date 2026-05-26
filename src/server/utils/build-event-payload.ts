// =============================================================================
// Fleet Commander — Build EventPayload from CC stdin
// =============================================================================
// Shared helper that converts a parsed Claude Code hook stdin object into the
// canonical `EventPayload` shape consumed by the event-collector pipeline.
//
// Two routes need this conversion today:
//   1. POST /api/events (legacy shell hook path, routes/events.ts) — the shell
//      wrapper forwards `cc_stdin` as a JSON string; the route handler parses
//      it and then calls this helper.
//   2. POST /api/hooks/:eventType (HTTP hook path, routes/hooks.ts) — CC POSTs
//      its hook input directly. The route handler treats the entire body as
//      `ccBody` and calls this helper with the snake_case event type.
//
// Extracting the field-mapping logic here keeps both paths bit-identical: any
// future addition to the CC schema only needs to land in one place.
// =============================================================================

import type { EventPayload } from '../services/event-collector.js';

/** Helper to safely extract a string from an unknown value. Mirrors routes/events.ts. */
function str(val: unknown): string | undefined {
  if (val === undefined || val === null || val === '') return undefined;
  return String(val);
}

/**
 * Build an EventPayload from a parsed Claude Code hook stdin object.
 *
 * @param ccBody     - Parsed CC hook input (the JSON object CC ships on stdin).
 * @param team       - Worktree name (FC's team key). Caller is responsible
 *                     for resolving this from `ccBody.cwd` via the
 *                     `resolveTeamFromHookBody` helper before calling.
 * @param eventType  - snake_case event type (e.g. `session_start`, `tool_use`).
 *                     For the HTTP route this is derived from the URL param;
 *                     for the legacy route it is forwarded from the shell.
 * @param timestamp  - Optional ISO timestamp. When omitted the event-collector
 *                     applies its own `new Date().toISOString()` so this is
 *                     fine to leave undefined for the HTTP path.
 */
export function buildEventPayloadFromCc(
  ccBody: Record<string, unknown>,
  team: string,
  eventType: string,
  timestamp?: string,
): EventPayload {
  const payload: EventPayload = {
    event: eventType,
    team,
    timestamp,
    // Preserve the full ccBody as a JSON string. The TaskCreated handler in
    // event-collector parses `cc_stdin` for task_id/subject/description/etc.
    // and the dedup fingerprint uses the payload string, so this must stay
    // bit-identical to what the legacy shell hook would have sent.
    cc_stdin: JSON.stringify(ccBody),
  };

  payload.session_id = str(ccBody.session_id);
  payload.tool_name = str(ccBody.tool_name);
  payload.agent_type = str(ccBody.agent_type);
  payload.teammate_name = str(ccBody.teammate_name);
  payload.message = str(ccBody.message);
  payload.error = str(ccBody.error);
  payload.tool_use_id = str(ccBody.tool_use_id);
  payload.error_details = str(ccBody.error_details);
  payload.last_assistant_message = str(ccBody.last_assistant_message);

  // duration_ms: tool execution time in milliseconds (CC 2.1.119+, PostToolUse/
  // PostToolUseFailure only). CC emits this as a real number; reject any other
  // type defensively (strings, NaN, Infinity).
  if (typeof ccBody.duration_ms === 'number' && Number.isFinite(ccBody.duration_ms)) {
    payload.duration_ms = ccBody.duration_ms;
  }

  // tool_input: CC sends this as an object; stringify it for storage. The
  // event-collector parses it back to JSON for SendMessage routing and the
  // spawn-prompt extraction, so the round-trip must be lossless.
  if (ccBody.tool_input !== undefined && ccBody.tool_input !== null) {
    payload.tool_input = typeof ccBody.tool_input === 'string'
      ? ccBody.tool_input
      : JSON.stringify(ccBody.tool_input);
  }

  // Extract SendMessage routing fields from the parsed tool_input. This is
  // the contract that lets event-collector populate agent_messages rows.
  if (payload.tool_name === 'SendMessage' && ccBody.tool_input && typeof ccBody.tool_input === 'object') {
    const toolInput = ccBody.tool_input as Record<string, unknown>;
    payload.msg_to = str(toolInput.to);
    payload.msg_summary = str(toolInput.summary);
  }

  // Worktree-aware fields (some CC versions populate these).
  payload.worktree_root = str(ccBody.worktree_root);
  payload.worktree_path = str(ccBody.worktree_path);

  // Additional fields CC provides but the legacy shell regex used to drop.
  payload.model = str(ccBody.model);
  payload.source = str(ccBody.source);
  payload.notification_type = str(ccBody.notification_type);
  payload.agent_id = str(ccBody.agent_id);
  payload.owner = str(ccBody.owner);
  payload.cwd = str(ccBody.cwd);

  // Issue #733: CC 2.1.133+ adds effort.level to hook stdin. Extract the
  // nested string into a flat payload.effort field so EventCollector can
  // diff against the stored team value without re-parsing JSON. Defensive
  // shape check: cc.effort must be an object with a string `level` — any
  // other shape (string, array, number) is dropped.
  if (ccBody.effort && typeof ccBody.effort === 'object' && !Array.isArray(ccBody.effort)) {
    const eff = ccBody.effort as Record<string, unknown>;
    if (typeof eff.level === 'string') {
      payload.effort = eff.level;
    }
  }

  // CC 2.1.145+ Stop / SubagentStop hook input ships arrays of pending
  // background tasks and session crons. Stringify them so they fit the
  // EventPayload string-only schema (see issue #730). The legacy shell
  // path could not transmit these without cc_stdin; the HTTP path always
  // can.
  if (Array.isArray(ccBody.background_tasks)) {
    payload.background_tasks = JSON.stringify(ccBody.background_tasks);
  }
  if (Array.isArray(ccBody.session_crons)) {
    payload.session_crons = JSON.stringify(ccBody.session_crons);
  }

  return payload;
}
