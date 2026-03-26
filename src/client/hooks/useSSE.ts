import { useEffect, useRef, useState, useCallback } from 'react';

interface UseSSEOptions {
  /** Callback invoked for each SSE message, keyed by event type */
  onEvent?: (type: string, data: unknown) => void;
}

interface UseSSEResult {
  connected: boolean;
  lastEvent: Date | null;
  /** The team_id from the most recent SSE event, or null for non-team events */
  lastEventTeamId: number | null;
}

/**
 * SSE hook that connects to /api/stream with exponential backoff reconnection.
 * Properly cleans up EventSource on unmount.
 */
export function useSSE(options: UseSSEOptions = {}): UseSSEResult {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<Date | null>(null);
  const [lastEventTeamId, setLastEventTeamId] = useState<number | null>(null);
  const onEventRef = useRef(options.onEvent);
  const retryDelayRef = useRef(1000);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const mountedRef = useRef(true);
  const lastEventTimeRef = useRef(0);

  // Keep the callback ref current without causing reconnects
  onEventRef.current = options.onEvent;

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    const source = new EventSource('/api/stream');
    sourceRef.current = source;

    source.onopen = () => {
      if (!mountedRef.current) return;
      setConnected(true);
      retryDelayRef.current = 1000; // Reset backoff on successful connection
    };

    // Handle all SSE messages — both named events (event: xxx) and unnamed.
    // Named events require addEventListener; onmessage only catches unnamed.
    // We listen for each known named event type AND onmessage as a fallback.
    const namedEventTypes = [
      'snapshot', 'team_status_changed', 'team_event', 'team_output',
      'pr_updated', 'team_launched', 'team_stopped',
      'usage_updated', 'project_added', 'project_updated', 'project_removed',
      'project_cleanup', 'dependency_resolved', 'heartbeat',
      'team_thinking_start', 'team_thinking_stop', 'task_updated',
    ];

    const handleSSEMessage = (event: MessageEvent) => {
      if (!mountedRef.current) return;
      let eventType = 'message';
      let teamId: number | null = null;
      try {
        const parsed = JSON.parse(event.data);
        eventType = parsed.type ?? event.type ?? 'message';
        // Extract team_id from team-scoped SSE events
        if (typeof parsed.team_id === 'number') {
          teamId = parsed.team_id;
        }
        onEventRef.current?.(eventType, parsed);
      } catch {
        // Non-JSON message — still invoke callback with raw data
        onEventRef.current?.('message', event.data);
      }
      // Throttle lastEvent updates — skip high-frequency output events, limit to once per second
      if (eventType !== 'team_output' && eventType !== 'team_thinking_start' && eventType !== 'team_thinking_stop') {
        const now = Date.now();
        if (now - lastEventTimeRef.current > 1000) {
          lastEventTimeRef.current = now;
          setLastEvent(new Date(now));
          setLastEventTeamId(teamId);
        }
      }
    };

    for (const eventType of namedEventTypes) {
      source.addEventListener(eventType, handleSSEMessage as EventListener);
    }

    // Also keep onmessage for any unnamed events
    source.onmessage = handleSSEMessage;

    source.onerror = () => {
      if (!mountedRef.current) return;
      setConnected(false);
      source.close();
      sourceRef.current = null;

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
      const delay = retryDelayRef.current;
      retryTimerRef.current = setTimeout(() => {
        if (mountedRef.current) {
          connect();
        }
      }, delay);
      retryDelayRef.current = Math.min(delay * 2, 30000);
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (sourceRef.current) {
        sourceRef.current.close();
        sourceRef.current = null;
      }
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [connect]);

  return { connected, lastEvent, lastEventTeamId };
}
