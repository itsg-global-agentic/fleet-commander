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
  cwd?: string;                 // working directory of the CC process
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
}

/** SSE broker interface for broadcasting events */
export interface SseBroker {
  broadcast<T extends SSEEventType>(event: T, data: SSEEventPayloads[T], teamId?: number): void;
}

/** Optional team message sender for advisory messages (e.g., crash detection) */
export interface TeamMessageSender {
  sendMessage(teamId: number, message: string, source?: 'user' | 'fc', subtype?: string): boolean;
}

// ---------------------------------------------------------------------------
// Throttle state — module-level, persists across requests
// ---------------------------------------------------------------------------

/** Track last tool_use event time per team for throttling */
const lastToolUseByTeam = new Map<string, number>();

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
  if (isTerminal) {
    cleanSubagentTrackersForTeam(payload.team);
  }

  // ── Collect transition data (without writing to DB yet) ──────────
  // The actual DB writes happen inside a single transaction below.
  // SSE broadcasts are collected and emitted AFTER the transaction commits.
  let transitionData: { teamId: number; fromStatus: TeamStatus; toStatus: TeamStatus; trigger: string; reason: string } | undefined;
  let statusUpdateData: { teamId: number; fields: Record<string, unknown> } | undefined;
  let previousStatus: TeamStatus | undefined;

  const DORMANCY_EVENTS = new Set(['stop', 'stop_failure', 'session_end']);
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
      statusUpdateData = { teamId, fields: { status: 'running' } };
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
    agentMessages.push({
      teamId,
      sender: senderName,
      recipient: recipientName,
      summary: 'spawned agent',
      content: null,
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
        payload: JSON.stringify(payload),
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
  if (previousStatus !== undefined && phaseUpdateData) {
    sse.broadcast('team_status_changed', {
      team_id: teamId,
      status: 'running',
      previous_status: previousStatus,
      phase: phaseUpdateData.phase,
      previous_phase: phaseUpdateData.previousPhase,
    }, teamId);
  } else if (previousStatus !== undefined) {
    sse.broadcast('team_status_changed', {
      team_id: teamId,
      status: 'running',
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

  sse.broadcast('team_event', {
    event_id: eventId,
    team_id: teamId,
    event_type: eventType,
    session_id: payload.session_id || null,
    agent_name: agentName,
    tool_name: payload.tool_name || null,
    timestamp: payload.timestamp || nowIso,
  });

  // ── Task extraction from TaskCreated events ─────────────────────
  // Parse TaskCreated hook events and upsert task data into team_tasks.
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
      const owner = normalizeAgentName(payload.agent_type);

      const task = db.upsertTeamTask({
        teamId,
        taskId,
        subject,
        description,
        status,
        owner,
      });

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

/** Reset subagent tracking state. Intended for use in tests only. */
export function resetSubagentTrackers(): void {
  subagentTrackers.clear();
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
