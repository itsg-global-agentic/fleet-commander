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
  message?: { content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> };
  tool?: { name?: string; input?: unknown };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * High-frequency partial-message types emitted by --include-partial-messages.
 * These should be filtered out by captureOutput() in team-manager.ts, but as a
 * defense-in-depth measure we also exclude them here so they never appear in
 * the timeline even if upstream filtering is bypassed.
 */
const NOISE_STREAM_TYPES = new Set([
  'stream_event',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
]);

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
  limit = 500,
): TimelineEntry[] {
  // 1. Filter out noise stream types (defense-in-depth), then map to StreamTimelineEntry
  const filteredStreamEvents = streamEvents.filter(e => !NOISE_STREAM_TYPES.has(e.type));
  const streamEntries: StreamTimelineEntry[] = filteredStreamEvents.map((e, i) => ({
    id: `stream-${i}`,
    source: 'stream' as const,
    timestamp: normalizeTimestamp(e.timestamp),
    teamId,
    streamType: e.type,
    subtype: e.subtype,
    message: e.message,
    tool: e.tool,
    // Pass through agent attribution fields injected by captureOutput()
    ...(e.agentName ? { agentName: e.agentName as string } : {}),
    ...(e.description ? { description: e.description as string } : {}),
    ...(e.lastToolName ? { lastToolName: e.lastToolName as string } : {}),
  }));

  // 1b. Extract tool_use content blocks from assistant events into separate
  //     StreamTimelineEntry objects so they light up the existing rendering
  //     path for streamType === 'tool_use' and participate in deduplication.
  const extractedEntries: StreamTimelineEntry[] = [];
  for (let i = 0; i < streamEntries.length; i++) {
    const entry = streamEntries[i];
    if (entry.streamType !== 'assistant') continue;
    const contentBlocks = entry.message?.content;
    if (!contentBlocks || !Array.isArray(contentBlocks)) continue;
    for (let j = 0; j < contentBlocks.length; j++) {
      const block = contentBlocks[j];
      if (block.type !== 'tool_use' || !block.name) continue;
      extractedEntries.push({
        id: `stream-${i}-tool-${j}`,
        source: 'stream' as const,
        timestamp: entry.timestamp,
        teamId,
        streamType: 'tool_use',
        tool: { name: block.name, input: block.input },
        ...(entry.agentName ? { agentName: entry.agentName } : {}),
      });
    }
  }
  // Append extracted entries to the stream entries array so they participate
  // in deduplication and timeline merging.
  streamEntries.push(...extractedEntries);

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

  // 5. Apply limit — take the MOST RECENT entries (tail) rather than oldest
  return merged.slice(-limit);
}
