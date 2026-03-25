// =============================================================================
// Fleet Commander — useSSE Hook Tests
// =============================================================================
// Tests for the useSSE hook: EventSource connection lifecycle, JSON message
// parsing, reconnection with exponential backoff, and cleanup on unmount.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSSE } from '../../src/client/hooks/useSSE';

// ---------------------------------------------------------------------------
// Mock EventSource
// ---------------------------------------------------------------------------

type EventSourceListener = (event: MessageEvent) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  private listeners = new Map<string, EventSourceListener[]>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventSourceListener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: EventSourceListener): void {
    const existing = this.listeners.get(type);
    if (existing) {
      this.listeners.set(
        type,
        existing.filter((l) => l !== listener),
      );
    }
  }

  close = vi.fn(() => {
    this.readyState = 2; // CLOSED
  });

  // Test helpers
  simulateOpen(): void {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }

  simulateMessage(data: string, eventType?: string): void {
    const event = new MessageEvent(eventType ?? 'message', { data });
    if (eventType) {
      const listeners = this.listeners.get(eventType) ?? [];
      for (const listener of listeners) {
        listener(event);
      }
    }
    // Also fire onmessage for unnamed events
    if (!eventType) {
      this.onmessage?.(event);
    }
  }

  simulateError(): void {
    this.onerror?.();
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function latestEventSource(): MockEventSource {
  return MockEventSource.instances[MockEventSource.instances.length - 1]!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useSSE', () => {
  it('should create an EventSource pointing to /api/stream', () => {
    renderHook(() => useSSE());

    expect(MockEventSource.instances).toHaveLength(1);
    expect(latestEventSource().url).toBe('/api/stream');
  });

  it('should set connected to true on open', () => {
    const { result } = renderHook(() => useSSE());

    expect(result.current.connected).toBe(false);

    act(() => {
      latestEventSource().simulateOpen();
    });

    expect(result.current.connected).toBe(true);
  });

  it('should parse JSON messages and call onEvent callback', () => {
    const onEvent = vi.fn();
    renderHook(() => useSSE({ onEvent }));

    act(() => {
      latestEventSource().simulateOpen();
    });

    const data = JSON.stringify({ type: 'team_launched', team_id: 5 });
    act(() => {
      latestEventSource().simulateMessage(data, 'team_launched');
    });

    expect(onEvent).toHaveBeenCalledWith('team_launched', { type: 'team_launched', team_id: 5 });
  });

  it('should handle non-JSON messages gracefully', () => {
    const onEvent = vi.fn();
    renderHook(() => useSSE({ onEvent }));

    act(() => {
      latestEventSource().simulateOpen();
    });

    // Send a non-JSON message via the unnamed fallback
    act(() => {
      latestEventSource().simulateMessage('not-json');
    });

    expect(onEvent).toHaveBeenCalledWith('message', 'not-json');
  });

  it('should set connected to false on error', () => {
    const { result } = renderHook(() => useSSE());

    act(() => {
      latestEventSource().simulateOpen();
    });
    expect(result.current.connected).toBe(true);

    act(() => {
      latestEventSource().simulateError();
    });
    expect(result.current.connected).toBe(false);
  });

  it('should reconnect with exponential backoff on error', () => {
    renderHook(() => useSSE());

    expect(MockEventSource.instances).toHaveLength(1);

    // First error — reconnect after 1s
    act(() => {
      latestEventSource().simulateError();
    });

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(MockEventSource.instances).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(MockEventSource.instances).toHaveLength(2);

    // Second error — reconnect after 2s
    act(() => {
      latestEventSource().simulateError();
    });

    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(MockEventSource.instances).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(MockEventSource.instances).toHaveLength(3);

    // Third error — reconnect after 4s
    act(() => {
      latestEventSource().simulateError();
    });

    act(() => {
      vi.advanceTimersByTime(3999);
    });
    expect(MockEventSource.instances).toHaveLength(3);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(MockEventSource.instances).toHaveLength(4);
  });

  it('should cap backoff at 30 seconds', () => {
    renderHook(() => useSSE());

    // Force backoff to go beyond 30s: 1, 2, 4, 8, 16, 32 -> capped at 30
    for (let i = 0; i < 5; i++) {
      act(() => {
        latestEventSource().simulateError();
      });
      act(() => {
        vi.advanceTimersByTime(30_001);
      });
    }

    const countBefore = MockEventSource.instances.length;

    // Next error should reconnect in exactly 30s (capped)
    act(() => {
      latestEventSource().simulateError();
    });

    act(() => {
      vi.advanceTimersByTime(29_999);
    });
    expect(MockEventSource.instances).toHaveLength(countBefore);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(MockEventSource.instances).toHaveLength(countBefore + 1);
  });

  it('should reset backoff on successful connection', () => {
    renderHook(() => useSSE());

    // Trigger error to increase backoff to 2s
    act(() => {
      latestEventSource().simulateError();
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(MockEventSource.instances).toHaveLength(2);

    // Successful reconnect resets backoff
    act(() => {
      latestEventSource().simulateOpen();
    });

    // Another error — should use 1s backoff again (reset)
    act(() => {
      latestEventSource().simulateError();
    });

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(MockEventSource.instances).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(MockEventSource.instances).toHaveLength(3);
  });

  it('should clean up EventSource on unmount', () => {
    const { unmount } = renderHook(() => useSSE());
    const source = latestEventSource();

    unmount();

    expect(source.close).toHaveBeenCalled();
  });

  it('should clear retry timer on unmount', () => {
    const { unmount } = renderHook(() => useSSE());

    // Trigger an error to schedule a retry
    act(() => {
      latestEventSource().simulateError();
    });

    const countBefore = MockEventSource.instances.length;
    unmount();

    // Advance past the retry delay — should NOT reconnect
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(MockEventSource.instances).toHaveLength(countBefore);
  });

  it('should throttle lastEvent updates for team_output events', () => {
    const { result } = renderHook(() => useSSE());

    act(() => {
      latestEventSource().simulateOpen();
    });

    // team_output events should not update lastEvent
    const data = JSON.stringify({ type: 'team_output', team_id: 1 });
    act(() => {
      latestEventSource().simulateMessage(data, 'team_output');
    });

    expect(result.current.lastEvent).toBeNull();
  });

  it('should extract team_id from SSE events', () => {
    const { result } = renderHook(() => useSSE());

    act(() => {
      latestEventSource().simulateOpen();
    });

    const data = JSON.stringify({ type: 'team_status_changed', team_id: 42 });
    act(() => {
      latestEventSource().simulateMessage(data, 'team_status_changed');
    });

    expect(result.current.lastEventTeamId).toBe(42);
  });

  it('should set lastEventTeamId to null for non-team events', () => {
    const { result } = renderHook(() => useSSE());

    act(() => {
      latestEventSource().simulateOpen();
    });

    const data = JSON.stringify({ type: 'snapshot' });
    act(() => {
      latestEventSource().simulateMessage(data, 'snapshot');
    });

    expect(result.current.lastEventTeamId).toBeNull();
  });
});
