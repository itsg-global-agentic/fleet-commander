import { useFleet } from '../context/FleetContext';

// Status colors from PRD
const STATUS_COLORS: Record<string, string> = {
  running: '#3FB950',
  stuck: '#F85149',
  idle: '#D29922',
  done: '#56D4DD',
  failed: '#F85149',
  launching: '#58A6FF',
};

export function TopBar() {
  const { teams } = useFleet();

  // Count teams by status
  const counts = teams.reduce((acc, team) => {
    acc[team.status] = (acc[team.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Total cost
  const totalCost = teams.reduce((sum, team) => sum + (team.totalCost || 0), 0);

  const pills = [
    { label: 'Running', count: counts.running || 0, color: STATUS_COLORS.running },
    { label: 'Stuck', count: counts.stuck || 0, color: STATUS_COLORS.stuck },
    { label: 'Idle', count: counts.idle || 0, color: STATUS_COLORS.idle },
    { label: 'Done', count: counts.done || 0, color: STATUS_COLORS.done },
  ];

  return (
    <header className="h-12 min-h-[48px] bg-dark-surface border-b border-dark-border flex items-center px-4 justify-between shrink-0">
      <h1 className="text-sm font-semibold text-dark-text tracking-wide">
        Fleet Commander
      </h1>
      <div className="flex items-center gap-2">
        {pills.map(pill => (
          pill.count > 0 && (
            <span
              key={pill.label}
              className="px-2 py-0.5 rounded-full text-xs font-medium"
              style={{
                backgroundColor: pill.color + '20',
                color: pill.color,
                border: `1px solid ${pill.color}40`,
              }}
            >
              {pill.count} {pill.label}
            </span>
          )
        ))}
        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-dark-muted/10 text-dark-muted border border-dark-muted/25">
          ${totalCost.toFixed(2)}
        </span>
      </div>
    </header>
  );
}
