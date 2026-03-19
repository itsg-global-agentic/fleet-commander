// =============================================================================
// Fleet Commander — EventTimeline Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { Event } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Mock useApi — return controlled event data
// ---------------------------------------------------------------------------

let mockEvents: Event[] = [];

vi.mock('../../src/client/hooks/useApi', () => ({
  useApi: () => ({
    get: vi.fn().mockImplementation(() => Promise.resolve(mockEvents)),
    post: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
  }),
}));

// Import after mocks are set up
import { EventTimeline } from '../../src/client/components/EventTimeline';

// ---------------------------------------------------------------------------
// Event factory
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 1,
    teamId: 1,
    eventType: 'ToolUse',
    sessionId: 'session-1',
    toolName: null,
    agentName: null,
    payload: null,
    createdAt: '2026-03-19T10:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventTimeline', () => {
  beforeEach(() => {
    mockEvents = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders "No events recorded yet" when there are no events', async () => {
    mockEvents = [];
    render(<EventTimeline teamId={1} />);
    await waitFor(() => {
      expect(screen.getByText('No events recorded yet')).toBeInTheDocument();
    });
  });

  it('renders event type for a ToolUse event', async () => {
    mockEvents = [makeEvent({ id: 1, eventType: 'ToolUse', toolName: 'Bash' })];
    render(<EventTimeline teamId={1} />);
    await waitFor(() => {
      expect(screen.getByText('ToolUse')).toBeInTheDocument();
      expect(screen.getByText('Bash')).toBeInTheDocument();
    });
  });

  it('renders agent name when present', async () => {
    mockEvents = [makeEvent({ id: 1, agentName: 'developer' })];
    render(<EventTimeline teamId={1} />);
    await waitFor(() => {
      expect(screen.getByText(/agent: developer/)).toBeInTheDocument();
    });
  });

  describe('ToolError error message display', () => {
    it('renders the error message from ToolError payload in red', async () => {
      const payload = JSON.stringify({ error: 'Permission denied: /etc/shadow' });
      mockEvents = [
        makeEvent({
          id: 1,
          eventType: 'ToolError',
          toolName: 'Bash',
          payload,
        }),
      ];
      render(<EventTimeline teamId={1} />);
      await waitFor(() => {
        expect(screen.getByText('ToolError')).toBeInTheDocument();
        const errorSpan = screen.getByText('Permission denied: /etc/shadow');
        expect(errorSpan).toBeInTheDocument();
        expect(errorSpan).toHaveClass('text-[#F85149]');
      });
    });

    it('does not render error text when payload is null', async () => {
      mockEvents = [
        makeEvent({
          id: 1,
          eventType: 'ToolError',
          toolName: 'Bash',
          payload: null,
        }),
      ];
      render(<EventTimeline teamId={1} />);
      await waitFor(() => {
        expect(screen.getByText('ToolError')).toBeInTheDocument();
      });
      // No extra text beyond ToolError + Bash
      const items = screen.queryAllByText(/text-\[#F85149\]/);
      expect(items).toHaveLength(0);
    });

    it('does not render error text when payload JSON is malformed', async () => {
      mockEvents = [
        makeEvent({
          id: 1,
          eventType: 'ToolError',
          toolName: 'Bash',
          payload: '{{not valid json',
        }),
      ];
      render(<EventTimeline teamId={1} />);
      await waitFor(() => {
        expect(screen.getByText('ToolError')).toBeInTheDocument();
      });
      // Should not crash, and no error text displayed
      expect(screen.queryByText('not valid json')).not.toBeInTheDocument();
    });

    it('does not render error text when payload has no error field', async () => {
      const payload = JSON.stringify({ tool: 'Bash', result: 'ok' });
      mockEvents = [
        makeEvent({
          id: 1,
          eventType: 'ToolError',
          toolName: 'Bash',
          payload,
        }),
      ];
      render(<EventTimeline teamId={1} />);
      await waitFor(() => {
        expect(screen.getByText('ToolError')).toBeInTheDocument();
      });
      expect(screen.queryByText('ok')).not.toBeInTheDocument();
    });

    it('does not render error text for non-ToolError events even if payload has error field', async () => {
      const payload = JSON.stringify({ error: 'should not appear' });
      mockEvents = [
        makeEvent({
          id: 1,
          eventType: 'ToolUse',
          toolName: 'Bash',
          payload,
        }),
      ];
      render(<EventTimeline teamId={1} />);
      await waitFor(() => {
        expect(screen.getByText('ToolUse')).toBeInTheDocument();
      });
      expect(screen.queryByText('should not appear')).not.toBeInTheDocument();
    });

    it('applies line-clamp-2 class to the error message for truncation', async () => {
      const payload = JSON.stringify({ error: 'A very long error message that could break layout' });
      mockEvents = [
        makeEvent({
          id: 1,
          eventType: 'ToolError',
          toolName: 'Bash',
          payload,
        }),
      ];
      render(<EventTimeline teamId={1} />);
      await waitFor(() => {
        const errorSpan = screen.getByText('A very long error message that could break layout');
        expect(errorSpan).toHaveClass('line-clamp-2');
      });
    });

    it('does not render error text when error field is not a string', async () => {
      const payload = JSON.stringify({ error: 42 });
      mockEvents = [
        makeEvent({
          id: 1,
          eventType: 'ToolError',
          toolName: 'Bash',
          payload,
        }),
      ];
      render(<EventTimeline teamId={1} />);
      await waitFor(() => {
        expect(screen.getByText('ToolError')).toBeInTheDocument();
      });
      expect(screen.queryByText('42')).not.toBeInTheDocument();
    });
  });
});
