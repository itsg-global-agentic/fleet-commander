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

import type { SSEEventType } from './sse-broker.js';

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
  stop_reason?: string;
  worktree_root?: string;
}

/** Result returned from processEvent */
export interface ProcessEventResult {
  event_id: number | null;
  team_id: number;
  processed: boolean;
}

/** Minimal DB abstraction (subset of methods used by EventCollector) */
export interface EventCollectorDb {
  getTeamByWorktree(worktreeName: string): { id: number; status: string; phase: string } | undefined;
  insertEvent(event: {
    teamId: number;
    sessionId: string | null;
    agentName: string | null;
    eventType: string;
    toolName?: string | null;
    payload: string;
  }): { id: number };
  updateTeam(teamId: number, fields: Record<string, unknown>): void;
}

/** SSE broker interface for broadcasting events */
export interface SseBroker {
  broadcast(event: SSEEventType, data: unknown): void;
}

// ---------------------------------------------------------------------------
// Throttle state — module-level, persists across requests
// ---------------------------------------------------------------------------

/** Track last tool_use event time per team for throttling */
const lastToolUseByTeam = new Map<string, number>();

/** Throttle window: tool_use events from the same team within this period are deduplicated */
const TOOL_USE_THROTTLE_MS = 5000; // 5 seconds

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
    'subagent_start': 'SubagentStart',
    'subagent_stop': 'SubagentStop',
    'notification': 'Notification',
    'teammate_idle': 'TeammateIdle',
    'cost_update': 'CostUpdate',
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

  // ── State transition: idle/stuck -> running on any event ──────────
  // Any event from an idle or stuck team proves it is alive.
  // This MUST happen before the throttle check so that even
  // deduplicated tool_use events trigger the recovery transition.
  if (team.status === 'idle' || team.status === 'stuck') {
    db.updateTeam(teamId, {
      status: 'running',
    });
  }

  // ── State transition: launching -> running only on session_start/subagent_start
  // Other events during launching may be noise; wait for an actual session start.
  if (team.status === 'launching') {
    const evt = payload.event.toLowerCase();
    if (evt === 'session_start' || evt === 'subagent_start') {
      db.updateTeam(teamId, {
        status: 'running',
      });
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

  // ── Insert event into database ───────────────────────────────────
  const inserted = db.insertEvent({
    teamId,
    sessionId: payload.session_id || null,
    agentName: payload.agent_type || null,
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
    agent_name: payload.agent_type || null,
    tool_name: payload.tool_name || null,
    timestamp: payload.timestamp || nowIso,
  });

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
