import { useEffect, useRef } from 'react';
import { useSSEDispatch } from '../context/FleetContext';

/**
 * Subscribe to specific SSE event types via the FleetProvider's single
 * EventSource connection.  This avoids opening duplicate SSE connections
 * from individual components.
 *
 * @param eventTypes - A single event type string or an array of event types.
 * @param onEvent   - Callback invoked with (type, data) when a matching SSE
 *                     event arrives.  The callback ref is kept current without
 *                     causing re-subscriptions.
 */
export function useFleetSSE(
  eventTypes: string | string[],
  onEvent: (type: string, data: unknown) => void,
): void {
  const { subscribe } = useSSEDispatch();
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    const types = Array.isArray(eventTypes) ? eventTypes : [eventTypes];
    const stableCallback = (type: string, data: unknown) => {
      onEventRef.current(type, data);
    };

    const unsubscribes = types.map((t) => subscribe(t, stableCallback));
    return () => {
      for (const unsub of unsubscribes) {
        unsub();
      }
    };
    // eventTypes is intentionally serialized to avoid re-subscriptions when the
    // caller passes a new array reference with the same contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, JSON.stringify(eventTypes)]);
}
