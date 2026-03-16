import { useState, useEffect, useCallback } from 'react';
import { useFleet } from '../context/FleetContext';
import { LaunchDialog } from './LaunchDialog';
import { ProjectSelector } from './ProjectSelector';
import { useApi } from '../hooks/useApi';

// Status colors from PRD
const STATUS_COLORS: Record<string, string> = {
  running: '#3FB950',
  stuck: '#F85149',
  idle: '#D29922',
  done: '#56D4DD',
  failed: '#F85149',
  launching: '#58A6FF',
};

/** Get pill color based on usage threshold */
function getUsagePillColor(percent: number): string {
  if (percent > 80) return '#F85149';
  if (percent >= 50) return '#D29922';
  return '#3FB950';
}

interface UsageData {
  dailyPercent: number;
  weeklyPercent: number;
  sonnetPercent: number;
  extraPercent: number;
}

export function TopBar() {
  const { teams } = useFleet();
  const api = useApi();
  const [launchOpen, setLaunchOpen] = useState(false);
  const [usage, setUsage] = useState<UsageData | null>(null);

  const fetchUsage = useCallback(async () => {
    try {
      const data = await api.get<UsageData>('usage');
      setUsage(data);
    } catch {
      // Silently ignore — pill will just not show
    }
  }, [api]);

  useEffect(() => {
    fetchUsage();
    const interval = setInterval(fetchUsage, 30_000);
    return () => clearInterval(interval);
  }, [fetchUsage]);

  // Count teams by status
  const counts = teams.reduce((acc, team) => {
    acc[team.status] = (acc[team.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Determine highest usage for the pill display
  const highestUsage = usage
    ? Math.max(usage.dailyPercent, usage.weeklyPercent, usage.sonnetPercent, usage.extraPercent)
    : 0;
  const highestLabel = usage
    ? (() => {
        const max = highestUsage;
        if (max === usage.dailyPercent) return 'Daily';
        if (max === usage.weeklyPercent) return 'Weekly';
        if (max === usage.sonnetPercent) return 'Sonnet';
        return 'Extra';
      })()
    : 'Daily';
  const usageColor = getUsagePillColor(highestUsage);

  const pills = [
    { label: 'Running', count: counts.running || 0, color: STATUS_COLORS.running },
    { label: 'Stuck', count: counts.stuck || 0, color: STATUS_COLORS.stuck },
    { label: 'Idle', count: counts.idle || 0, color: STATUS_COLORS.idle },
    { label: 'Done', count: counts.done || 0, color: STATUS_COLORS.done },
  ];

  return (
    <>
      <header className="h-12 min-h-[48px] bg-dark-surface border-b border-dark-border flex items-center px-4 justify-between shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold text-dark-text tracking-wide">
            Fleet Commander
          </h1>
          <ProjectSelector />
        </div>
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
          <span
            className="px-2 py-0.5 rounded-full text-xs font-medium"
            style={{
              backgroundColor: usageColor + '20',
              color: usageColor,
              border: `1px solid ${usageColor}40`,
            }}
          >
            {highestLabel}: {highestUsage.toFixed(0)}%
          </span>

          {/* Launch Team button */}
          <button
            onClick={() => setLaunchOpen(true)}
            className="ml-2 px-3 py-1 text-xs font-medium rounded border border-dark-accent/40 text-dark-accent hover:bg-dark-accent/10 transition-colors"
            title="Launch a new team"
          >
            Launch Team
          </button>
        </div>
      </header>

      {/* Launch dialog rendered at portal-level to avoid z-index issues */}
      <LaunchDialog open={launchOpen} onClose={() => setLaunchOpen(false)} />
    </>
  );
}
