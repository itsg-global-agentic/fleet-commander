// =============================================================================
// Fleet Commander — Build Timeline (merge stream + hook events)
// =============================================================================
// Server-side utility that combines parsed CC stream events and hook events
// from the database into a single chronologically-sorted timeline.
//
// Deduplication: when a hook ToolUse event matches a stream tool_use event
// (same tool name within a 10-second window), the hook event is dropped
// because the stream event carries richer data (input, output, etc.).
// =============================================================================

import type {
  StreamTimelineEntry,
  HookTimelineEntry,
  TimelineEntry,
  Event,
} from '../../shared/types.js';

/** Shape of a parsed stream event from the team manager's in-memory buffer. */
export interface RawStreamEvent {
  type: string;
  timestamp?: string;
  subtype?: string;
  message?: { content?: Array<{ type: string; text?: string }> };
  tool?: { name?: string; input?: unknown };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 10-second dedup window in milliseconds */
const DEDUP_WINDOW_MS = 10_000;

/**
 * Safely parse an ISO 8601 timestamp string into epoch ms.
 * Returns 0 for unparseable / missing timestamps so entries still sort.
 */
function toEpoch(ts: string | undefined | null): number {
  if (!ts) return 0;
  const ms = new Date(ts).getTime();
  return isNaN(ms) ? 0 : ms;
}

/**
 * Normalise any ISO-ish timestamp into a consistent ISO 8601 string.
 * Falls back to current time if the value is missing or unparseable.
 */
function normalizeTimestamp(ts: string | undefined | null): string {
  if (!ts) return new Date().toISOString();
  const d = new Date(ts);
  if (isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Merge stream events and hook events into a unified, chronologically-sorted
 * timeline array.
 *
 * @param streamEvents - Parsed NDJSON events from the CC stdout buffer
 * @param hookEvents   - Hook events from the `events` DB table
 * @param teamId       - The team these events belong to
 * @param limit        - Maximum number of entries to return (default 200)
 */
export function buildTimeline(
  streamEvents: RawStreamEvent[],
  hookEvents: Event[],
  teamId: number,
  limit = 200,
): TimelineEntry[] {
  // 1. Map stream events to StreamTimelineEntry
  const streamEntries: StreamTimelineEntry[] = streamEvents.map((e, i) => ({
    id: `stream-${i}`,
    source: 'stream' as const,
    timestamp: normalizeTimestamp(e.timestamp),
    teamId,
    streamType: e.type,
    subtype: e.subtype,
    message: e.message,
    tool: e.tool,
  }));

  // 2. Map hook events to HookTimelineEntry
  const hookEntries: HookTimelineEntry[] = hookEvents.map((e) => ({
    id: `event-${e.id}`,
    source: 'hook' as const,
    timestamp: normalizeTimestamp(e.createdAt),
    teamId,
    eventType: e.eventType,
    toolName: e.toolName ?? undefined,
    agentName: e.agentName ?? undefined,
    payload: e.payload ?? undefined,
  }));

  // 3. Deduplicate: remove hook ToolUse events that overlap a stream tool_use
  //    within the same 10-second window and matching tool name.
  const streamToolUses = streamEntries.filter(
    (e) => e.streamType === 'tool_use' && e.tool?.name,
  );

  const dedupedHookEntries = hookEntries.filter((hook) => {
    if (hook.eventType !== 'ToolUse' || !hook.toolName) return true;

    const hookEpoch = toEpoch(hook.timestamp);
    return !streamToolUses.some((stream) => {
      if (stream.tool?.name !== hook.toolName) return false;
      const streamEpoch = toEpoch(stream.timestamp);
      return Math.abs(streamEpoch - hookEpoch) <= DEDUP_WINDOW_MS;
    });
  });

  // 4. Merge and sort chronologically
  const merged: TimelineEntry[] = [
    ...streamEntries,
    ...dedupedHookEntries,
  ];

  merged.sort((a, b) => toEpoch(a.timestamp) - toEpoch(b.timestamp));

  // 5. Apply limit
  return merged.slice(0, limit);
}
