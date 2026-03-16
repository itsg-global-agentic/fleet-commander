import { createContext, useContext, useState, useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { useSSE } from '../hooks/useSSE';
import type { TeamDashboardRow } from '../../shared/types';

interface FleetContextValue {
  teams: TeamDashboardRow[];
  allTeams: TeamDashboardRow[];
  selectedTeamId: number | null;
  setSelectedTeamId: (id: number | null) => void;
  selectedProjectId: number | null;
  setSelectedProjectId: (id: number | null) => void;
  connected: boolean;
  lastEvent: Date | null;
}

const FleetContext = createContext<FleetContextValue | null>(null);

export function FleetProvider({ children }: { children: ReactNode }) {
  const [allTeams, setAllTeams] = useState<TeamDashboardRow[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<number | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);

  // Fetch the full team dashboard from the REST API.
  // Used as a fallback when an SSE event signals a change but
  // doesn't carry the full team list payload.
  const fetchTeams = useCallback(async () => {
    try {
      const res = await fetch('/api/teams');
      if (res.ok) {
        const teams = (await res.json()) as TeamDashboardRow[];
        console.log('[FleetContext] Teams fetched via REST:', teams.length, teams.map(t => ({ id: t.id, status: t.status })));
        setAllTeams(teams);
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
        setAllTeams(payload.teams);
      }
    } else if (type === 'usage_updated') {
      // Usage data changed — refresh teams to pick up any related state changes.
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

  // Filter teams by selected project
  const teams = useMemo(() => {
    if (selectedProjectId === null) return allTeams;
    return allTeams.filter((t) => t.projectId === selectedProjectId);
  }, [allTeams, selectedProjectId]);

  return (
    <FleetContext.Provider
      value={{
        teams,
        allTeams,
        selectedTeamId,
        setSelectedTeamId,
        selectedProjectId,
        setSelectedProjectId,
        connected,
        lastEvent,
      }}
    >
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
