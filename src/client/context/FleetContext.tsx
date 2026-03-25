import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useSSE } from '../hooks/useSSE';
import type { TeamDashboardRow } from '../../shared/types';

// =============================================================================
// Context value interfaces — each context holds a narrow slice of state
// =============================================================================

interface TeamsContextValue {
  teams: TeamDashboardRow[];
}

interface SelectionContextValue {
  selectedTeamId: number | null;
  setSelectedTeamId: (id: number | null) => void;
}

interface ConnectionContextValue {
  connected: boolean;
  lastEvent: Date | null;
  lastEventTeamId: number | null;
}

interface ThinkingContextValue {
  isThinking: (teamId: number) => boolean;
}

// =============================================================================
// Create the four independent contexts
// =============================================================================

const TeamsContext = createContext<TeamsContextValue | null>(null);
const SelectionContext = createContext<SelectionContextValue | null>(null);
const ConnectionContext = createContext<ConnectionContextValue | null>(null);
const ThinkingContext = createContext<ThinkingContextValue | null>(null);

/** Periodic fallback refresh interval (ms) — guards against missed SSE snapshots */
const FALLBACK_REFRESH_MS = 45_000;

// =============================================================================
// Provider — single component that provides all four contexts
// =============================================================================

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
        const json = await res.json();
        // Handle paginated response envelope { data, total, limit, offset }
        const rows = (Array.isArray(json) ? json : json.data) as TeamDashboardRow[];
        setTeams(rows);
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
    } else if (type === 'team_status_changed') {
      // C7: Incremental update — parse payload and update the single affected team locally
      const payload = data as {
        team_id?: number;
        status?: string;
        previous_status?: string;
        phase?: string;
        previous_phase?: string;
        tokens?: { input?: number; output?: number; cacheCreation?: number; cacheRead?: number };
        idle_minutes?: number;
      };
      if (typeof payload.team_id === 'number') {
        setTeams(prev => prev.map(team => {
          if (team.id !== payload.team_id) return team;
          const updated = { ...team };
          if (typeof payload.status === 'string') {
            updated.status = payload.status as TeamDashboardRow['status'];
          }
          if (typeof payload.phase === 'string') {
            updated.phase = payload.phase as TeamDashboardRow['phase'];
          }
          if (payload.tokens) {
            if (typeof payload.tokens.input === 'number') updated.totalInputTokens = payload.tokens.input;
            if (typeof payload.tokens.output === 'number') updated.totalOutputTokens = payload.tokens.output;
            if (typeof payload.tokens.cacheCreation === 'number') updated.totalCacheCreationTokens = payload.tokens.cacheCreation;
            if (typeof payload.tokens.cacheRead === 'number') updated.totalCacheReadTokens = payload.tokens.cacheRead;
          }
          if (typeof payload.idle_minutes === 'number') {
            updated.idleMin = payload.idle_minutes;
          }
          updated.lastEventAt = new Date().toISOString();
          return updated;
        }));
      }
    } else if (type === 'team_launched') {
      // Insufficient payload for local update — full refetch
      debouncedFetchTeams();
    } else if (type === 'team_stopped') {
      // Insufficient payload for local update — full refetch
      debouncedFetchTeams();

      // Clear thinking state when a team stops (safety net)
      const payload = data as { team_id?: number };
      if (typeof payload.team_id === 'number' && thinkingTeamIdsRef.current.has(payload.team_id)) {
        thinkingTeamIdsRef.current.delete(payload.team_id);
        forceThinkingUpdate((n) => n + 1);
      }
    } else if (type === 'pr_updated') {
      // C7: Incremental update — parse payload and update affected team locally
      const payload = data as {
        team_id?: number;
        pr_number?: number;
        state?: string;
        ci_status?: string;
        merge_status?: string;
      };
      if (typeof payload.team_id === 'number') {
        setTeams(prev => prev.map(team => {
          if (team.id !== payload.team_id) return team;
          const updated = { ...team };
          if (typeof payload.pr_number === 'number') updated.prNumber = payload.pr_number;
          if (typeof payload.state === 'string') updated.prState = payload.state as TeamDashboardRow['prState'];
          if (typeof payload.ci_status === 'string') updated.ciStatus = payload.ci_status as TeamDashboardRow['ciStatus'];
          if (typeof payload.merge_status === 'string') updated.mergeStatus = payload.merge_status as TeamDashboardRow['mergeStatus'];
          return updated;
        }));
      }
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
    // usage_updated: no longer triggers team list refetch (C7)
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

  // Memoize each context value independently so consumers only re-render
  // when their specific slice changes.
  const teamsValue = useMemo<TeamsContextValue>(() => ({
    teams,
  }), [teams]);

  const selectionValue = useMemo<SelectionContextValue>(() => ({
    selectedTeamId,
    setSelectedTeamId,
  }), [selectedTeamId]);

  const connectionValue = useMemo<ConnectionContextValue>(() => ({
    connected,
    lastEvent,
    lastEventTeamId,
  }), [connected, lastEvent, lastEventTeamId]);

  const thinkingValue = useMemo<ThinkingContextValue>(() => ({
    isThinking,
  // eslint-disable-next-line react-hooks/exhaustive-deps -- thinkingVersion forces recompute so consumers re-render on thinking state changes
  }), [isThinking, thinkingVersion]);

  return (
    <TeamsContext.Provider value={teamsValue}>
      <SelectionContext.Provider value={selectionValue}>
        <ConnectionContext.Provider value={connectionValue}>
          <ThinkingContext.Provider value={thinkingValue}>
            {children}
          </ThinkingContext.Provider>
        </ConnectionContext.Provider>
      </SelectionContext.Provider>
    </TeamsContext.Provider>
  );
}

// =============================================================================
// Targeted hooks — consumers subscribe only to the data they need
// =============================================================================

/** Access the teams list only */
export function useTeams(): TeamsContextValue {
  const ctx = useContext(TeamsContext);
  if (!ctx) {
    throw new Error('useTeams must be used within a FleetProvider');
  }
  return ctx;
}

/** Access selection state only */
export function useSelection(): SelectionContextValue {
  const ctx = useContext(SelectionContext);
  if (!ctx) {
    throw new Error('useSelection must be used within a FleetProvider');
  }
  return ctx;
}

/** Access SSE connection state only */
export function useConnection(): ConnectionContextValue {
  const ctx = useContext(ConnectionContext);
  if (!ctx) {
    throw new Error('useConnection must be used within a FleetProvider');
  }
  return ctx;
}

/** Access thinking state only */
export function useThinking(): ThinkingContextValue {
  const ctx = useContext(ThinkingContext);
  if (!ctx) {
    throw new Error('useThinking must be used within a FleetProvider');
  }
  return ctx;
}

// =============================================================================
// Backwards-compatible facade — works for unmigrated consumers
// =============================================================================

/** @deprecated Use useTeams(), useSelection(), useConnection(), or useThinking() instead */
export function useFleet() {
  const { teams } = useTeams();
  const { selectedTeamId, setSelectedTeamId } = useSelection();
  const { connected, lastEvent, lastEventTeamId } = useConnection();
  const { isThinking } = useThinking();

  return {
    teams,
    selectedTeamId,
    setSelectedTeamId,
    connected,
    lastEvent,
    lastEventTeamId,
    isThinking,
  };
}
