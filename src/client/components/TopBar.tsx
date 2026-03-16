import { useState, useEffect, useCallback } from 'react';
import { useFleet } from '../context/FleetContext';
import { LaunchDialog } from './LaunchDialog';
import { ProjectSelector } from './ProjectSelector';
import { useApi } from '../hooks/useApi';
import { RocketIcon } from './Icons';

// Status colors from PRD
const STATUS_COLORS: Record<string, string> = {
  running: '#3FB950',
  stuck: '#F85149',
  idle: '#D29922',
  done: '#56D4DD',
  failed: '#F85149',
  launching: '#58A6FF',
};

/** Base colors per usage category */
const USAGE_BASE_COLORS: Record<string, string> = {
  daily: '#58A6FF',
  weekly: '#3FB950',
  sonnet: '#A371F7',
  extra: '#D29922',
};

/** Get bar fill color: base color under 50%, yellow 50-80%, red over 80% */
function getUsageBarColor(percent: number, baseColor: string): string {
  if (percent > 80) return '#F85149';
  if (percent >= 50) return '#D29922';
  return baseColor;
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

  // Build 4 usage indicators
  const usageIndicators = usage
    ? [
        { key: 'daily', label: 'D', percent: usage.dailyPercent, baseColor: USAGE_BASE_COLORS.daily },
        { key: 'weekly', label: 'W', percent: usage.weeklyPercent, baseColor: USAGE_BASE_COLORS.weekly },
        { key: 'sonnet', label: 'S', percent: usage.sonnetPercent, baseColor: USAGE_BASE_COLORS.sonnet },
        { key: 'extra', label: 'E', percent: usage.extraPercent, baseColor: USAGE_BASE_COLORS.extra },
      ]
    : [];

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
          {/* Usage indicators — 4 compact inline bars */}
          {usageIndicators.map(ind => {
            const fillColor = getUsageBarColor(ind.percent, ind.baseColor);
            const clampedPercent = Math.min(100, Math.max(0, ind.percent));
            return (
              <div
                key={ind.key}
                className="flex flex-col items-center"
                style={{ minWidth: 48 }}
                title={`${ind.key.charAt(0).toUpperCase() + ind.key.slice(1)}: ${ind.percent.toFixed(0)}%`}
              >
                <span className="text-[10px] leading-tight font-medium" style={{ color: fillColor }}>
                  {ind.label}: {ind.percent.toFixed(0)}%
                </span>
                <div
                  className="rounded-full overflow-hidden"
                  style={{
                    width: 48,
                    height: 4,
                    backgroundColor: '#30363D',
                    marginTop: 2,
                  }}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${clampedPercent}%`,
                      backgroundColor: fillColor,
                    }}
                  />
                </div>
              </div>
            );
          })}

          {/* Launch Team button */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              setLaunchOpen(true);
            }}
            className="ml-2 px-3 py-1 text-xs font-medium rounded border border-dark-accent/40 text-dark-accent hover:bg-dark-accent/10 transition-colors inline-flex items-center gap-1.5"
            title="Launch a new team"
          >
            <RocketIcon size={14} />
            Launch Team
          </button>
        </div>
      </header>

      {/* Launch dialog rendered at portal-level to avoid z-index issues */}
      <LaunchDialog open={launchOpen} onClose={() => setLaunchOpen(false)} />
    </>
  );
}
