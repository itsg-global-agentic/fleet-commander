// =============================================================================
// Fleet Commander — TeamOutput Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// ---------------------------------------------------------------------------
// Mock useApi
// ---------------------------------------------------------------------------

let mockStreamEvents: unknown[] = [];

vi.mock('../../src/client/hooks/useApi', () => ({
  useApi: () => ({
    get: vi.fn().mockImplementation(() => Promise.resolve(mockStreamEvents)),
    post: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
  }),
}));

// Stub scrollIntoView — not available in jsdom
Element.prototype.scrollIntoView = vi.fn();

// Import after mocks
import { TeamOutput } from '../../src/client/components/TeamOutput';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TeamOutput', () => {
  beforeEach(() => {
    mockStreamEvents = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows empty state when no events and team is active', async () => {
    render(<TeamOutput teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText(/No stream events yet/)).toBeInTheDocument();
    });
  });

  it('shows terminal empty state when no events and team is done', async () => {
    render(<TeamOutput teamId={1} teamStatus="done" />);
    await waitFor(() => {
      expect(screen.getByText('No session log captured.')).toBeInTheDocument();
    });
  });

  it('shows terminal empty state when no events and team is failed', async () => {
    render(<TeamOutput teamId={1} teamStatus="failed" />);
    await waitFor(() => {
      expect(screen.getByText('No session log captured.')).toBeInTheDocument();
    });
  });

  it('renders assistant messages with TL label', async () => {
    mockStreamEvents = [
      {
        type: 'assistant',
        timestamp: '2026-03-21T10:00:00Z',
        message: { content: [{ type: 'text', text: 'Starting implementation' }] },
      },
    ];
    render(<TeamOutput teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('TL')).toBeInTheDocument();
      expect(screen.getByText('Starting implementation')).toBeInTheDocument();
    });
  });

  it('renders user messages with You label', async () => {
    mockStreamEvents = [
      {
        type: 'user',
        timestamp: '2026-03-21T10:01:00Z',
        message: { content: [{ type: 'text', text: 'Please fix the tests' }] },
      },
    ];
    render(<TeamOutput teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('You')).toBeInTheDocument();
      expect(screen.getByText('Please fix the tests')).toBeInTheDocument();
    });
  });

  it('renders FC messages with FC label', async () => {
    mockStreamEvents = [
      {
        type: 'fc',
        timestamp: '2026-03-21T10:02:00Z',
        subtype: 'idle_nudge',
        message: { content: [{ type: 'text', text: 'Are you still working?' }] },
      },
    ];
    render(<TeamOutput teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('FC')).toBeInTheDocument();
      expect(screen.getByText('Are you still working?')).toBeInTheDocument();
      expect(screen.getByText('[idle]')).toBeInTheDocument();
    });
  });

  it('filters out tool_use events (non-text types)', async () => {
    mockStreamEvents = [
      {
        type: 'tool_use',
        timestamp: '2026-03-21T10:03:00Z',
        tool: { name: 'Bash' },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-21T10:04:00Z',
        message: { content: [{ type: 'text', text: 'Done running bash' }] },
      },
    ];
    render(<TeamOutput teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('Done running bash')).toBeInTheDocument();
    });
    // tool_use label should not be rendered since it has no text content to display
    expect(screen.queryByText('tool')).not.toBeInTheDocument();
  });

  it('renders Copy button', async () => {
    mockStreamEvents = [
      {
        type: 'assistant',
        timestamp: '2026-03-21T10:00:00Z',
        message: { content: [{ type: 'text', text: 'Hello' }] },
      },
    ];
    render(<TeamOutput teamId={1} teamStatus="running" />);
    await waitFor(() => {
      expect(screen.getByText('Copy')).toBeInTheDocument();
    });
  });

  it('shows thinking indicator when isThinking is true', async () => {
    mockStreamEvents = [
      {
        type: 'assistant',
        timestamp: '2026-03-21T10:00:00Z',
        message: { content: [{ type: 'text', text: 'Thinking...' }] },
      },
    ];
    render(<TeamOutput teamId={1} teamStatus="running" isThinking />);
    await waitFor(() => {
      expect(screen.getByText('thinking...')).toBeInTheDocument();
    });
  });
});
