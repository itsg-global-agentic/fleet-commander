import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useSSE } from '../hooks/useSSE';
import type { TeamDashboardRow } from '../../shared/types';

interface FleetContextValue {
  teams: TeamDashboardRow[];
  selectedTeamId: number | null;
  setSelectedTeamId: (id: number | null) => void;
  connected: boolean;
  lastEvent: Date | null;
  /** The team_id from the most recent SSE event, or null for non-team events */
  lastEventTeamId: number | null;
  /** Check whether a team is currently in extended thinking */
  isThinking: (teamId: number) => boolean;
}

const FleetContext = createContext<FleetContextValue | null>(null);

/** Periodic fallback refresh interval (ms) — guards against missed SSE snapshots */
const FALLBACK_REFRESH_MS = 45_000;

export function FleetProvider({ children }: { children: ReactNode }) {
  const [teams, setTeams] = useState<TeamDashboardRow[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<number | null>(null);
  const fetchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thinkingTeamIdsRef = useRef<Set<number>>(new Set());
  const [thinkingVersion, forceThinkingUpdate] = useState(0);

  // Fetch the full team dashboard from the REST API.
  // Used as a fallback when an SSE event signals a change but
  // doesn't carry the full team list payload.
  const fetchTeams = useCallback(async () => {
    try {
      const res = await fetch('/api/teams');
      if (res.ok) {
        const data = (await res.json()) as TeamDashboardRow[];
        setTeams(data);
      }
    } catch {
      // Network error — will be retried on next event or periodic refresh
    }
  }, []);

  // Debounced fetchTeams — coalesces rapid incremental SSE events into one API call
  const debouncedFetchTeams = useCallback(() => {
    if (fetchDebounceRef.current) {
      clearTimeout(fetchDebounceRef.current);
    }
    fetchDebounceRef.current = setTimeout(() => {
      fetchDebounceRef.current = null;
      fetchTeams();
    }, 500);
  }, [fetchTeams]);

  const handleSSEEvent = useCallback((type: string, data: unknown) => {
    if (type === 'snapshot') {
      // Full team list update — apply directly
      const payload = data as { teams?: TeamDashboardRow[] };
      if (Array.isArray(payload.teams)) {
        setTeams(payload.teams);
      }
    } else if (
      type === 'team_status_changed' ||
      type === 'team_launched' ||
      type === 'team_stopped'
    ) {
      // Incremental team change — re-fetch team list so grid stays current
      // even if the server's follow-up snapshot is missed (e.g., reconnect race)
      debouncedFetchTeams();

      // Clear thinking state when a team stops (safety net)
      if (type === 'team_stopped') {
        const payload = data as { team_id?: number };
        if (typeof payload.team_id === 'number' && thinkingTeamIdsRef.current.has(payload.team_id)) {
          thinkingTeamIdsRef.current.delete(payload.team_id);
          forceThinkingUpdate((n) => n + 1);
        }
      }
    } else if (type === 'usage_updated' || type === 'pr_updated') {
      // Usage or PR data changed — refresh teams to pick up any related state changes.
      debouncedFetchTeams();
    } else if (type === 'team_thinking_start') {
      const payload = data as { team_id?: number };
      if (typeof payload.team_id === 'number') {
        thinkingTeamIdsRef.current.add(payload.team_id);
        forceThinkingUpdate((n) => n + 1);
      }
    } else if (type === 'team_thinking_stop') {
      const payload = data as { team_id?: number };
      if (typeof payload.team_id === 'number') {
        thinkingTeamIdsRef.current.delete(payload.team_id);
        forceThinkingUpdate((n) => n + 1);
      }
    }
  }, [debouncedFetchTeams]);

  const { connected, lastEvent, lastEventTeamId } = useSSE({ onEvent: handleSSEEvent });

  // Fetch teams on mount as a fallback in case the SSE snapshot is missed
  useEffect(() => {
    fetchTeams();
  }, [fetchTeams]);

  // Periodic fallback refresh — catches any missed events
  useEffect(() => {
    const interval = setInterval(fetchTeams, FALLBACK_REFRESH_MS);
    return () => clearInterval(interval);
  }, [fetchTeams]);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (fetchDebounceRef.current) {
        clearTimeout(fetchDebounceRef.current);
      }
    };
  }, []);

  const isThinking = useCallback((teamId: number): boolean => {
    return thinkingTeamIdsRef.current.has(teamId);
  }, []);

  const value = useMemo<FleetContextValue>(() => ({
    teams,
    selectedTeamId,
    setSelectedTeamId,
    connected,
    lastEvent,
    lastEventTeamId,
    isThinking,
  // eslint-disable-next-line react-hooks/exhaustive-deps -- thinkingVersion forces recompute so consumers re-render on thinking state changes
  }), [teams, selectedTeamId, connected, lastEvent, lastEventTeamId, isThinking, thinkingVersion]);

  return (
    <FleetContext.Provider value={value}>
      {children}
    </FleetContext.Provider>
  );
}

export function useFleet(): FleetContextValue {
  const ctx = useContext(FleetContext);
  if (!ctx) {
    throw new Error('useFleet must be used within a FleetProvider');
  }
  return ctx;
}
