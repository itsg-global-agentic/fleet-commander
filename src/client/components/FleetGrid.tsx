import type { TeamDashboardRow } from '../../shared/types';
import { TeamRow } from './TeamRow';

interface FleetGridProps {
  teams: TeamDashboardRow[];
  selectedTeamId: number | null;
  onSelectTeam: (id: number) => void;
}

const COLUMNS = ['Status', 'Issue', 'Duration', 'Activity', 'PR', 'Actions'] as const;

export function FleetGrid({ teams, selectedTeamId, onSelectTeam }: FleetGridProps) {
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
              onClick={() => onSelectTeam(team.id)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
