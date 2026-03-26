// =============================================================================
// Fleet Commander — UnifiedTimeline Tests
// =============================================================================
// Tests for expand/collapse, error entries, polling behavior (60s fallback),
// and SSE-driven real-time appending of stream and hook events.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { TimelineEntry, StreamTimelineEntry, HookTimelineEntry } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// jsdom polyfill — scrollIntoView is not implemented
// ---------------------------------------------------------------------------

Element.prototype.scrollIntoView = vi.fn();

// ---------------------------------------------------------------------------
// Mock useApi — return controlled timeline data (stable reference)
// ---------------------------------------------------------------------------

let mockEntries: TimelineEntry[] = [];
const mockGet = vi.fn().mockImplementation(() => Promise.resolve(mockEntries));

const mockApi = {
  get: mockGet,
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
};

vi.mock('../../src/client/hooks/useApi', () => ({
  useApi: () => mockApi,
}));

// ---------------------------------------------------------------------------
// Mock useFleetSSE — capture the onEvent callback for simulating SSE events
// ---------------------------------------------------------------------------

let capturedOnEvent: ((type: string, data: unknown) => void) | undefined;

vi.mock('../../src/client/hooks/useFleetSSE', () => ({
  useFleetSSE: (_eventTypes: string | string[], onEvent: (type: string, data: unknown) => void) => {
    capturedOnEvent = onEvent;
  },
}));

// Import after mocks are set up
import { UnifiedTimeline } from '../../src/client/components/UnifiedTimeline';

// ---------------------------------------------------------------------------
// Entry factories
// ---------------------------------------------------------------------------

function makeToolUseEntry(
  toolName: string,
  input: Record<string, unknown>,
  overrides: Partial<StreamTimelineEntry> = {},
): StreamTimelineEntry {
  return {
    id: `stream-${Math.random().toString(36).slice(2)}`,
    source: 'stream',
    timestamp: '2026-03-20T10:00:00.000Z',
    teamId: 1,
    streamType: 'tool_use',
    tool: { name: toolName, input },
    ...overrides,
  };
}

function makeToolUseEntryNoInput(
  toolName: string,
  overrides: Partial<StreamTimelineEntry> = {},
): StreamTimelineEntry {
  return {
    id: `stream-${Math.random().toString(36).slice(2)}`,
    source: 'stream',
    timestamp: '2026-03-20T10:00:00.000Z',
    teamId: 1,
    streamType: 'tool_use',
    tool: { name: toolName },
    ...overrides,
  };
}

function makeStreamEntry(
  streamType: string,
  overrides: Partial<StreamTimelineEntry> = {},
): StreamTimelineEntry {
  return {
    id: `stream-${Math.random().toString(36).slice(2)}`,
    source: 'stream',
    timestamp: '2026-03-20T10:00:00.000Z',
    teamId: 1,
    streamType,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper to find the expandable badge (role="button" with aria-expanded)
// ---------------------------------------------------------------------------

function getExpandableBadge() {
  // Our expandable badge has role="button" with aria-expanded, while
  // the Copy button is a native <button> without aria-expanded.
  return screen.getByRole('button', { expanded: false });
}

function getExpandedBadge() {
  return screen.getByRole('button', { expanded: true });
}

// ---------------------------------------------------------------------------
// Tests — tool detail expand/collapse
// ---------------------------------------------------------------------------

describe('UnifiedTimeline — tool detail expand/collapse', () => {
  beforeEach(() => {
    mockEntries = [];
    mockGet.mockImplementation(() => Promise.resolve(mockEntries));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders Bash tool badge without detail when collapsed', async () => {
    mockEntries = [
      makeToolUseEntry('Bash', { command: 'npm test' }, { id: 'stream-0' }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('Bash')).toBeInTheDocument();
    });
    // Detail should not be visible initially
    expect(screen.queryByText('npm test')).not.toBeInTheDocument();
  });

  it('shows detail text when tool badge is clicked', async () => {
    mockEntries = [
      makeToolUseEntry('Bash', { command: 'npm test' }, { id: 'stream-0' }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('Bash')).toBeInTheDocument();
    });

    // Click the tool badge to expand
    fireEvent.click(getExpandableBadge());

    await waitFor(() => {
      expect(screen.getByText('npm test')).toBeInTheDocument();
    });
  });

  it('hides detail text when badge is clicked again (collapse)', async () => {
    mockEntries = [
      makeToolUseEntry('Bash', { command: 'npm test' }, { id: 'stream-0' }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('Bash')).toBeInTheDocument();
    });

    // Click to expand
    fireEvent.click(getExpandableBadge());
    await waitFor(() => {
      expect(screen.getByText('npm test')).toBeInTheDocument();
    });

    // Click to collapse (now aria-expanded="true")
    fireEvent.click(getExpandedBadge());
    await waitFor(() => {
      expect(screen.queryByText('npm test')).not.toBeInTheDocument();
    });
  });

  it('does not make badge expandable for tool_use entries without input', async () => {
    mockEntries = [
      makeToolUseEntryNoInput('Bash', { id: 'stream-0' }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('Bash')).toBeInTheDocument();
    });

    // Badge should exist but not be expandable (no aria-expanded attribute)
    expect(screen.queryByRole('button', { expanded: false })).not.toBeInTheDocument();
  });

  it('shows file_path for Read tool', async () => {
    mockEntries = [
      makeToolUseEntry('Read', { file_path: '/src/index.ts' }, { id: 'stream-0' }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('Read')).toBeInTheDocument();
    });

    fireEvent.click(getExpandableBadge());
    await waitFor(() => {
      expect(screen.getByText('/src/index.ts')).toBeInTheDocument();
    });
  });

  it('shows pattern for Grep tool', async () => {
    mockEntries = [
      makeToolUseEntry('Grep', { pattern: 'TODO', path: '/src' }, { id: 'stream-0' }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('Grep')).toBeInTheDocument();
    });

    fireEvent.click(getExpandableBadge());
    await waitFor(() => {
      expect(screen.getByText('/TODO/ in /src')).toBeInTheDocument();
    });
  });

  it('shows pattern for Glob tool', async () => {
    mockEntries = [
      makeToolUseEntry('Glob', { pattern: '**/*.ts' }, { id: 'stream-0' }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('Glob')).toBeInTheDocument();
    });

    fireEvent.click(getExpandableBadge());
    await waitFor(() => {
      expect(screen.getByText('**/*.ts')).toBeInTheDocument();
    });
  });

  it('shows file_path and edit details for Edit tool', async () => {
    mockEntries = [
      makeToolUseEntry('Edit', {
        file_path: '/src/app.ts',
        old_string: 'foo',
        new_string: 'bar',
      }, { id: 'stream-0' }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('Edit')).toBeInTheDocument();
    });

    fireEvent.click(getExpandableBadge());
    await waitFor(() => {
      expect(screen.getByText(/\/src\/app\.ts/)).toBeInTheDocument();
      expect(screen.getByText(/foo -> bar/)).toBeInTheDocument();
    });
  });

  it('shows file_path for Write tool', async () => {
    mockEntries = [
      makeToolUseEntry('Write', { file_path: '/src/new-file.ts' }, { id: 'stream-0' }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('Write')).toBeInTheDocument();
    });

    fireEvent.click(getExpandableBadge());
    await waitFor(() => {
      expect(screen.getByText('/src/new-file.ts')).toBeInTheDocument();
    });
  });

  it('truncates long Bash commands', async () => {
    const longCommand = 'a'.repeat(200);
    mockEntries = [
      makeToolUseEntry('Bash', { command: longCommand }, { id: 'stream-0' }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('Bash')).toBeInTheDocument();
    });

    fireEvent.click(getExpandableBadge());
    await waitFor(() => {
      // Should show truncated version (120 chars + '...')
      const detail = screen.getByText(/^a+\.\.\.$/);
      expect(detail).toBeInTheDocument();
      // Should not show the full 200-char string
      expect(screen.queryByText(longCommand)).not.toBeInTheDocument();
    });
  });

  it('expands tool badge via keyboard Enter key', async () => {
    mockEntries = [
      makeToolUseEntry('Bash', { command: 'npm test' }, { id: 'stream-0' }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('Bash')).toBeInTheDocument();
    });

    // Press Enter on the badge to expand
    fireEvent.keyDown(getExpandableBadge(), { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByText('npm test')).toBeInTheDocument();
    });
  });

  it('expands tool badge via keyboard Space key', async () => {
    mockEntries = [
      makeToolUseEntry('Bash', { command: 'npm test' }, { id: 'stream-0' }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('Bash')).toBeInTheDocument();
    });

    // Press Space on the badge to expand
    fireEvent.keyDown(getExpandableBadge(), { key: ' ' });
    await waitFor(() => {
      expect(screen.getByText('npm test')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Hook error entry factory
// ---------------------------------------------------------------------------

function makeErrorHookEntry(
  eventType: string,
  payload: string | undefined,
  overrides: Partial<HookTimelineEntry> = {},
): HookTimelineEntry {
  return {
    id: `hook-${Math.random().toString(36).slice(2)}`,
    source: 'hook',
    timestamp: '2026-03-20T10:00:00.000Z',
    teamId: 1,
    eventType,
    payload,
    ...overrides,
  };
}

describe('UnifiedTimeline — error entry collapse/expand', () => {
  beforeEach(() => {
    mockEntries = [];
    mockGet.mockImplementation(() => Promise.resolve(mockEntries));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders ToolError badge collapsed by default (no error text visible)', async () => {
    mockEntries = [
      makeErrorHookEntry('ToolError', JSON.stringify({ error: 'Something broke' }), { id: 'hook-0' }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('ToolError')).toBeInTheDocument();
    });

    // Error message should NOT be visible when collapsed
    expect(screen.queryByText('Something broke')).not.toBeInTheDocument();
  });

  it('shows error message when error badge is clicked', async () => {
    mockEntries = [
      makeErrorHookEntry('ToolError', JSON.stringify({ error: 'Something broke' }), { id: 'hook-0' }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('ToolError')).toBeInTheDocument();
    });

    // Click the error badge to expand
    fireEvent.click(getExpandableBadge());
    await waitFor(() => {
      expect(screen.getByText('Something broke')).toBeInTheDocument();
    });
  });

  it('hides error message when error badge is clicked again', async () => {
    mockEntries = [
      makeErrorHookEntry('ToolError', JSON.stringify({ error: 'Something broke' }), { id: 'hook-0' }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('ToolError')).toBeInTheDocument();
    });

    // Expand
    fireEvent.click(getExpandableBadge());
    await waitFor(() => {
      expect(screen.getByText('Something broke')).toBeInTheDocument();
    });

    // Collapse
    fireEvent.click(getExpandedBadge());
    await waitFor(() => {
      expect(screen.queryByText('Something broke')).not.toBeInTheDocument();
    });
  });

  it('renders StopFailure error badge collapsed by default', async () => {
    mockEntries = [
      makeErrorHookEntry('StopFailure', JSON.stringify({ error: 'Process killed' }), { id: 'hook-0' }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('StopFailure')).toBeInTheDocument();
    });

    // Error message should NOT be visible when collapsed
    expect(screen.queryByText('Process killed')).not.toBeInTheDocument();
  });

  it('does not make error badge expandable when no error payload exists', async () => {
    mockEntries = [
      makeErrorHookEntry('ToolError', undefined, { id: 'hook-0' }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('ToolError')).toBeInTheDocument();
    });

    // Badge should exist but not be expandable (no aria-expanded attribute)
    expect(screen.queryByRole('button', { expanded: false })).not.toBeInTheDocument();
  });

  it('expands error badge via keyboard Enter key', async () => {
    mockEntries = [
      makeErrorHookEntry('ToolError', JSON.stringify({ error: 'Something broke' }), { id: 'hook-0' }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('ToolError')).toBeInTheDocument();
    });

    // Press Enter on the error badge to expand
    fireEvent.keyDown(getExpandableBadge(), { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByText('Something broke')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Polling behavior tests — terminal state + 60-second fixed interval
// ---------------------------------------------------------------------------

describe('UnifiedTimeline — polling behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockEntries = [];
    mockGet.mockReset();
    mockGet.mockImplementation(() => Promise.resolve(mockEntries));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not set up polling interval when teamStatus is done', async () => {
    render(<UnifiedTimeline teamId={1} teamStatus="done" />);

    // Let the initial fetch resolve
    await vi.advanceTimersByTimeAsync(0);

    const initialCalls = mockGet.mock.calls.length;
    expect(initialCalls).toBe(1); // Just the initial fetch

    // Advance time well past any polling interval
    await vi.advanceTimersByTimeAsync(120000);

    // No additional calls should have been made
    expect(mockGet.mock.calls.length).toBe(initialCalls);
  });

  it('does not set up polling interval when teamStatus is failed', async () => {
    render(<UnifiedTimeline teamId={1} teamStatus="failed" />);

    // Let the initial fetch resolve
    await vi.advanceTimersByTimeAsync(0);

    const initialCalls = mockGet.mock.calls.length;
    expect(initialCalls).toBe(1); // Just the initial fetch

    // Advance time well past any polling interval
    await vi.advanceTimersByTimeAsync(120000);

    // No additional calls should have been made
    expect(mockGet.mock.calls.length).toBe(initialCalls);
  });

  it('polls at fixed 60-second intervals for running teams', async () => {
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);

    // Initial fetch fires immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGet.mock.calls.length).toBe(1);

    // Before 60s — no additional poll
    await vi.advanceTimersByTimeAsync(59999);
    expect(mockGet.mock.calls.length).toBe(1);

    // At 60s — fallback poll fires
    await vi.advanceTimersByTimeAsync(1);
    expect(mockGet.mock.calls.length).toBe(2);

    // At 120s — another fallback poll fires (fixed interval, not backoff)
    await vi.advanceTimersByTimeAsync(60000);
    expect(mockGet.mock.calls.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// SSE-driven real-time updates
// ---------------------------------------------------------------------------

describe('UnifiedTimeline — SSE-driven updates', () => {
  beforeEach(() => {
    mockEntries = [];
    capturedOnEvent = undefined;
    mockGet.mockReset();
    mockGet.mockImplementation(() => Promise.resolve(mockEntries));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('appends a stream entry via team_output SSE event', async () => {
    // Start with one initial entry so the timeline renders
    mockEntries = [
      makeStreamEntry('assistant', {
        id: 'stream-0',
        message: { content: [{ type: 'text', text: 'Hello from TL' }] },
      }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);

    // Wait for initial fetch to render
    await waitFor(() => {
      expect(screen.getByText('Hello from TL')).toBeInTheDocument();
    });

    // Simulate an SSE team_output event with a tool_use payload
    expect(capturedOnEvent).toBeDefined();
    act(() => {
      capturedOnEvent!('team_output', {
        team_id: 1,
        event: {
          type: 'tool_use',
          timestamp: '2026-03-20T10:01:00.000Z',
          tool: { name: 'Bash', input: { command: 'echo hello' } },
        },
      });
    });

    // The new entry should appear in the timeline
    await waitFor(() => {
      expect(screen.getByText('Bash')).toBeInTheDocument();
    });
  });

  it('appends a hook entry via team_event SSE event', async () => {
    // Start with one initial entry so the timeline renders
    mockEntries = [
      makeStreamEntry('assistant', {
        id: 'stream-0',
        message: { content: [{ type: 'text', text: 'Hello from TL' }] },
      }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);

    // Wait for initial fetch to render
    await waitFor(() => {
      expect(screen.getByText('Hello from TL')).toBeInTheDocument();
    });

    // Simulate an SSE team_event (hook event)
    expect(capturedOnEvent).toBeDefined();
    act(() => {
      capturedOnEvent!('team_event', {
        team_id: 1,
        event_type: 'SessionStart',
        event_id: 42,
        timestamp: '2026-03-20T10:01:00.000Z',
        agent_name: 'team-lead',
      });
    });

    // The hook entry should appear
    await waitFor(() => {
      expect(screen.getByText('SessionStart')).toBeInTheDocument();
    });
  });

  it('ignores SSE events for different team_id', async () => {
    mockEntries = [
      makeStreamEntry('assistant', {
        id: 'stream-0',
        message: { content: [{ type: 'text', text: 'Hello from TL' }] },
      }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);

    await waitFor(() => {
      expect(screen.getByText('Hello from TL')).toBeInTheDocument();
    });

    // Send SSE event for a DIFFERENT team
    act(() => {
      capturedOnEvent!('team_output', {
        team_id: 999,
        event: {
          type: 'tool_use',
          timestamp: '2026-03-20T10:01:00.000Z',
          tool: { name: 'Bash', input: { command: 'echo wrong team' } },
        },
      });
    });

    // Bash entry should NOT appear
    expect(screen.queryByText('Bash')).not.toBeInTheDocument();
  });

  it('deduplicates entries with same ID via APPEND_HOOK', async () => {
    // Initial fetch returns one hook entry
    const hookEntry = makeErrorHookEntry('ToolUse', undefined, { id: 'event-100', eventType: 'ToolUse', toolName: 'Bash' });
    mockEntries = [hookEntry];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);

    await waitFor(() => {
      expect(screen.getByText('ToolUse')).toBeInTheDocument();
    });

    // Simulate an SSE team_event with the SAME event_id (so id='event-100')
    act(() => {
      capturedOnEvent!('team_event', {
        team_id: 1,
        event_type: 'ToolUse',
        event_id: 100,
        timestamp: '2026-03-20T10:01:00.000Z',
        tool_name: 'Bash',
      });
    });

    // Should still show exactly one ToolUse entry (deduped by ID)
    const toolUseElements = screen.getAllByText('ToolUse');
    expect(toolUseElements.length).toBe(1);
  });

  it('filters out noise stream types from SSE events', async () => {
    mockEntries = [
      makeStreamEntry('assistant', {
        id: 'stream-0',
        message: { content: [{ type: 'text', text: 'Hello from TL' }] },
      }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);

    await waitFor(() => {
      expect(screen.getByText('Hello from TL')).toBeInTheDocument();
    });

    // Send noise stream types — these should be silently dropped
    act(() => {
      capturedOnEvent!('team_output', {
        team_id: 1,
        event: { type: 'content_block_delta', timestamp: '2026-03-20T10:01:00.000Z' },
      });
      capturedOnEvent!('team_output', {
        team_id: 1,
        event: { type: 'stream_event', timestamp: '2026-03-20T10:01:01.000Z' },
      });
    });

    // The noise types should not produce any visible new entries
    // Component should still render cleanly with only the initial entry
    expect(screen.getByText('Hello from TL')).toBeInTheDocument();
  });

  it('extracts tool_use blocks from assistant SSE events', async () => {
    mockEntries = [];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);

    await waitFor(() => {
      // Component should show empty state initially
      expect(screen.getByText(/No events yet/)).toBeInTheDocument();
    });

    // Send an assistant event that contains a tool_use content block
    act(() => {
      capturedOnEvent!('team_output', {
        team_id: 1,
        event: {
          type: 'assistant',
          timestamp: '2026-03-20T10:01:00.000Z',
          message: {
            content: [
              { type: 'text', text: 'Let me check that file.' },
              { type: 'tool_use', name: 'Read', input: { file_path: '/src/main.ts' } },
            ],
          },
          agentName: 'team-lead',
        },
      });
    });

    // Should render both the text content and the extracted tool_use entry
    await waitFor(() => {
      expect(screen.getByText('Let me check that file.')).toBeInTheDocument();
      expect(screen.getByText('Read')).toBeInTheDocument();
    });
  });
});
