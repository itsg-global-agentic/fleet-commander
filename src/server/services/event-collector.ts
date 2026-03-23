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

import type { TeamStatus } from '../../shared/types.js';
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

  // ── State transition: idle/stuck -> running on activity events ─────
  // Most events from an idle or stuck team prove it is alive and doing
  // work. However, dormancy-indicating events (stop, session_end) mean
  // the agent finished its turn or the session terminated — they must
  // NOT reset the idle/stuck status because the agent is not actively
  // working. Those events still update lastEventAt (line 206) so the
  // stuck detector has accurate timing data.
  //
  // This MUST happen before the throttle check so that even
  // deduplicated tool_use events trigger the recovery transition.
  const DORMANCY_EVENTS = new Set(['stop', 'stop_failure', 'session_end']);
  const eventNameLower = payload.event.toLowerCase();

  if (!isTerminal && (team.status === 'idle' || team.status === 'stuck') && !DORMANCY_EVENTS.has(eventNameLower)) {
    // Re-read from DB to avoid stale state (another service may have transitioned the team)
    const freshTeam = db.getTeamByWorktree(payload.team);
    if (freshTeam && (freshTeam.status === 'idle' || freshTeam.status === 'stuck') && !TERMINAL_STATUSES.has(freshTeam.status)) {
      db.insertTransition({
        teamId,
        fromStatus: freshTeam.status,
        toStatus: 'running',
        trigger: 'hook',
        reason: `Activity resumed (${payload.event} event received)`,
      });
      db.updateTeam(teamId, {
        status: 'running',
      });
      sse.broadcast('team_status_changed', {
        team_id: teamId,
        status: 'running',
        previous_status: freshTeam.status,
      }, teamId);
    }
  }

  // ── State transition: launching -> running only on session_start/subagent_start
  // Other events during launching may be noise; wait for an actual session start.
  if (!isTerminal && team.status === 'launching') {
    const evt = payload.event.toLowerCase();
    if (evt === 'session_start' || evt === 'subagent_start') {
      // Re-read from DB to avoid stale state (launch timeout may have fired)
      const freshTeam = db.getTeamByWorktree(payload.team);
      if (freshTeam && freshTeam.status === 'launching') {
        db.insertTransition({
          teamId,
          fromStatus: 'launching',
          toStatus: 'running',
          trigger: 'hook',
          reason: `First ${evt} event received`,
        });
        db.updateTeam(teamId, {
          status: 'running',
        });
        sse.broadcast('team_status_changed', {
          team_id: teamId,
          status: 'running',
          previous_status: 'launching',
        }, teamId);
      }
    }
  }

  // ── Always update last_event_at (heartbeat) ──────────────────────
  // Stuck detection depends on last_event_at being fresh.
  // Even throttled/deduplicated events must update this timestamp
  // so the stuck detector doesn't falsely flag active teams.
  db.updateTeam(teamId, { lastEventAt: nowIso });

  // ── Throttle tool_use events ─────────────────────────────────────
  if (payload.event.toLowerCase() === 'tool_use') {
    const teamKey = payload.team;
    const lastTime = lastToolUseByTeam.get(teamKey) || 0;

    if (now - lastTime < TOOL_USE_THROTTLE_MS) {
      // Deduplicated: don't insert into DB or broadcast SSE.
      // Return 200 with processed: false (not an error, just deduped).
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
  // Strip "fleet-" prefix and map empty agent_type to "team-lead"
  // so roster names and message sender/recipient names match.
  const agentName = normalizeAgentName(payload.agent_type);

  // ── Insert event into database ───────────────────────────────────
  const inserted = db.insertEvent({
    teamId,
    sessionId: payload.session_id || null,
    agentName,
    eventType,
    toolName: payload.tool_name || null,
    payload: JSON.stringify(payload),
  });
  const eventId = inserted.id;

  // ── Broadcast via SSE ────────────────────────────────────────────
  sse.broadcast('team_event', {
    event_id: eventId,
    team_id: teamId,
    event_type: eventType,
    session_id: payload.session_id || null,
    agent_name: agentName,
    tool_name: payload.tool_name || null,
    timestamp: payload.timestamp || nowIso,
  });

  // ── Subagent crash detection (advisory) ───────────────────────
  // Track SubagentStart/SubagentStop pairs. If a subagent stops very
  // quickly (< 2 min) with minimal events (< 5), it likely crashed.
  // Send an advisory message to the TL so they can decide to respawn.
  const evtLower = payload.event.toLowerCase();

  if (evtLower === 'subagent_start') {
    const subagentName = payload.teammate_name || payload.agent_type || 'unknown';
    const trackerKey = `${payload.team}:${subagentName}`;
    subagentTrackers.set(trackerKey, { startTime: now, eventCount: 0 });

    // Record spawn as a real agent message (TL -> subagent) so the CommGraph
    // shows data-driven edges instead of synthetic spawn lines.
    try {
      const senderName = normalizeAgentName(null); // TL spawns subagents
      const recipientName = normalizeAgentName(subagentName);
      db.insertAgentMessage({
        teamId,
        eventId,
        sender: senderName,
        recipient: recipientName,
        summary: 'spawned agent',
        content: null,
        sessionId: payload.session_id || null,
      });
    } catch {
      // Non-critical — silently ignore insert failures
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

  // ── Capture inter-agent message routing ───────────────────────
  // When a SendMessage tool call is received with a msg_to field,
  // record the message in the agent_messages table for routing visibility.
  if (payload.tool_name === 'SendMessage' && payload.msg_to) {
    try {
      db.insertAgentMessage({
        teamId,
        eventId,
        sender: normalizeAgentName(payload.agent_type),
        recipient: normalizeAgentName(payload.msg_to),
        summary: payload.msg_summary || null,
        content: payload.message || null,
        sessionId: payload.session_id || null,
      });
    } catch {
      // Non-critical — silently ignore insert failures
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
