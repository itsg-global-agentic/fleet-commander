// =============================================================================
// Fleet Commander — Build Timeline Tests
// =============================================================================

import { describe, it, expect } from 'vitest';
import { buildTimeline, type RawStreamEvent } from '../../src/server/utils/build-timeline.js';
import type { Event } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStreamEvent(overrides: Partial<RawStreamEvent> = {}): RawStreamEvent {
  return {
    type: 'assistant',
    timestamp: '2026-03-20T10:00:00.000Z',
    ...overrides,
  };
}

function makeHookEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 1,
    teamId: 1,
    eventType: 'ToolUse',
    sessionId: 'sess-1',
    toolName: null,
    agentName: null,
    payload: null,
    createdAt: '2026-03-20T10:00:00.000Z',
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('buildTimeline', () => {
  it('returns empty array when both inputs are empty', () => {
    const result = buildTimeline([], [], 1);
    expect(result).toEqual([]);
  });

  it('maps stream events to StreamTimelineEntry with correct fields', () => {
    const stream: RawStreamEvent[] = [
      makeStreamEvent({
        type: 'assistant',
        timestamp: '2026-03-20T10:00:00.000Z',
        message: { content: [{ type: 'text', text: 'Hello' }] },
      }),
    ];
    const result = buildTimeline(stream, [], 42);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'stream-0',
      source: 'stream',
      teamId: 42,
      streamType: 'assistant',
    });
    expect(result[0].timestamp).toContain('2026-03-20');
  });

  it('maps hook events to HookTimelineEntry with correct fields', () => {
    const hooks: Event[] = [
      makeHookEvent({
        id: 7,
        eventType: 'SessionStart',
        createdAt: '2026-03-20T10:00:05.000Z',
        agentName: 'fleet-dev',
      }),
    ];
    const result = buildTimeline([], hooks, 10);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'event-7',
      source: 'hook',
      teamId: 10,
      eventType: 'SessionStart',
      agentName: 'fleet-dev',
    });
  });

  it('sorts entries chronologically', () => {
    const stream: RawStreamEvent[] = [
      makeStreamEvent({ type: 'assistant', timestamp: '2026-03-20T10:00:10.000Z' }),
      makeStreamEvent({ type: 'user', timestamp: '2026-03-20T10:00:01.000Z' }),
    ];
    const hooks: Event[] = [
      makeHookEvent({ id: 1, eventType: 'SessionStart', createdAt: '2026-03-20T10:00:05.000Z' }),
    ];

    const result = buildTimeline(stream, hooks, 1);

    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('stream-1');   // 10:00:01
    expect(result[1].id).toBe('event-1');     // 10:00:05
    expect(result[2].id).toBe('stream-0');   // 10:00:10
  });

  it('deduplicates hook ToolUse when stream tool_use has same name within 10s window', () => {
    const stream: RawStreamEvent[] = [
      makeStreamEvent({
        type: 'tool_use',
        timestamp: '2026-03-20T10:00:05.000Z',
        tool: { name: 'Read', input: {} },
      }),
    ];
    const hooks: Event[] = [
      makeHookEvent({
        id: 1,
        eventType: 'ToolUse',
        toolName: 'Read',
        createdAt: '2026-03-20T10:00:08.000Z',
      }),
    ];

    const result = buildTimeline(stream, hooks, 1);

    // Hook event should be dropped (deduped)
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('stream');
  });

  it('keeps hook ToolUse when tool names differ', () => {
    const stream: RawStreamEvent[] = [
      makeStreamEvent({
        type: 'tool_use',
        timestamp: '2026-03-20T10:00:05.000Z',
        tool: { name: 'Read', input: {} },
      }),
    ];
    const hooks: Event[] = [
      makeHookEvent({
        id: 1,
        eventType: 'ToolUse',
        toolName: 'Write',
        createdAt: '2026-03-20T10:00:08.000Z',
      }),
    ];

    const result = buildTimeline(stream, hooks, 1);
    expect(result).toHaveLength(2);
  });

  it('keeps hook ToolUse when outside 10s dedup window', () => {
    const stream: RawStreamEvent[] = [
      makeStreamEvent({
        type: 'tool_use',
        timestamp: '2026-03-20T10:00:00.000Z',
        tool: { name: 'Read', input: {} },
      }),
    ];
    const hooks: Event[] = [
      makeHookEvent({
        id: 1,
        eventType: 'ToolUse',
        toolName: 'Read',
        createdAt: '2026-03-20T10:00:15.000Z',  // 15s apart — outside window
      }),
    ];

    const result = buildTimeline(stream, hooks, 1);
    expect(result).toHaveLength(2);
  });

  it('does not dedup non-ToolUse hook events', () => {
    const stream: RawStreamEvent[] = [
      makeStreamEvent({
        type: 'tool_use',
        timestamp: '2026-03-20T10:00:05.000Z',
        tool: { name: 'Read', input: {} },
      }),
    ];
    const hooks: Event[] = [
      makeHookEvent({
        id: 1,
        eventType: 'SessionStart',
        toolName: 'Read',
        createdAt: '2026-03-20T10:00:05.000Z',
      }),
    ];

    const result = buildTimeline(stream, hooks, 1);
    expect(result).toHaveLength(2);
  });

  it('applies limit parameter', () => {
    const stream: RawStreamEvent[] = Array.from({ length: 50 }, (_, i) =>
      makeStreamEvent({
        type: 'assistant',
        timestamp: new Date(Date.UTC(2026, 2, 20, 10, 0, i)).toISOString(),
      }),
    );
    const hooks: Event[] = Array.from({ length: 50 }, (_, i) =>
      makeHookEvent({
        id: i + 1,
        eventType: 'SessionStart',
        createdAt: new Date(Date.UTC(2026, 2, 20, 10, 1, i)).toISOString(),
      }),
    );

    const result = buildTimeline(stream, hooks, 1, 30);
    expect(result).toHaveLength(30);
  });

  it('returns the most recent entries when merged count exceeds limit', () => {
    // Create 300 hook events (older) and 200 stream events (newer)
    // Total = 500, limit = 200 — should return the 200 most recent
    const hooks: Event[] = Array.from({ length: 300 }, (_, i) =>
      makeHookEvent({
        id: i + 1,
        eventType: 'SessionStart',
        createdAt: new Date(Date.UTC(2026, 2, 20, 8, 0, i)).toISOString(),
      }),
    );
    const stream: RawStreamEvent[] = Array.from({ length: 200 }, (_, i) =>
      makeStreamEvent({
        type: 'assistant',
        timestamp: new Date(Date.UTC(2026, 2, 20, 10, 0, i)).toISOString(),
      }),
    );

    const result = buildTimeline(stream, hooks, 1, 200);
    expect(result).toHaveLength(200);

    // The first entry in the result should be more recent than the earliest
    // hook events — i.e., the oldest 300 entries should not dominate the result.
    // Since hooks start at 08:00:00 and stream starts at 10:00:00,
    // the result tail-slice should contain all 200 stream events and the
    // most recent hook events (not the oldest hook events).
    const streamCount = result.filter((e) => e.source === 'stream').length;
    expect(streamCount).toBe(200);

    // Verify chronological order is maintained
    for (let i = 1; i < result.length; i++) {
      const prev = new Date(result[i - 1].timestamp).getTime();
      const curr = new Date(result[i].timestamp).getTime();
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });

  it('returns all entries when merged count is within limit (no regression)', () => {
    const stream: RawStreamEvent[] = Array.from({ length: 30 }, (_, i) =>
      makeStreamEvent({
        type: 'assistant',
        timestamp: new Date(Date.UTC(2026, 2, 20, 10, 0, i)).toISOString(),
      }),
    );
    const hooks: Event[] = Array.from({ length: 20 }, (_, i) =>
      makeHookEvent({
        id: i + 1,
        eventType: 'SessionStart',
        createdAt: new Date(Date.UTC(2026, 2, 20, 10, 1, i)).toISOString(),
      }),
    );

    // Total is 50, limit is 200 (default) — all entries should be returned
    const result = buildTimeline(stream, hooks, 1);
    expect(result).toHaveLength(50);

    // Verify all stream and hook entries are present
    const streamCount = result.filter((e) => e.source === 'stream').length;
    const hookCount = result.filter((e) => e.source === 'hook').length;
    expect(streamCount).toBe(30);
    expect(hookCount).toBe(20);

    // Verify chronological order
    for (let i = 1; i < result.length; i++) {
      const prev = new Date(result[i - 1].timestamp).getTime();
      const curr = new Date(result[i].timestamp).getTime();
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });

  it('defaults limit to 200', () => {
    const stream: RawStreamEvent[] = Array.from({ length: 150 }, (_, i) =>
      makeStreamEvent({
        type: 'assistant',
        timestamp: new Date(Date.UTC(2026, 2, 20, 10, 0, i)).toISOString(),
      }),
    );
    const hooks: Event[] = Array.from({ length: 100 }, (_, i) =>
      makeHookEvent({
        id: i + 1,
        eventType: 'SessionStart',
        createdAt: new Date(Date.UTC(2026, 2, 20, 10, 3, i)).toISOString(),
      }),
    );

    const result = buildTimeline(stream, hooks, 1);
    expect(result).toHaveLength(200);
  });

  it('handles missing timestamps gracefully', () => {
    const stream: RawStreamEvent[] = [
      makeStreamEvent({ type: 'assistant', timestamp: undefined }),
    ];
    const hooks: Event[] = [
      makeHookEvent({ id: 1, eventType: 'SessionStart', createdAt: '2026-03-20T10:00:00.000Z' }),
    ];

    // Should not throw
    const result = buildTimeline(stream, hooks, 1);
    expect(result).toHaveLength(2);
    // Stream entry with missing timestamp gets current time (will sort after the hook entry)
    expect(result.every((e) => e.timestamp)).toBe(true);
  });

  it('normalises hook createdAt to ISO 8601', () => {
    const hooks: Event[] = [
      makeHookEvent({ id: 1, eventType: 'SessionStart', createdAt: '2026-03-20T10:00:00Z' }),
    ];

    const result = buildTimeline([], hooks, 1);
    expect(result[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('preserves stream event subtype and message fields', () => {
    const stream: RawStreamEvent[] = [
      makeStreamEvent({
        type: 'fc',
        subtype: 'idle_nudge',
        timestamp: '2026-03-20T10:00:00.000Z',
        message: { content: [{ type: 'text', text: 'Wake up!' }] },
      }),
    ];

    const result = buildTimeline(stream, [], 1);
    expect(result).toHaveLength(1);

    const entry = result[0] as { source: 'stream'; streamType: string; subtype?: string; message?: unknown };
    expect(entry.streamType).toBe('fc');
    expect(entry.subtype).toBe('idle_nudge');
    expect(entry.message).toEqual({ content: [{ type: 'text', text: 'Wake up!' }] });
  });

  it('preserves agentName sentinel on synthetic FC stream events', () => {
    const stream: RawStreamEvent[] = [
      makeStreamEvent({
        type: 'fc',
        subtype: 'initial_prompt',
        agentName: '__fc__',
        timestamp: '2026-03-20T10:00:00.000Z',
        message: { content: [{ type: 'text', text: 'Launch prompt' }] },
      }),
      makeStreamEvent({
        type: 'fc',
        subtype: 'origin_sync',
        agentName: '__fc__',
        timestamp: '2026-03-20T10:00:01.000Z',
        message: { content: [{ type: 'text', text: 'Synced with origin' }] },
      }),
    ];

    const result = buildTimeline(stream, [], 1);
    expect(result).toHaveLength(2);

    for (const entry of result) {
      expect(entry.source).toBe('stream');
      const streamEntry = entry as { agentName?: string; streamType: string };
      expect(streamEntry.streamType).toBe('fc');
      expect(streamEntry.agentName).toBe('__fc__');
    }
  });

  it('preserves agentName sentinel on synthetic user stream events', () => {
    const stream: RawStreamEvent[] = [
      makeStreamEvent({
        type: 'user',
        agentName: '__pm__',
        timestamp: '2026-03-20T10:00:00.000Z',
        message: { content: [{ type: 'text', text: 'PM message to team' }] },
      }),
    ];

    const result = buildTimeline(stream, [], 1);
    expect(result).toHaveLength(1);

    const entry = result[0] as { agentName?: string; streamType: string };
    expect(entry.streamType).toBe('user');
    expect(entry.agentName).toBe('__pm__');
  });

  it('preserves hook event payload and agentName', () => {
    const hooks: Event[] = [
      makeHookEvent({
        id: 1,
        eventType: 'ToolError',
        toolName: 'Bash',
        agentName: 'fleet-dev',
        payload: '{"error":"command failed"}',
        createdAt: '2026-03-20T10:00:00.000Z',
      }),
    ];

    const result = buildTimeline([], hooks, 1);
    expect(result).toHaveLength(1);

    const entry = result[0] as { source: 'hook'; eventType: string; toolName?: string; agentName?: string; payload?: string };
    expect(entry.eventType).toBe('ToolError');
    expect(entry.toolName).toBe('Bash');
    expect(entry.agentName).toBe('fleet-dev');
    expect(entry.payload).toBe('{"error":"command failed"}');
  });
});
