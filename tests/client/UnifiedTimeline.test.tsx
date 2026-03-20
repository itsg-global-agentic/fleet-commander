// =============================================================================
// Fleet Commander — UnifiedTimeline Expand/Collapse Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { TimelineEntry, StreamTimelineEntry } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// jsdom polyfill — scrollIntoView is not implemented
// ---------------------------------------------------------------------------

Element.prototype.scrollIntoView = vi.fn();

// ---------------------------------------------------------------------------
// Mock useApi — return controlled timeline data
// ---------------------------------------------------------------------------

let mockEntries: TimelineEntry[] = [];

vi.mock('../../src/client/hooks/useApi', () => ({
  useApi: () => ({
    get: vi.fn().mockImplementation(() => Promise.resolve(mockEntries)),
    post: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
  }),
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

// ---------------------------------------------------------------------------
// Helper to find the expandable tool row (role="button" with aria-expanded)
// ---------------------------------------------------------------------------

function getExpandableRow() {
  // Our expandable row has role="button" with aria-expanded, while
  // the Copy button is a native <button> without aria-expanded.
  return screen.getByRole('button', { expanded: false });
}

function getExpandedRow() {
  return screen.getByRole('button', { expanded: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UnifiedTimeline — tool detail expand/collapse', () => {
  beforeEach(() => {
    mockEntries = [];
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

  it('shows detail text when tool_use entry with input is clicked', async () => {
    mockEntries = [
      makeToolUseEntry('Bash', { command: 'npm test' }, { id: 'stream-0' }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('Bash')).toBeInTheDocument();
    });

    // Click the tool row to expand
    fireEvent.click(getExpandableRow());

    await waitFor(() => {
      expect(screen.getByText('npm test')).toBeInTheDocument();
    });
  });

  it('hides detail text when clicked again (collapse)', async () => {
    mockEntries = [
      makeToolUseEntry('Bash', { command: 'npm test' }, { id: 'stream-0' }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('Bash')).toBeInTheDocument();
    });

    // Click to expand
    fireEvent.click(getExpandableRow());
    await waitFor(() => {
      expect(screen.getByText('npm test')).toBeInTheDocument();
    });

    // Click to collapse (now aria-expanded="true")
    fireEvent.click(getExpandedRow());
    await waitFor(() => {
      expect(screen.queryByText('npm test')).not.toBeInTheDocument();
    });
  });

  it('does not show expand chevron for tool_use entries without input', async () => {
    mockEntries = [
      makeToolUseEntryNoInput('Bash', { id: 'stream-0' }),
    ];
    render(<UnifiedTimeline teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('Bash')).toBeInTheDocument();
    });

    // No expandable row should exist (no aria-expanded attribute on any div)
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

    fireEvent.click(getExpandableRow());
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

    fireEvent.click(getExpandableRow());
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

    fireEvent.click(getExpandableRow());
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

    fireEvent.click(getExpandableRow());
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

    fireEvent.click(getExpandableRow());
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

    fireEvent.click(getExpandableRow());
    await waitFor(() => {
      // Should show truncated version (120 chars + '...')
      const detail = screen.getByText(/^a+\.\.\.$/);
      expect(detail).toBeInTheDocument();
      // Should not show the full 200-char string
      expect(screen.queryByText(longCommand)).not.toBeInTheDocument();
    });
  });
});
