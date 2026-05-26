/**
 * Event Collector — Hook event ingestion service
 *
 * Receives events from Claude Code hooks (via POST /api/events),
 * stores them in SQLite, triggers state transitions, and broadcasts
 * via SSE. Includes throttling for high-volume tool_use events.
 *
 * Data flow:
 *   Claude hook -> send_event.sh -> POST /api/events -> EventCollector
 *     -> SQLite insert -> state machine evaluation -> SSE broadcast
 *
 * Throttling:
 *   tool_use events from the same team within 5 seconds are deduplicated.
 *   last_event_at is ALWAYS updated (heartbeat must work for stuck detection).
 *   Non-tool_use events are NEVER throttled.
 */

import type { TeamStatus, TeamPhase } from '../../shared/types.js';
import { TERMINAL_STATUSES } from '../../shared/types.js';
import type { SSEEventType, SSEEventPayloads } from './sse-broker.js';
import config from '../config.js';
import { recordHookTaskId, clearHookTaskIdsForTeam } from './task-dedup.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Payload received from Claude Code hooks via send_event.sh */
export interface EventPayload {
  event: string;         // e.g. "tool_use", "session_start", "session_end", "stop", etc.
  team: string;          // worktree name, e.g. "myproject-763"
  timestamp?: string;    // ISO 8601
  session_id?: string;   // Claude Code session UUID
  tool_name?: string;    // e.g. "Bash", "Read", "Edit"
  agent_type?: string;   // e.g. "coordinator", "csharp-dev"
  teammate_name?: string;
  message?: string;
  error?: string;        // PostToolUseFailure error description (CC sends "error", not "message")
  tool_use_id?: string;  // tool_use_id from PostToolUseFailure events
  tool_input?: string;   // tool input JSON from PostToolUseFailure events
  error_details?: string;       // StopFailure: reason for the failure (e.g. "rate_limit")
  last_assistant_message?: string; // StopFailure: last thing the agent said before failure
  worktree_root?: string;
  worktree_path?: string;
  msg_to?: string;
  msg_summary?: string;
  // Raw CC stdin JSON forwarded from send_event.sh (new format)
  cc_stdin?: string;
  // Additional fields extracted from cc_stdin (CC provides but were previously dropped)
  model?: string;               // e.g. "claude-sonnet-4-20250514"
  source?: string;              // e.g. "tool_use", "user"
  notification_type?: string;   // e.g. "stuck", "idle"
  agent_id?: string;            // CC agent identifier
  owner?: string;               // Task owner — set on TaskCreated hook events (CC 2.1.143+).
  cwd?: string;                 // working directory of the CC process
  // CC 2.1.145+ Stop / SubagentStop hook input. The shell hook forwards
  // these arrays as JSON strings via cc_stdin — see issue #730.
  background_tasks?: string;    // JSON-stringified array of pending background tasks
  session_crons?: string;       // JSON-stringified array of pending session crons
}

/** Result returned from processEvent */
export interface ProcessEventResult {
  event_id: number | null;
  team_id: number;
  processed: boolean;
}

/** Minimal DB abstraction (subset of methods used by EventCollector) */
export interface EventCollectorDb {
  getTeamByWorktree(worktreeName: string): { id: number; status: TeamStatus; phase: string } | undefined;
  insertEvent(event: {
    teamId: number;
    sessionId: string | null;
    agentName: string | null;
    eventType: string;
    toolName?: string | null;
    payload: string;
  }): { id: number };
  updateTeam(teamId: number, fields: Record<string, unknown>): void;
  updateTeamSilent(teamId: number, fields: Record<string, unknown>): void;
  insertTransition(data: { teamId: number; fromStatus: TeamStatus; toStatus: TeamStatus; trigger: string; reason: string }): void;
  insertAgentMessage(data: {
    teamId: number;
    eventId: number;
    sender: string;
    recipient: string;
    summary?: string | null;
    content?: string | null;
    sessionId?: string | null;
  }): { id: number };
  processEventTransaction(ops: {
    transition?: { teamId: number; fromStatus: TeamStatus; toStatus: TeamStatus; trigger: string; reason: string };
    statusUpdate?: { teamId: number; fields: Record<string, unknown> };
    heartbeatUpdate: { teamId: number; lastEventAt: string };
    eventInsert: { teamId: number; sessionId: string | null; agentName: string | null; eventType: string; toolName?: string | null; payload: string };
    agentMessages?: Array<{ teamId: number; sender: string; recipient: string; summary?: string | null; content?: string | null; sessionId?: string | null }>;
  }): { eventId: number };
  processThrottledUpdate(ops: {
    transition?: { teamId: number; fromStatus: TeamStatus; toStatus: TeamStatus; trigger: string; reason: string };
    statusUpdate?: { teamId: number; fields: Record<string, unknown> };
    heartbeatUpdate: { teamId: number; lastEventAt: string };
  }): void;
  upsertTeamTask?(data: {
    teamId: number;
    taskId: string;
    subject: string;
    description?: string | null;
    status: string;
    owner: string;
  }): { id: number; teamId: number; taskId: string; subject: string; status: string; owner: string };
  /**
   * Back-fill the spawn prompt onto the OLDEST unfilled `agent_messages` row
   * with `summary='spawned agent'` for the given team and recipient. Used
   * when `PostToolUse(Task)` carries the prompt that wasn't present on the
   * preceding `SubagentStart`. Returns true on update, false otherwise.
   */
  backfillSpawnPromptForTask?(data: {
    teamId: number;
    taskSubagentType: string | null;
    prompt: string;
  }): boolean;
}

/** SSE broker interface for broadcasting events */
export interface SseBroker {
  broadcast<T extends SSEEventType>(event: T, data: SSEEventPayloads[T], teamId?: number): void;
}

/** Optional team message sender for advisory messages (e.g., crash detection) */
export interface TeamMessageSender {
  sendMessage(teamId: number, message: string, source?: 'user' | 'fc', subtype?: string): boolean;
}

/**
 * Optional sink for capturing the team-lead's `last_assistant_message` field
 * from Stop / SubagentStop / StopFailure hook input (CC 2.1.46+). Issue #729.
 *
 * The captured value is consumed by `TeamManager.handleProcessExit` as the
 * authoritative source for the merge-claim cross-check, falling back to the
 * existing `parsedEvents` buffer extraction for older CC versions or when the
 * field is absent.
 */
export interface LastAssistantMessageSink {
  noteLastAssistantMessage(teamId: number, text: string): void;
}

// ---------------------------------------------------------------------------
// Throttle state — module-level, persists across requests
// ---------------------------------------------------------------------------

/** Track last tool_use event time per team for throttling */
const lastToolUseByTeam = new Map<string, number>();

// ---------------------------------------------------------------------------
// Event dedup state — module-level, persists across requests
// ---------------------------------------------------------------------------
// Guards against duplicate hook events landing in the events table with
// consecutive IDs and identical payloads (issue #691 part C). The dominant
// symptom was adjacent shutdown rows, but the dedup is generic: any event
// that arrives within DEDUP_WINDOW_MS with the same (team, type, agent,
// payload-fingerprint) as the previous event from that team is dropped.
//
// We store an in-memory fingerprint per (team, event_type, agent_name)
// rather than re-reading the DB, because the dual-write symptom is a
// sub-200ms burst — the cost of a read per event is higher than the cost
// of a tiny map.

/** Window in which consecutive identical events are treated as duplicates. */
const DEDUP_WINDOW_MS = 200;

/**
 * Event types subject to dedup. Scoped narrowly to the observed dual-write
 * symptom (shutdown paths) to avoid penalizing legitimate event bursts.
 */
const DEDUP_EVENT_TYPES = new Set<string>([
  'stop',
  'stop_failure',
  'session_end',
  'subagent_stop',
]);

/**
 * Hook event types that may carry `last_assistant_message` from CC 2.1.46+
 * stdin. The team-lead's exit chatter on any of these is the authoritative
 * source for the merge-claim cross-check (issue #729). Subagent stops are
 * ignored because the cross-check only inspects the TL's shutdown reason.
 */
const TL_TERMINAL_EVENTS = new Set<string>([
  'stop',
  'subagent_stop',
  'stop_failure',
]);

interface DedupEntry {
  fingerprint: string;
  at: number;
}

/** Most recent (fingerprint, timestamp) per `${teamId}:${eventType}:${agentName}`. */
const lastEventFingerprint = new Map<string, DedupEntry>();

/**
 * Cheap string fingerprint for dedup — djb2 hash of the JSON payload.
 * We use a rolling hash rather than the full payload string so the map
 * entries stay bounded (O(40 bytes/entry) regardless of payload size).
 */
function fingerprintPayload(payload: string): string {
  let hash = 5381;
  for (let i = 0; i < payload.length; i++) {
    hash = ((hash << 5) + hash + payload.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

// ---------------------------------------------------------------------------
// PR polling detection state — module-level, persists across requests
// ---------------------------------------------------------------------------

/** Window duration for counting PR poll calls (10 minutes) */
const POLL_WINDOW_MS = 10 * 60 * 1000;

/** Track gh pr view/checks calls per team within a 10-minute window */
const prPollCountByTeam = new Map<string, { count: number; windowStart: number }>();

/** Track teams that have already received a poll warning in the current window */
const prPollWarned = new Set<string>();

// ---------------------------------------------------------------------------
// Subagent tracking for early crash detection
// ---------------------------------------------------------------------------

/** Track subagent start events: key = "teamWorktree:subagentName", value = { timestamp, eventCount } */
interface SubagentTracker {
  startTime: number;
  eventCount: number;
}

const subagentTrackers = new Map<string, SubagentTracker>();

/** Throttle window: tool_use events from the same team within this period are deduplicated */
const TOOL_USE_THROTTLE_MS = 5000; // 5 seconds

/** TTL for subagent trackers: entries older than this are pruned to prevent unbounded growth */
const SUBAGENT_TRACKER_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// Agent name normalization
// ---------------------------------------------------------------------------

/**
 * Normalize agent name for consistent matching across roster and messages.
 *
 * - Strips `fleet-` prefix (e.g. "fleet-dev" -> "dev", "fleet-planner" -> "planner")
 * - Maps empty/null/undefined to "team-lead" (the main CC process has no agent_type)
 * - Returns lowercase trimmed name
 */
export function normalizeAgentName(name: string | null | undefined): string {
  if (!name || name.trim() === '') return 'team-lead';
  let normalized = name.trim();
  // Strip "fleet-" prefix for consistent cross-reference
  if (normalized.startsWith('fleet-')) {
    normalized = normalized.slice(6);
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Spawn prompt capture (Issue #713)
// ---------------------------------------------------------------------------

/** 50KB cap (in bytes) for spawn prompt content stored in agent_messages.content. */
const SPAWN_PROMPT_MAX_BYTES = 51200;

/**
 * Extract the TL's spawn prompt from a hook payload's `tool_input` field.
 *
 * Both `SubagentStart` and `PostToolUse(Task)` hook events may include a
 * `tool_input` field carrying the JSON-stringified Task tool input. When
 * present, the parsed object's `prompt` property is the prompt the TL passed
 * to the Task tool. We extract it opportunistically and cap the length at
 * 50KB to bound storage.
 *
 * Returns `null` when:
 *   - `tool_input` is missing or empty
 *   - `tool_input` is not valid JSON
 *   - the parsed value is not an object or has no non-empty string `prompt` property
 */
export function extractSpawnPrompt(payload: EventPayload): string | null {
  const raw = payload.tool_input;
  if (!raw || typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.prompt !== 'string' || obj.prompt.length === 0) return null;
    return obj.prompt.slice(0, SPAWN_PROMPT_MAX_BYTES);
  } catch {
    return null;
  }
}

/**
 * Extract the `subagent_type` field from a hook payload's `tool_input` field.
 * Used to look up the matching spawn row when back-filling the prompt from
 * a `PostToolUse(Task)` event. Returns `null` when the field is missing or
 * `tool_input` is unparseable.
 */
function extractSubagentType(payload: EventPayload): string | null {
  const raw = payload.tool_input;
  if (!raw || typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.subagent_type !== 'string' || obj.subagent_type.length === 0) return null;
    return obj.subagent_type;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Agent role classification for phase transitions
// ---------------------------------------------------------------------------

/**
 * Classify a normalized agent name into one of three role categories:
 * planner, dev, or reviewer. Returns null for unknown agent types
 * (no phase change should occur).
 *
 * Uses substring matching to handle variant names across different projects
 * (e.g., "csharp-dev", "fsharp-dev", "analityk", "weryfikator").
 */
export function classifyAgentRole(normalizedName: string): 'planner' | 'dev' | 'reviewer' | null {
  const name = normalizedName.toLowerCase();
  if (name.includes('planner') || name.includes('analyst') || name.includes('analityk')) {
    return 'planner';
  }
  if (name.includes('dev') || name.includes('developer') || name.includes('implementer')) {
    return 'dev';
  }
  if (name.includes('reviewer') || name.includes('weryfikator') || name.includes('review')) {
    return 'reviewer';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase ordering for forward-only transitions
// ---------------------------------------------------------------------------

/**
 * Numeric ordering for team phases. Higher numbers are later phases.
 * `blocked` gets -1 because it is set by the poller (CI failures) and
 * should not prevent forward progression from hook events.
 */
export const PHASE_ORDER: Record<TeamPhase, number> = {
  init: 0,
  analyzing: 1,
  implementing: 2,
  reviewing: 3,
  pr: 4,
  done: 5,
  blocked: -1,
};

/**
 * Determine whether the team should advance to the target phase.
 * Returns true only when the target phase is strictly later in the
 * forward-only phase sequence than the current phase, and the
 * current phase is not terminal ('done').
 */
export function shouldAdvancePhase(currentPhase: string, targetPhase: TeamPhase): boolean {
  if (currentPhase === 'done') return false;
  const currentOrder = PHASE_ORDER[currentPhase as TeamPhase];
  const targetOrder = PHASE_ORDER[targetPhase];
  if (currentOrder === undefined || targetOrder === undefined) return false;
  return targetOrder > currentOrder;
}

// ---------------------------------------------------------------------------
// Event type normalization
// ---------------------------------------------------------------------------

/**
 * Normalize event type strings from hooks to canonical EventType values.
 * Hooks may send "tool_use", "session_start", etc. (snake_case).
 * The DB schema uses PascalCase: "ToolUse", "SessionStart", etc.
 */
function normalizeEventType(raw: string): string {
  const map: Record<string, string> = {
    'tool_use': 'ToolUse',
    'session_start': 'SessionStart',
    'session_end': 'SessionEnd',
    'stop': 'Stop',
    'stop_failure': 'StopFailure',
    'subagent_start': 'SubagentStart',
    'subagent_stop': 'SubagentStop',
    'notification': 'Notification',
    'tool_error': 'ToolError',
    'pre_compact': 'PreCompact',
    'teammate_idle': 'TeammateIdle',
    'worktree_create': 'WorktreeCreate',
    'worktree_remove': 'WorktreeRemove',
    'task_created': 'TaskCreated',
  };
  return map[raw.toLowerCase()] || raw;
}

// ---------------------------------------------------------------------------
// Background-task normalization (Issue #730)
// ---------------------------------------------------------------------------

/**
 * Normalize a JSON-stringified array that CC ships on Stop / SubagentStop
 * hook input (`background_tasks`, `session_crons`). Returns:
 *   - the original JSON string when it parses to a non-empty array
 *   - null when the input is missing, malformed, or parses to an empty array
 *
 * Normalizing empty arrays to null lets the stuck-detector use a cheap
 * `IS NOT NULL` test to decide whether to suppress the idle->stuck
 * escalation (see issue #730). Malformed JSON is treated as "no work
 * pending" so a corrupted column never wedges the escalation forever.
 */
export function normalizeJsonArray(input: string | undefined): string | null {
  if (!input) return null;
  try {
    const parsed: unknown = JSON.parse(input);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return JSON.stringify(parsed);
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// StopFailure classification (Issue #727)
// ---------------------------------------------------------------------------

/**
 * Classify a StopFailure hook payload's error string as transient, fatal, or unknown.
 *
 * - `'fatal'`: authentication/permission errors that will not self-recover. Auto-retry
 *   is suppressed by exhausting the retry budget (see processEvent).
 * - `'transient'`: rate limits, server errors, network issues that may succeed on retry.
 *   The normal `failed-queued-auto` retry path applies.
 * - `'unknown'`: anything that does not match either bucket. Treated as transient for
 *   retry purposes (permissive) — `retryMaxCount` cap is the backstop.
 *
 * Matching is case-insensitive substring matching. If `errorDetails` is empty, falls
 * back to the `errorFallback` string (typically the legacy `error` field).
 */
export function classifyStopFailure(
  errorDetails: string | undefined,
  errorFallback: string | undefined,
): 'transient' | 'fatal' | 'unknown' {
  const raw = (errorDetails || errorFallback || '').toLowerCase();
  if (!raw) return 'unknown';

  const FATAL_SUBSTRINGS = [
    'auth',
    'unauthorized',
    '401',
    '403',
    'invalid api key',
    'permission',
    'forbidden',
  ];
  for (const needle of FATAL_SUBSTRINGS) {
    if (raw.includes(needle)) return 'fatal';
  }

  const TRANSIENT_SUBSTRINGS = [
    'rate limit',
    'rate_limit',
    'overloaded',
    'server error',
    '500',
    '502',
    '503',
    '504',
    'timeout',
    'econnrefused',
    'enotfound',
    'etimedout',
    'network',
    'temporarily unavailable',
  ];
  for (const needle of TRANSIENT_SUBSTRINGS) {
    if (raw.includes(needle)) return 'transient';
  }

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Core processing
// ---------------------------------------------------------------------------

/**
 * Process an incoming event from a Claude Code hook.
 *
 * Steps:
 * 1. Look up team by worktree name
 * 2. If team is idle or stuck, transition back to running
 * 3. Always update last_event_at (heartbeat for stuck detection)
 * 4. Throttle tool_use events (same team, within 5s window)
 * 5. Insert event into DB
 * 6. Broadcast via SSE
 *
 * @returns ProcessEventResult with event_id (null if deduplicated), team_id, and processed flag
 */
export function processEvent(
  payload: EventPayload,
  db: EventCollectorDb,
  sse: SseBroker,
  messageSender?: TeamMessageSender,
  lastAssistantSink?: LastAssistantMessageSink,
): ProcessEventResult {
  // ── Validate required fields ─────────────────────────────────────
  if (!payload.event || !payload.team) {
    throw new EventCollectorError(
      'Missing required fields: event and team',
      'VALIDATION_ERROR',
    );
  }

  // ── Look up team ─────────────────────────────────────────────────
  const team = db.getTeamByWorktree(payload.team);
  if (!team) {
    throw new EventCollectorError(
      `Team not found for worktree: ${payload.team}`,
      'TEAM_NOT_FOUND',
    );
  }

  const teamId = team.id;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // ── Terminal state guard ───────────────────────────────────────────
  // Teams in terminal states (done, failed) must NOT be transitioned
  // by hook events. The event data is still recorded (below) for
  // debugging, but all transition logic is skipped.
  const isTerminal = TERMINAL_STATUSES.has(team.status);

  // ── Clean up subagent trackers for teams in terminal states ───────
  // If a team has reached done/failed, any orphaned tracker entries for
  // that team's subagents are removed on the next event for that team.
  // Also clear any pending background_tasks / session_crons on the row —
  // the team is terminal so no future suppression applies, but stale JSON
  // would still surface in TeamDetail and confuse operators (issue #730).
  if (isTerminal) {
    cleanSubagentTrackersForTeam(payload.team);
    lastToolUseByTeam.delete(payload.team);
    clearHookTaskIdsForTeam(teamId);
    try {
      db.updateTeamSilent(teamId, {
        backgroundTasksJson: null,
        sessionCronsJson: null,
      });
    } catch {
      // Best-effort cleanup — never abort event processing on a clear failure.
    }
  }

  // ── Collect transition data (without writing to DB yet) ──────────
  // The actual DB writes happen inside a single transaction below.
  // SSE broadcasts are collected and emitted AFTER the transaction commits.
  let transitionData: { teamId: number; fromStatus: TeamStatus; toStatus: TeamStatus; trigger: string; reason: string } | undefined;
  let statusUpdateData: { teamId: number; fields: Record<string, unknown> } | undefined;
  let previousStatus: TeamStatus | undefined;

  const DORMANCY_EVENTS = new Set(['stop', 'session_end']);
  const eventNameLower = payload.event.toLowerCase();

  // ── State transition: idle/stuck -> running on activity events ─────
  if (!isTerminal && (team.status === 'idle' || team.status === 'stuck') && !DORMANCY_EVENTS.has(eventNameLower)) {
    const freshTeam = db.getTeamByWorktree(payload.team);
    if (freshTeam && (freshTeam.status === 'idle' || freshTeam.status === 'stuck') && !TERMINAL_STATUSES.has(freshTeam.status)) {
      transitionData = {
        teamId,
        fromStatus: freshTeam.status,
        toStatus: 'running',
        trigger: 'hook',
        reason: `Activity resumed (${payload.event} event received)`,
      };
      // Issue #730: clear any pending background_tasks / session_crons on
      // resume — once the agent emits a non-dormancy event, the previously
      // scheduled background work is no longer the reason for dormancy. If
      // the agent is still genuinely awaiting background completion it will
      // re-emit these on its next Stop hook.
      statusUpdateData = {
        teamId,
        fields: {
          status: 'running',
          backgroundTasksJson: null,
          sessionCronsJson: null,
        },
      };
      previousStatus = freshTeam.status;
    }
  }

  // ── State transition: launching -> running only on session_start/subagent_start
  if (!isTerminal && team.status === 'launching') {
    const evt = payload.event.toLowerCase();
    if (evt === 'session_start' || evt === 'subagent_start') {
      const freshTeam = db.getTeamByWorktree(payload.team);
      if (freshTeam && freshTeam.status === 'launching') {
        transitionData = {
          teamId,
          fromStatus: 'launching',
          toStatus: 'running',
          trigger: 'hook',
          reason: `First ${evt} event received`,
        };
        statusUpdateData = { teamId, fields: { status: 'running' } };
        previousStatus = 'launching';
      }
    }
  }

  // ── State transition: stop_failure -> failed (Issue #727) ─────────
  // StopFailure hook indicates the CC turn ended due to an API error
  // (rate limit, auth, 5xx, etc.) — NOT normal completion. We mark the
  // team failed immediately with a classified reason so the operator can
  // see why the failure happened and so auto-retry can be suppressed for
  // fatal causes (auth/permission). This block runs after any default
  // idle/stuck or launching transition logic above and OVERWRITES the
  // collected transition data so the failed transition wins.
  if (!isTerminal && eventNameLower === 'stop_failure') {
    const freshTeam = db.getTeamByWorktree(payload.team);
    if (freshTeam && !TERMINAL_STATUSES.has(freshTeam.status)) {
      const classification = classifyStopFailure(payload.error_details, payload.error);
      const detail = (payload.error_details || payload.error || 'unknown error').slice(0, 500);
      const reasonTag = classification === 'fatal' ? ' [no-retry]' : '';
      transitionData = {
        teamId,
        fromStatus: freshTeam.status,
        toStatus: 'failed',
        trigger: 'hook',
        reason: `StopFailure: ${detail} (${classification})${reasonTag}`,
      };
      const statusFields: Record<string, unknown> = {
        status: 'failed',
        stoppedAt: nowIso,
        pid: null,
      };
      if (classification === 'fatal') {
        statusFields.retryCount = config.retryMaxCount;
      }
      statusUpdateData = { teamId, fields: statusFields };
      previousStatus = freshTeam.status;
    }
  }

  // ── Phase transition: SubagentStart/SubagentStop -> phase update ──
  // Compute phase transitions for non-terminal teams based on agent role.
  // Forward-only: a later phase is never replaced by an earlier one.
  let phaseUpdateData: { phase: TeamPhase; previousPhase: string } | undefined;

  if (!isTerminal) {
    const evtForPhase = payload.event.toLowerCase();
    if (evtForPhase === 'subagent_start' || evtForPhase === 'subagent_stop') {
      const rawAgentName = payload.teammate_name || payload.agent_type;
      if (rawAgentName) {
        const normalized = normalizeAgentName(rawAgentName);
        const role = classifyAgentRole(normalized);
        if (role) {
          let targetPhase: TeamPhase | undefined;

          if (evtForPhase === 'subagent_start') {
            // Agent starting: transition to the phase the agent represents
            if (role === 'planner') targetPhase = 'analyzing';
            else if (role === 'dev') targetPhase = 'implementing';
            else if (role === 'reviewer') targetPhase = 'reviewing';
          } else {
            // Agent stopping: transition to the NEXT expected phase
            if (role === 'planner') targetPhase = 'implementing';
            else if (role === 'dev') targetPhase = 'reviewing';
            else if (role === 'reviewer') targetPhase = 'pr';
          }

          if (targetPhase && shouldAdvancePhase(team.phase, targetPhase)) {
            phaseUpdateData = { phase: targetPhase, previousPhase: team.phase };

            // Merge phase into existing statusUpdate or create new one
            if (statusUpdateData) {
              statusUpdateData.fields.phase = targetPhase;
            } else {
              statusUpdateData = { teamId, fields: { phase: targetPhase } };
            }
          }
        }
      }
    }
  }

  // ── Background tasks / session crons (Issue #730) ─────────────────
  // CC 2.1.145+ ships `background_tasks` (Stop) and `session_crons`
  // (SubagentStop) arrays inside cc_stdin. When non-empty, the agent has
  // intentionally scheduled work to continue after the current turn ends.
  // Persist these on the team row so stuck-detector can suppress the
  // idle->stuck escalation while either array is non-empty. Empty arrays
  // (and malformed JSON) normalize to NULL so the suppression is a simple
  // `IS NOT NULL` check downstream.
  //
  // We only WRITE these fields here on the relevant dormancy events; we
  // do NOT write defaults on other events because that would clobber the
  // values set by a previous Stop hook before the agent has had a chance
  // to resume (the resume path above clears them explicitly).
  const BG_DORMANCY_EVENTS = new Set(['stop', 'subagent_stop', 'stop_failure', 'session_end']);
  if (!isTerminal && BG_DORMANCY_EVENTS.has(eventNameLower)) {
    const hasBackgroundField = payload.background_tasks !== undefined;
    const hasCronField = payload.session_crons !== undefined;
    if (hasBackgroundField || hasCronField) {
      statusUpdateData ??= { teamId, fields: {} };
      if (hasBackgroundField) {
        statusUpdateData.fields.backgroundTasksJson = normalizeJsonArray(payload.background_tasks);
      }
      if (hasCronField) {
        statusUpdateData.fields.sessionCronsJson = normalizeJsonArray(payload.session_crons);
      }
    }
  }

  // ── Throttle tool_use events ─────────────────────────────────────
  // Throttled events still need a heartbeat update and any transition
  // that was determined above. For throttled events, execute the
  // transition (if any) directly and update heartbeat, then exit early.
  if (payload.event.toLowerCase() === 'tool_use') {
    const teamKey = payload.team;
    const lastTime = lastToolUseByTeam.get(teamKey) || 0;

    if (now - lastTime < TOOL_USE_THROTTLE_MS) {
      // Deduplicated: still apply any transition + heartbeat atomically,
      // but skip event insert and SSE broadcast. Wrapped in a transaction
      // for atomicity (Issue #529).
      db.processThrottledUpdate({
        transition: transitionData,
        statusUpdate: statusUpdateData,
        heartbeatUpdate: { teamId, lastEventAt: nowIso },
      });
      if (previousStatus !== undefined) {
        sse.broadcast('team_status_changed', {
          team_id: teamId,
          status: 'running',
          previous_status: previousStatus,
        }, teamId);
      }
      return { event_id: null, team_id: teamId, processed: false };
    }

    // Outside throttle window: allow this event through and record time
    lastToolUseByTeam.set(teamKey, now);

    // Prune stale entries to prevent unbounded growth
    for (const [k, t] of lastToolUseByTeam) {
      if (now - t > TOOL_USE_THROTTLE_MS * 2) lastToolUseByTeam.delete(k);
    }
  }

  // ── Normalize event type ─────────────────────────────────────────
  const eventType = normalizeEventType(payload.event);

  // ── Normalize agent name ────────────────────────────────────────
  const agentName = normalizeAgentName(payload.agent_type);

  // ── Collect agent messages to include in the transaction ─────────
  const agentMessages: Array<{ teamId: number; sender: string; recipient: string; summary?: string | null; content?: string | null; sessionId?: string | null }> = [];
  const evtLower = payload.event.toLowerCase();

  if (evtLower === 'subagent_start') {
    const subagentName = payload.teammate_name || payload.agent_type || 'unknown';
    const senderName = normalizeAgentName(null); // TL spawns subagents
    const recipientName = normalizeAgentName(subagentName);
    // Issue #713: capture the TL's spawn prompt when present in tool_input.
    // The prompt may arrive on SubagentStart (CC version-dependent) OR on
    // the subsequent PostToolUse(Task) event (handled via back-fill below).
    // 50KB cap is enforced inside extractSpawnPrompt.
    const spawnPrompt = extractSpawnPrompt(payload);
    agentMessages.push({
      teamId,
      sender: senderName,
      recipient: recipientName,
      summary: 'spawned agent',
      content: spawnPrompt,
      sessionId: payload.session_id || null,
    });
  }

  if (payload.tool_name === 'SendMessage' && payload.msg_to) {
    agentMessages.push({
      teamId,
      sender: normalizeAgentName(payload.agent_type),
      recipient: normalizeAgentName(payload.msg_to),
      summary: payload.msg_summary || null,
      content: payload.message || null,
      sessionId: payload.session_id || null,
    });
  }

  // ── Back-fill spawn prompt from PostToolUse(Task) (issue #713) ───
  // When TL invokes the Task tool, two hook events arrive:
  //   1. SubagentStart — fires when the subagent process starts. May or may
  //      not carry tool_input.prompt depending on CC version.
  //   2. ToolUse for tool_name=Task — fires after the subagent finishes.
  //      Reliably carries tool_input.{subagent_type, description, prompt}.
  // If the SubagentStart row has no captured content yet, opportunistically
  // populate it now from the Task tool's prompt. This is opt-in (the DB
  // method may be undefined on the mock interface) and best-effort.
  if (
    evtLower === 'tool_use' &&
    payload.tool_name === 'Task' &&
    typeof db.backfillSpawnPromptForTask === 'function'
  ) {
    try {
      const taskPrompt = extractSpawnPrompt(payload);
      const taskSubagentType = extractSubagentType(payload);
      if (taskPrompt && taskSubagentType) {
        db.backfillSpawnPromptForTask({
          teamId,
          taskSubagentType,
          prompt: taskPrompt,
        });
      }
    } catch (err) {
      // Non-critical: spawn-prompt back-fill is opportunistic. Log but do
      // not abort event processing.
      console.warn(
        `[EventCollector] Spawn prompt back-fill failed for team=${payload.team}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Dedup: drop back-to-back identical shutdown events (issue #691 C) ─
  // Shutdown hooks were observed inserting consecutive rows with identical
  // payloads within a few milliseconds (dual-write path, not pinned to a
  // single smoking gun). We can't identify the exact dual-write site with
  // confidence, so we add a narrow safety net: for shutdown-family events
  // only, if an event with the same (team, type, agent) and payload
  // fingerprint arrived within DEDUP_WINDOW_MS, drop the duplicate.
  //
  // Scoped to shutdown events to avoid penalizing legitimate event bursts
  // (e.g. sequential worktree_create/remove) that happen to share payloads.
  // The transition/heartbeat writes from the first event already captured
  // the relevant side effects, so dropping the insert is safe.
  const payloadJson = JSON.stringify(payload);
  const fingerprint = fingerprintPayload(payloadJson);
  if (DEDUP_EVENT_TYPES.has(eventNameLower)) {
    const dedupKey = `${teamId}:${eventType}:${agentName}`;
    const prevFingerprint = lastEventFingerprint.get(dedupKey);
    if (
      prevFingerprint &&
      prevFingerprint.fingerprint === fingerprint &&
      now - prevFingerprint.at < DEDUP_WINDOW_MS
    ) {
      // Duplicate: refresh timestamp so a burst of N copies collapses to one.
      lastEventFingerprint.set(dedupKey, { fingerprint, at: now });
      return { event_id: null, team_id: teamId, processed: false };
    }
    lastEventFingerprint.set(dedupKey, { fingerprint, at: now });
    // Prune stale entries to prevent unbounded growth.
    if (lastEventFingerprint.size > 1024) {
      for (const [k, v] of lastEventFingerprint) {
        if (now - v.at > DEDUP_WINDOW_MS * 20) lastEventFingerprint.delete(k);
      }
    }
  }

  // ── Capture TL's last_assistant_message for merge-claim cross-check ──
  // Issue #729: CC 2.1.46+ emits `last_assistant_message` on Stop /
  // SubagentStop / StopFailure hook stdin. The merge-claim cross-check in
  // team-manager.handleProcessExit prefers this value over the parsedEvents
  // buffer extraction. Filter on agentName === 'team-lead' so subagent stops
  // don't shadow the TL message in the cache. Non-empty string only.
  if (
    lastAssistantSink &&
    TL_TERMINAL_EVENTS.has(eventNameLower) &&
    agentName === 'team-lead' &&
    typeof payload.last_assistant_message === 'string' &&
    payload.last_assistant_message.length > 0
  ) {
    try {
      lastAssistantSink.noteLastAssistantMessage(teamId, payload.last_assistant_message);
    } catch (err) {
      console.warn(
        `[EventCollector] noteLastAssistantMessage failed for team=${payload.team}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Execute all DB writes in a single transaction ────────────────
  let eventId: number;
  try {
    const result = db.processEventTransaction({
      transition: transitionData,
      statusUpdate: statusUpdateData,
      heartbeatUpdate: { teamId, lastEventAt: nowIso },
      eventInsert: {
        teamId,
        sessionId: payload.session_id || null,
        agentName,
        eventType,
        toolName: payload.tool_name || null,
        payload: payloadJson,
      },
      agentMessages: agentMessages.length > 0 ? agentMessages : undefined,
    });
    eventId = result.eventId;
  } catch (err) {
    console.error(`[EventCollector] Transaction failed for team=${payload.team} event=${payload.event}: ${err}`);
    throw err;
  }

  // ── Broadcast via SSE (after transaction commits) ────────────────
  // Emit a single team_status_changed event carrying both status and
  // phase info when both change simultaneously (avoids double-broadcast).
  // Derive the new status from statusUpdateData so transitions that target
  // statuses other than 'running' (e.g. running -> failed on StopFailure,
  // issue #727) broadcast the correct new status.
  const broadcastStatus = (statusUpdateData?.fields.status as string | undefined) || 'running';
  if (previousStatus !== undefined && phaseUpdateData) {
    sse.broadcast('team_status_changed', {
      team_id: teamId,
      status: broadcastStatus,
      previous_status: previousStatus,
      phase: phaseUpdateData.phase,
      previous_phase: phaseUpdateData.previousPhase,
    }, teamId);
  } else if (previousStatus !== undefined) {
    sse.broadcast('team_status_changed', {
      team_id: teamId,
      status: broadcastStatus,
      previous_status: previousStatus,
    }, teamId);
  } else if (phaseUpdateData) {
    sse.broadcast('team_status_changed', {
      team_id: teamId,
      status: team.status,
      previous_status: team.status,
      phase: phaseUpdateData.phase,
      previous_phase: phaseUpdateData.previousPhase,
    }, teamId);
  }

  // ── Broadcast team_stopped when status transitions to failed (#727) ──
  // Replicates team-manager.handleProcessExit behavior so the UI converges
  // immediately on StopFailure-driven failures (the team-manager won't
  // observe a process exit until the CC process actually dies).
  if (statusUpdateData?.fields.status === 'failed') {
    sse.broadcast('team_stopped', { team_id: teamId }, teamId);
  }

  sse.broadcast('team_event', {
    event_id: eventId,
    team_id: teamId,
    event_type: eventType,
    session_id: payload.session_id || null,
    agent_name: agentName,
    tool_name: payload.tool_name || null,
    timestamp: payload.timestamp || nowIso,
  });

  // ── PR polling frequency detection ──────────────────────────────
  // Detect teams that excessively call `gh pr view` or `gh pr checks`
  // via Bash tool_use events. When the count exceeds the configured
  // threshold within a 10-minute window, send a one-time warning.
  if (
    eventType === 'ToolUse' &&
    payload.tool_name === 'Bash' &&
    messageSender
  ) {
    const toolInput = payload.tool_input || payload.message || '';
    if (toolInput.includes('gh pr view') || toolInput.includes('gh pr checks')) {
      const teamKey = payload.team;
      const entry = prPollCountByTeam.get(teamKey);

      if (!entry || now - entry.windowStart > POLL_WINDOW_MS) {
        // Start a new window
        prPollCountByTeam.set(teamKey, { count: 1, windowStart: now });
        // New window also resets the warned flag
        prPollWarned.delete(teamKey);
      } else {
        entry.count++;
        if (entry.count > config.maxPrPollCalls && !prPollWarned.has(teamKey)) {
          // Exceeded threshold — send one-time warning (inline message,
          // matching the crash-detection pattern — no resolveMessage to
          // avoid circular import with db.ts).
          const warnMsg =
            'Stop polling GitHub with gh pr view / gh pr checks. FC monitors CI and PR status ' +
            'automatically and will notify you via stdin (ci_green, ci_red, pr_merged). Wait for these events instead of polling.';
          try {
            messageSender.sendMessage(teamId, warnMsg, 'fc', 'poll_warning');
            console.log(`[EventCollector] Poll warning sent to team ${teamId} (${entry.count} gh pr calls in window)`);
          } catch {
            // Non-critical — silently ignore send failures
          }
          prPollWarned.add(teamKey);
        }
      }
    }
  }

  // ── Task extraction from TaskCreated events ─────────────────────
  // Parse TaskCreated hook events and upsert task data into team_tasks.
  // CC 2.1.143+ ships native `owner` and `agent_id` fields in cc_stdin; we
  // prefer those over the event-level `agent_type` (which identifies the
  // emitter, not necessarily the task's owner).
  if (eventType === 'TaskCreated' && db.upsertTeamTask) {
    try {
      // Parse cc_stdin for task fields (hook sends raw CC stdin JSON)
      let ccData: Record<string, unknown> = {};
      if (payload.cc_stdin) {
        try {
          ccData = JSON.parse(payload.cc_stdin) as Record<string, unknown>;
        } catch {
          // Malformed cc_stdin — fall through to direct payload fields
        }
      }

      // Cascading fallback: cc_stdin fields -> direct payload fields -> defaults
      // Compute subject first so we can derive a content-based stable fallback taskId.
      // Using tool_use_id or eventId as fallback causes duplicates after context compaction
      // because the same logical task fires a new hook event with a new tool_use_id.
      const subject = (ccData.subject ?? ccData.title ?? payload.message ?? 'Untitled task') as string;
      const subjectSlug = subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
      const taskId = (ccData.task_id ?? `task-${teamId}-${subjectSlug}`) as string;
      const description = (ccData.description ?? null) as string | null;
      const status = (ccData.status ?? 'pending') as string;
      // Owner priority: explicit owner from CC hook > agent_id of creating subagent
      // > event-level agent_type. The route handler lifts cc.owner onto
      // payload.owner; we also accept ccData.owner directly for callers that
      // bypass the route (e.g., direct processEvent calls). All routed through
      // normalizeAgentName for consistency with subagent/agent_messages
      // attribution.
      const ccOwner = typeof ccData.owner === 'string' ? ccData.owner : undefined;
      const ccAgentId = typeof ccData.agent_id === 'string' ? ccData.agent_id : undefined;
      const ownerRaw =
        payload.owner ?? ccOwner ?? payload.agent_id ?? ccAgentId ?? payload.agent_type;
      const owner = normalizeAgentName(ownerRaw);

      const task = db.upsertTeamTask({
        teamId,
        taskId,
        subject,
        description,
        status,
        owner,
      });

      // Record this taskId so the legacy stream-event TodoWrite parser in
      // team-manager.ts skips redundant upserts/broadcasts for the same task.
      recordHookTaskId(teamId, taskId);

      sse.broadcast('task_updated', {
        team_id: teamId,
        task_id: task.taskId,
        subject: task.subject,
        status: task.status,
        owner: task.owner,
      }, teamId);
    } catch {
      // Non-critical — task extraction failure should not break event processing
    }
  }

  // ── Subagent crash detection (advisory) ───────────────────────
  // Track SubagentStart/SubagentStop pairs. If a subagent stops very
  // quickly (< 2 min) with minimal events (< 5), it likely crashed.
  // Send an advisory message to the TL so they can decide to respawn.
  if (evtLower === 'subagent_start') {
    const subagentName = payload.teammate_name || payload.agent_type || 'unknown';
    const trackerKey = `${payload.team}:${subagentName}`;
    subagentTrackers.set(trackerKey, { startTime: now, eventCount: 0 });

    // Prune stale subagent trackers to prevent unbounded growth
    for (const [k, tracker] of subagentTrackers) {
      if (now - tracker.startTime > SUBAGENT_TRACKER_TTL_MS) subagentTrackers.delete(k);
    }
  }

  // Increment event count for any tracked subagent on this team
  if (payload.agent_type || payload.teammate_name) {
    const subagentName = payload.teammate_name || payload.agent_type || 'unknown';
    const trackerKey = `${payload.team}:${subagentName}`;
    const tracker = subagentTrackers.get(trackerKey);
    if (tracker) {
      tracker.eventCount++;
    }
  }

  if (evtLower === 'subagent_stop' && messageSender) {
    const subagentName = payload.teammate_name || payload.agent_type || 'unknown';
    const trackerKey = `${payload.team}:${subagentName}`;
    const tracker = subagentTrackers.get(trackerKey);

    if (tracker) {
      const durationMs = now - tracker.startTime;
      const durationSec = Math.round(durationMs / 1000);

      if (durationMs < config.earlyCrashThresholdSec * 1000 && tracker.eventCount < config.earlyCrashMinTools) {
        const crashMsg =
          `Subagent '${subagentName}' appears to have crashed (${durationSec}s after start, ${tracker.eventCount} events). Consider respawning.`;
        try {
          messageSender.sendMessage(teamId, crashMsg, 'fc', 'subagent_crash');
          console.log(`[EventCollector] Subagent crash advisory sent for ${subagentName} on team ${teamId}`);
        } catch {
          // Non-critical — silently ignore send failures
        }
      }

      // Clean up tracker regardless of crash detection
      subagentTrackers.delete(trackerKey);
    }
  }

  return { event_id: eventId, team_id: teamId, processed: true };
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class EventCollectorError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'EventCollectorError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Utility: clear throttle state (for testing)
// ---------------------------------------------------------------------------

/** Reset all throttle state. Intended for use in tests only. */
export function resetThrottleState(): void {
  lastToolUseByTeam.clear();
}

/** Reset event dedup state. Intended for use in tests only. */
export function resetEventDedupState(): void {
  lastEventFingerprint.clear();
}

/** Reset subagent tracking state. Intended for use in tests only. */
export function resetSubagentTrackers(): void {
  subagentTrackers.clear();
}

/** Reset PR polling detection state. Intended for use in tests only. */
export function resetPrPollState(): void {
  prPollCountByTeam.clear();
  prPollWarned.clear();
}

/** Return current size of subagent tracker map. Intended for use in tests only. */
export function getSubagentTrackerSize(): number {
  return subagentTrackers.size;
}

/** Remove all subagent tracker entries for a given team (worktree name). */
export function cleanSubagentTrackersForTeam(worktreeName: string): void {
  const prefix = worktreeName + ':';
  for (const key of subagentTrackers.keys()) {
    if (key.startsWith(prefix)) subagentTrackers.delete(key);
  }
}
