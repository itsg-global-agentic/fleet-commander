import { useCallback } from 'react';
import type { TeamDashboardRow } from '../../shared/types';
import { TeamRow } from './TeamRow';
import { useThinking } from '../context/FleetContext';

interface FleetGridProps {
  teams: TeamDashboardRow[];
  selectedTeamId: number | null;
  onSelectTeam: (id: number) => void;
}

const COLUMNS = ['Status', 'Project', 'Issue', 'Model', 'Duration', 'Activity', 'Tokens', 'PR', 'Actions'] as const;

export function FleetGrid({ teams, selectedTeamId, onSelectTeam }: FleetGridProps) {
  const { isThinking } = useThinking();

  // Single stable callback reference — TeamRow calls onSelect(team.id) internally
  const handleSelectTeam = useCallback((teamId: number) => {
    onSelectTeam(teamId);
  }, [onSelectTeam]);

  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full table-auto">
        <thead>
          <tr className="border-b border-dark-border">
            {COLUMNS.map((col) => (
              <th
                key={col}
                className="px-4 py-3 text-left text-xs font-medium text-dark-muted uppercase tracking-wider"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {teams.map((team) => (
            <TeamRow
              key={team.id}
              team={team}
              selected={selectedTeamId === team.id}
              isThinking={isThinking(team.id)}
              onSelect={handleSelectTeam}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
