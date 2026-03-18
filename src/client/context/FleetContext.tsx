import { createContext, useContext, useState, useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { useSSE } from '../hooks/useSSE';
import type { TeamDashboardRow } from '../../shared/types';

interface FleetContextValue {
  teams: TeamDashboardRow[];
  selectedTeamId: number | null;
  setSelectedTeamId: (id: number | null) => void;
  connected: boolean;
  lastEvent: Date | null;
}

const FleetContext = createContext<FleetContextValue | null>(null);

export function FleetProvider({ children }: { children: ReactNode }) {
  const [teams, setTeams] = useState<TeamDashboardRow[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<number | null>(null);

  // Fetch the full team dashboard from the REST API.
  // Used as a fallback when an SSE event signals a change but
  // doesn't carry the full team list payload.
  const fetchTeams = useCallback(async () => {
    try {
      const res = await fetch('/api/teams');
      if (res.ok) {
        const data = (await res.json()) as TeamDashboardRow[];
        console.log('[FleetContext] Teams fetched via REST:', data.length, data.map(t => ({ id: t.id, status: t.status })));
        setTeams(data);
      }
    } catch {
      // Network error — will be retried on next event
    }
  }, []);

  const handleSSEEvent = useCallback((type: string, data: unknown) => {
    console.log('[FleetContext] SSE event received:', type);
    if (type === 'snapshot') {
      // Full team list update
      const payload = data as { teams?: TeamDashboardRow[] };
      if (Array.isArray(payload.teams)) {
        console.log('[FleetContext] Teams loaded from SSE:', payload.teams.length, payload.teams.map(t => ({ id: t.id, status: t.status })));
        setTeams(payload.teams);
      }
    } else if (type === 'usage_updated' || type === 'pr_updated') {
      // Usage or PR data changed — refresh teams to pick up any related state changes.
      fetchTeams();
    }
    // Note: team_launched, team_stopped, team_status_changed are NOT handled here
    // because the server already broadcasts a full 'snapshot' after those events.
  }, [fetchTeams]);

  const { connected, lastEvent } = useSSE({ onEvent: handleSSEEvent });

  // Fetch teams on mount as a fallback in case the SSE snapshot is missed
  useEffect(() => {
    fetchTeams();
  }, [fetchTeams]);

  const value = useMemo<FleetContextValue>(() => ({
    teams,
    selectedTeamId,
    setSelectedTeamId,
    connected,
    lastEvent,
  }), [teams, selectedTeamId, connected, lastEvent]);

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
