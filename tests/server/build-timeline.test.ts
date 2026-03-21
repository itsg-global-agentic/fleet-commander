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

  it('defaults limit to 500', () => {
    const stream: RawStreamEvent[] = Array.from({ length: 300 }, (_, i) =>
      makeStreamEvent({
        type: 'assistant',
        timestamp: new Date(Date.UTC(2026, 2, 20, 10, 0, i)).toISOString(),
      }),
    );
    const hooks: Event[] = Array.from({ length: 300 }, (_, i) =>
      makeHookEvent({
        id: i + 1,
        eventType: 'SessionStart',
        createdAt: new Date(Date.UTC(2026, 2, 20, 10, 6, i)).toISOString(),
      }),
    );

    const result = buildTimeline(stream, hooks, 1);
    expect(result).toHaveLength(500);
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

  it('preserves stream events (including early TL messages) when many hook events dominate with limit=500', () => {
    // Simulate a prolonged session: 300 hook events (tool uses during heavy work)
    // interleaved with 50 stream events (including early TL messages and FC prompts).
    // With limit=500, all 350 entries should be preserved.
    const stream: RawStreamEvent[] = Array.from({ length: 50 }, (_, i) =>
      makeStreamEvent({
        type: i < 5 ? 'fc' : i < 10 ? 'user' : 'assistant',
        subtype: i < 5 ? 'initial_prompt' : undefined,
        agentName: i < 5 ? '__fc__' : i < 10 ? '__pm__' : 'team-lead',
        timestamp: new Date(Date.UTC(2026, 2, 20, 8, 0, i)).toISOString(),
        message: { content: [{ type: 'text', text: `Stream message ${i}` }] },
      }),
    );

    const hooks: Event[] = Array.from({ length: 300 }, (_, i) =>
      makeHookEvent({
        id: i + 1,
        eventType: 'ToolUse',
        toolName: `Tool${i % 20}`,
        agentName: 'developer',
        createdAt: new Date(Date.UTC(2026, 2, 20, 9, 0, i)).toISOString(),
      }),
    );

    const result = buildTimeline(stream, hooks, 1, 500);

    // Total is 350 (50 stream + 300 hook), well within limit=500
    expect(result).toHaveLength(350);

    // All 50 stream events must be present — none should be evicted
    const streamCount = result.filter((e) => e.source === 'stream').length;
    expect(streamCount).toBe(50);

    // Early FC prompt events (the very first entries) must survive
    const fcPrompts = result.filter(
      (e) => e.source === 'stream' && (e as any).streamType === 'fc' && (e as any).subtype === 'initial_prompt',
    );
    expect(fcPrompts.length).toBe(5);

    // Early PM (user) messages must survive
    const pmMessages = result.filter(
      (e) => e.source === 'stream' && (e as any).streamType === 'user',
    );
    expect(pmMessages.length).toBe(5);

    // Verify chronological order is maintained
    for (let i = 1; i < result.length; i++) {
      const prev = new Date(result[i - 1].timestamp).getTime();
      const curr = new Date(result[i].timestamp).getTime();
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });

  it('preserves tool.input on stream tool_use entries', () => {
    const bashInput = { command: 'ls -la', description: 'List files' };
    const stream: RawStreamEvent[] = [
      makeStreamEvent({
        type: 'tool_use',
        timestamp: '2026-03-20T10:00:00.000Z',
        tool: { name: 'Bash', input: bashInput },
      }),
    ];

    const result = buildTimeline(stream, [], 1);
    expect(result).toHaveLength(1);

    const entry = result[0] as { source: 'stream'; tool?: { name?: string; input?: unknown } };
    expect(entry.source).toBe('stream');
    expect(entry.tool).toBeDefined();
    expect(entry.tool!.name).toBe('Bash');
    expect(entry.tool!.input).toEqual(bashInput);
  });

  it('preserves tool.input for various tool types through the pipeline', () => {
    const readInput = { file_path: '/src/index.ts' };
    const editInput = { file_path: '/src/app.ts', old_string: 'foo', new_string: 'bar' };
    const grepInput = { pattern: 'TODO', path: '/src' };
    const stream: RawStreamEvent[] = [
      makeStreamEvent({
        type: 'tool_use',
        timestamp: '2026-03-20T10:00:00.000Z',
        tool: { name: 'Read', input: readInput },
      }),
      makeStreamEvent({
        type: 'tool_use',
        timestamp: '2026-03-20T10:00:01.000Z',
        tool: { name: 'Edit', input: editInput },
      }),
      makeStreamEvent({
        type: 'tool_use',
        timestamp: '2026-03-20T10:00:02.000Z',
        tool: { name: 'Grep', input: grepInput },
      }),
    ];

    const result = buildTimeline(stream, [], 1);
    expect(result).toHaveLength(3);

    const entries = result as Array<{ tool?: { name?: string; input?: unknown } }>;
    expect(entries[0].tool!.input).toEqual(readInput);
    expect(entries[1].tool!.input).toEqual(editInput);
    expect(entries[2].tool!.input).toEqual(grepInput);
  });

  it('evicts early stream events when combined count exceeds a low limit', () => {
    // Demonstrate that with the old limit=200, early stream events would be lost
    // when hook events dominate. With limit=500, they survive.
    const earlyStream: RawStreamEvent[] = Array.from({ length: 20 }, (_, i) =>
      makeStreamEvent({
        type: 'fc',
        subtype: 'initial_prompt',
        agentName: '__fc__',
        timestamp: new Date(Date.UTC(2026, 2, 20, 7, 0, i)).toISOString(),
        message: { content: [{ type: 'text', text: `Early prompt ${i}` }] },
      }),
    );

    const hooks: Event[] = Array.from({ length: 250 }, (_, i) =>
      makeHookEvent({
        id: i + 1,
        eventType: 'ToolUse',
        toolName: `Tool${i}`,
        agentName: 'developer',
        createdAt: new Date(Date.UTC(2026, 2, 20, 9, 0, i)).toISOString(),
      }),
    );

    // With limit=200: only 200 most recent — early stream events get evicted
    const resultLow = buildTimeline(earlyStream, hooks, 1, 200);
    expect(resultLow).toHaveLength(200);
    const earlyFcLow = resultLow.filter(
      (e) => e.source === 'stream' && (e as any).subtype === 'initial_prompt',
    );
    // All 20 early stream events are older than the 250 hooks,
    // so slice(-200) drops the 70 oldest entries (20 streams + 50 hooks)
    expect(earlyFcLow.length).toBe(0);

    // With limit=500: all 270 entries fit — early stream events survive
    const resultHigh = buildTimeline(earlyStream, hooks, 1, 500);
    expect(resultHigh).toHaveLength(270);
    const earlyFcHigh = resultHigh.filter(
      (e) => e.source === 'stream' && (e as any).subtype === 'initial_prompt',
    );
    expect(earlyFcHigh.length).toBe(20);
  });

  it('excludes noise stream types (stream_event, content_block_*) from timeline output', () => {
    const stream: RawStreamEvent[] = [
      // Legitimate events that should appear
      makeStreamEvent({ type: 'assistant', timestamp: '2026-03-20T10:00:00.000Z' }),
      makeStreamEvent({ type: 'tool_use', timestamp: '2026-03-20T10:00:01.000Z', tool: { name: 'Read' } }),
      // Noise types that should be filtered out
      makeStreamEvent({ type: 'stream_event', timestamp: '2026-03-20T10:00:02.000Z' }),
      makeStreamEvent({ type: 'content_block_start', timestamp: '2026-03-20T10:00:03.000Z' }),
      makeStreamEvent({ type: 'content_block_delta', timestamp: '2026-03-20T10:00:04.000Z' }),
      makeStreamEvent({ type: 'content_block_stop', timestamp: '2026-03-20T10:00:05.000Z' }),
      // Another legitimate event
      makeStreamEvent({ type: 'result', timestamp: '2026-03-20T10:00:06.000Z' }),
    ];

    const result = buildTimeline(stream, [], 1);

    // Only 3 legitimate events should remain (assistant, tool_use, result)
    expect(result).toHaveLength(3);
    const types = result.map((e) => (e as any).streamType);
    expect(types).toEqual(['assistant', 'tool_use', 'result']);

    // Verify none of the noise types leaked through
    expect(types).not.toContain('stream_event');
    expect(types).not.toContain('content_block_start');
    expect(types).not.toContain('content_block_delta');
    expect(types).not.toContain('content_block_stop');
  });

  it('reindexes stream entry IDs after noise filtering', () => {
    const stream: RawStreamEvent[] = [
      makeStreamEvent({ type: 'assistant', timestamp: '2026-03-20T10:00:00.000Z' }),
      makeStreamEvent({ type: 'stream_event', timestamp: '2026-03-20T10:00:01.000Z' }),
      makeStreamEvent({ type: 'tool_use', timestamp: '2026-03-20T10:00:02.000Z', tool: { name: 'Read' } }),
    ];

    const result = buildTimeline(stream, [], 1);

    // After filtering, IDs should be contiguous (stream-0, stream-1)
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('stream-0');
    expect(result[1].id).toBe('stream-1');
  });

  // ===========================================================================
  // Tool-use extraction from assistant events (Issue #320)
  // ===========================================================================

  describe('tool_use extraction from assistant events', () => {
    it('extracts tool_use content blocks from assistant events into separate entries', () => {
      const stream: RawStreamEvent[] = [
        makeStreamEvent({
          type: 'assistant',
          timestamp: '2026-03-20T10:00:00.000Z',
          message: {
            content: [
              { type: 'tool_use', name: 'Read', input: { file_path: '/src/index.ts' } },
            ],
          },
        }),
      ];

      const result = buildTimeline(stream, [], 1);

      // Should have the original assistant entry + 1 extracted tool_use entry
      expect(result).toHaveLength(2);

      const extracted = result.find((e) => e.id === 'stream-0-tool-0');
      expect(extracted).toBeDefined();
      expect(extracted!.source).toBe('stream');
      const streamEntry = extracted as any;
      expect(streamEntry.streamType).toBe('tool_use');
      expect(streamEntry.tool).toEqual({ name: 'Read', input: { file_path: '/src/index.ts' } });
    });

    it('sets streamType to tool_use and populates tool field on extracted entries', () => {
      const stream: RawStreamEvent[] = [
        makeStreamEvent({
          type: 'assistant',
          timestamp: '2026-03-20T10:00:00.000Z',
          message: {
            content: [
              { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
            ],
          },
        }),
      ];

      const result = buildTimeline(stream, [], 1);
      const extracted = result.find((e) => e.id === 'stream-0-tool-0') as any;

      expect(extracted).toBeDefined();
      expect(extracted.streamType).toBe('tool_use');
      expect(extracted.tool.name).toBe('Bash');
      expect(extracted.tool.input).toEqual({ command: 'ls -la' });
    });

    it('inherits agentName from parent assistant event', () => {
      const stream: RawStreamEvent[] = [
        makeStreamEvent({
          type: 'assistant',
          timestamp: '2026-03-20T10:00:00.000Z',
          agentName: 'developer',
          message: {
            content: [
              { type: 'tool_use', name: 'Read', input: { file_path: '/src/app.ts' } },
            ],
          },
        }),
      ];

      const result = buildTimeline(stream, [], 1);
      const extracted = result.find((e) => e.id === 'stream-0-tool-0') as any;

      expect(extracted).toBeDefined();
      expect(extracted.agentName).toBe('developer');
    });

    it('preserves text entry AND extracts tool entries from mixed content', () => {
      const stream: RawStreamEvent[] = [
        makeStreamEvent({
          type: 'assistant',
          timestamp: '2026-03-20T10:00:00.000Z',
          message: {
            content: [
              { type: 'text', text: 'I will read the file now.' },
              { type: 'tool_use', name: 'Read', input: { file_path: '/src/index.ts' } },
            ],
          },
        }),
      ];

      const result = buildTimeline(stream, [], 1);

      // Original assistant entry with text + extracted tool_use entry
      expect(result).toHaveLength(2);

      // Original assistant entry should remain with its message content intact
      const parent = result.find((e) => e.id === 'stream-0') as any;
      expect(parent).toBeDefined();
      expect(parent.streamType).toBe('assistant');
      expect(parent.message.content).toHaveLength(2);
      expect(parent.message.content[0].text).toBe('I will read the file now.');

      // Extracted tool_use entry (at content index 1 because text block is at index 0)
      const extracted = result.find((e) => e.id === 'stream-0-tool-1') as any;
      expect(extracted).toBeDefined();
      expect(extracted.streamType).toBe('tool_use');
      expect(extracted.tool.name).toBe('Read');
    });

    it('does not extract from assistant events with no tool_use content', () => {
      const stream: RawStreamEvent[] = [
        makeStreamEvent({
          type: 'assistant',
          timestamp: '2026-03-20T10:00:00.000Z',
          message: {
            content: [
              { type: 'text', text: 'Just a plain text response.' },
            ],
          },
        }),
      ];

      const result = buildTimeline(stream, [], 1);

      // Only the original assistant entry, no extracted entries
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('stream-0');
    });

    it('extracts multiple tool_use blocks from a single assistant event', () => {
      const stream: RawStreamEvent[] = [
        makeStreamEvent({
          type: 'assistant',
          timestamp: '2026-03-20T10:00:00.000Z',
          message: {
            content: [
              { type: 'text', text: 'Let me read and edit.' },
              { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
              { type: 'tool_use', name: 'Edit', input: { file_path: '/b.ts', old_string: 'x', new_string: 'y' } },
            ],
          },
        }),
      ];

      const result = buildTimeline(stream, [], 1);

      // 1 parent assistant + 2 extracted tool_use entries
      expect(result).toHaveLength(3);

      const tool0 = result.find((e) => e.id === 'stream-0-tool-1') as any;
      const tool1 = result.find((e) => e.id === 'stream-0-tool-2') as any;

      expect(tool0).toBeDefined();
      expect(tool0.tool.name).toBe('Read');

      expect(tool1).toBeDefined();
      expect(tool1.tool.name).toBe('Edit');
    });

    it('deduplicates extracted stream tool_use entries against hook ToolUse events', () => {
      const stream: RawStreamEvent[] = [
        makeStreamEvent({
          type: 'assistant',
          timestamp: '2026-03-20T10:00:05.000Z',
          message: {
            content: [
              { type: 'tool_use', name: 'Read', input: { file_path: '/src/index.ts' } },
            ],
          },
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

      // Hook event should be deduped: the extracted stream tool_use entry for
      // 'Read' at T+5s matches the hook ToolUse for 'Read' at T+8s (within 10s window).
      const hookEntries = result.filter((e) => e.source === 'hook');
      expect(hookEntries).toHaveLength(0);

      // Should have the parent assistant + the extracted tool_use
      const streamEntries = result.filter((e) => e.source === 'stream');
      expect(streamEntries).toHaveLength(2);
    });

    it('generates unique and deterministic IDs for extracted entries', () => {
      const stream: RawStreamEvent[] = [
        makeStreamEvent({
          type: 'assistant',
          timestamp: '2026-03-20T10:00:00.000Z',
          message: {
            content: [
              { type: 'tool_use', name: 'Read', input: {} },
              { type: 'tool_use', name: 'Write', input: {} },
            ],
          },
        }),
        makeStreamEvent({
          type: 'assistant',
          timestamp: '2026-03-20T10:00:01.000Z',
          message: {
            content: [
              { type: 'tool_use', name: 'Bash', input: {} },
            ],
          },
        }),
      ];

      const result = buildTimeline(stream, [], 1);

      // Collect all extracted entry IDs
      const extractedIds = result
        .filter((e) => e.id.includes('-tool-'))
        .map((e) => e.id);

      // 3 extracted entries total
      expect(extractedIds).toHaveLength(3);

      // IDs should be deterministic based on parent index and block index
      expect(extractedIds).toContain('stream-0-tool-0');
      expect(extractedIds).toContain('stream-0-tool-1');
      expect(extractedIds).toContain('stream-1-tool-0');

      // All IDs must be unique
      const uniqueIds = new Set(extractedIds);
      expect(uniqueIds.size).toBe(extractedIds.length);

      // Running the same input produces the same IDs (deterministic)
      const result2 = buildTimeline(stream, [], 1);
      const extractedIds2 = result2
        .filter((e) => e.id.includes('-tool-'))
        .map((e) => e.id);
      expect(extractedIds2).toEqual(extractedIds);
    });

    it('does not extract from non-assistant stream events', () => {
      const stream: RawStreamEvent[] = [
        makeStreamEvent({
          type: 'user',
          timestamp: '2026-03-20T10:00:00.000Z',
          message: {
            content: [
              { type: 'tool_use', name: 'Read', input: {} },
            ],
          },
        }),
      ];

      const result = buildTimeline(stream, [], 1);

      // Only the original user entry, no extraction
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('stream-0');
    });

    it('skips tool_use blocks without a name', () => {
      const stream: RawStreamEvent[] = [
        makeStreamEvent({
          type: 'assistant',
          timestamp: '2026-03-20T10:00:00.000Z',
          message: {
            content: [
              { type: 'tool_use', input: { data: 'test' } },  // no name
              { type: 'tool_use', name: 'Read', input: {} },    // has name
            ],
          },
        }),
      ];

      const result = buildTimeline(stream, [], 1);

      // Only 1 extracted (the one with a name), plus the parent
      expect(result).toHaveLength(2);
      const extracted = result.filter((e) => e.id.includes('-tool-'));
      expect(extracted).toHaveLength(1);
      expect((extracted[0] as any).tool.name).toBe('Read');
    });

    it('handles assistant event with empty content array', () => {
      const stream: RawStreamEvent[] = [
        makeStreamEvent({
          type: 'assistant',
          timestamp: '2026-03-20T10:00:00.000Z',
          message: { content: [] },
        }),
      ];

      const result = buildTimeline(stream, [], 1);

      // Only the original entry, no extraction
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('stream-0');
    });

    it('handles assistant event with undefined message', () => {
      const stream: RawStreamEvent[] = [
        makeStreamEvent({
          type: 'assistant',
          timestamp: '2026-03-20T10:00:00.000Z',
          message: undefined,
        }),
      ];

      const result = buildTimeline(stream, [], 1);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('stream-0');
    });

    it('extracted entries have same timestamp as parent for correct sort order', () => {
      const parentTs = '2026-03-20T10:00:05.000Z';
      const stream: RawStreamEvent[] = [
        makeStreamEvent({
          type: 'assistant',
          timestamp: parentTs,
          message: {
            content: [
              { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } },
            ],
          },
        }),
      ];

      const result = buildTimeline(stream, [], 1);
      const extracted = result.find((e) => e.id === 'stream-0-tool-0')!;

      expect(extracted.timestamp).toBe(new Date(parentTs).toISOString());
    });
  });
});
