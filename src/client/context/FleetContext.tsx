import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
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

  const handleSSEEvent = useCallback((type: string, data: unknown) => {
    if (type === 'teams' || type === 'snapshot') {
      // Full team list update
      const payload = data as { teams?: TeamDashboardRow[] };
      if (Array.isArray(payload.teams)) {
        setTeams(payload.teams);
      }
    } else if (type === 'team_update') {
      // Single team update — merge into existing array
      const payload = data as { team?: TeamDashboardRow };
      if (payload.team) {
        const updated = payload.team;
        setTeams((prev) => {
          const idx = prev.findIndex((t) => t.id === updated.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = updated;
            return next;
          }
          return [...prev, updated];
        });
      }
    }
  }, []);

  const { connected, lastEvent } = useSSE({ onEvent: handleSSEEvent });

  return (
    <FleetContext.Provider
      value={{ teams, selectedTeamId, setSelectedTeamId, connected, lastEvent }}
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
