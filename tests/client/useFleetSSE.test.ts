// =============================================================================
// Fleet Commander — useFleetSSE Hook Tests
// =============================================================================
// Tests for the useFleetSSE hook which subscribes to SSE event types via the
// FleetProvider's dispatch context, eliminating duplicate EventSource connections.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock the SSEDispatchContext via useSSEDispatch
// ---------------------------------------------------------------------------

let mockSubscribe: ReturnType<typeof vi.fn>;
let mockUnsubscribe: ReturnType<typeof vi.fn>;

vi.mock('../../src/client/context/FleetContext', () => ({
  useSSEDispatch: () => ({
    subscribe: mockSubscribe,
  }),
}));

// Import after mocks
import { useFleetSSE } from '../../src/client/hooks/useFleetSSE';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useFleetSSE', () => {
  beforeEach(() => {
    mockUnsubscribe = vi.fn();
    mockSubscribe = vi.fn().mockReturnValue(mockUnsubscribe);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should subscribe on mount with a single event type', () => {
    const callback = vi.fn();
    renderHook(() => useFleetSSE('team_output', callback));

    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(mockSubscribe).toHaveBeenCalledWith('team_output', expect.any(Function));
  });

  it('should subscribe on mount with an array of event types', () => {
    const callback = vi.fn();
    renderHook(() => useFleetSSE(['team_output', 'team_event'], callback));

    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    expect(mockSubscribe).toHaveBeenCalledWith('team_output', expect.any(Function));
    expect(mockSubscribe).toHaveBeenCalledWith('team_event', expect.any(Function));
  });

  it('should unsubscribe on unmount', () => {
    const callback = vi.fn();
    const { unmount } = renderHook(() => useFleetSSE('team_output', callback));

    expect(mockUnsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('should unsubscribe all event types on unmount when using array', () => {
    const callback = vi.fn();
    const unsub1 = vi.fn();
    const unsub2 = vi.fn();
    mockSubscribe
      .mockReturnValueOnce(unsub1)
      .mockReturnValueOnce(unsub2);

    const { unmount } = renderHook(() => useFleetSSE(['team_output', 'team_event'], callback));

    unmount();
    expect(unsub1).toHaveBeenCalledTimes(1);
    expect(unsub2).toHaveBeenCalledTimes(1);
  });

  it('should update callback ref without re-subscribing', () => {
    const callback1 = vi.fn();
    const callback2 = vi.fn();

    const { rerender } = renderHook(
      ({ cb }) => useFleetSSE('team_output', cb),
      { initialProps: { cb: callback1 } },
    );

    expect(mockSubscribe).toHaveBeenCalledTimes(1);

    // Re-render with a new callback — should NOT call subscribe again
    rerender({ cb: callback2 });
    expect(mockSubscribe).toHaveBeenCalledTimes(1);

    // Invoke the stable callback that was registered — it should delegate
    // to the latest callback ref (callback2)
    const registeredCallback = mockSubscribe.mock.calls[0][1] as (type: string, data: unknown) => void;
    registeredCallback('team_output', { foo: 'bar' });

    expect(callback1).not.toHaveBeenCalled();
    expect(callback2).toHaveBeenCalledWith('team_output', { foo: 'bar' });
  });

  it('should re-subscribe when event types change', () => {
    const callback = vi.fn();

    const { rerender } = renderHook(
      ({ types }) => useFleetSSE(types, callback),
      { initialProps: { types: 'team_output' as string | string[] } },
    );

    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(mockSubscribe).toHaveBeenCalledWith('team_output', expect.any(Function));

    // Change event types — should unsubscribe old and subscribe new
    rerender({ types: 'team_event' });
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    expect(mockSubscribe).toHaveBeenLastCalledWith('team_event', expect.any(Function));
  });
});
