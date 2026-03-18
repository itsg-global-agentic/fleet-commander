import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useFleet } from '../context/FleetContext';
import { LaunchDialog } from './LaunchDialog';
import { ProjectSelector } from './ProjectSelector';
import { useApi } from '../hooks/useApi';
import { RocketIcon } from './Icons';
import { STATUS_COLORS } from '../utils/constants';

/** Get usage text color: green under 50%, yellow 50-80%, red over 80% */
function getUsageColor(percent: number): string {
  if (percent > 80) return '#F85149';
  if (percent >= 50) return '#D29922';
  return '#3FB950';
}

/** Check if any usage category is in red zone (>80%) */
function isUsageRedZone(data: UsageData): boolean {
  return Math.max(data.dailyPercent, data.weeklyPercent, data.sonnetPercent, data.extraPercent) > 80;
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

  // Build usage indicators with full names
  const usageIndicators = usage
    ? [
        { key: 'daily', label: 'Daily', percent: usage.dailyPercent },
        { key: 'weekly', label: 'Weekly', percent: usage.weeklyPercent },
        { key: 'sonnet', label: 'Sonnet', percent: usage.sonnetPercent },
        { key: 'extra', label: 'Extra', percent: usage.extraPercent },
      ]
    : [];

  // Status counts — exclude done and failed, only show > 0
  const statusItems = [
    { label: 'running', count: counts.running || 0, color: STATUS_COLORS.running },
    { label: 'queued', count: counts.queued || 0, color: STATUS_COLORS.queued },
    { label: 'launching', count: counts.launching || 0, color: STATUS_COLORS.launching },
    { label: 'idle', count: counts.idle || 0, color: STATUS_COLORS.idle },
    { label: 'stuck', count: counts.stuck || 0, color: STATUS_COLORS.stuck },
  ].filter(s => s.count > 0);

  return (
    <>
      <header className="h-12 min-h-[48px] bg-dark-surface border-b border-dark-border flex items-center px-4 justify-between shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold text-dark-text tracking-wide">
            Fleet Commander
          </h1>
          <ProjectSelector />
        </div>
        <div className="flex items-center gap-3">
          {/* Team status counts — plain colored text with dot separator */}
          {statusItems.map((item, i) => (
            <span key={item.label} className="text-xs font-medium">
              <span style={{ color: item.color }}>{item.count}</span>
              <span className="text-dark-muted ml-1">{item.label}</span>
              {i < statusItems.length - 1 && (
                <span className="text-dark-muted ml-3">&middot;</span>
              )}
            </span>
          ))}

          {/* Usage — full names, colored percentage text */}
          {usageIndicators.length > 0 && statusItems.length > 0 && (
            <span className="text-dark-muted mx-1">|</span>
          )}
          {usageIndicators.map(ind => (
            <span key={ind.key} className="text-xs font-medium">
              <span className="text-dark-muted">{ind.label}</span>{' '}
              <span style={{ color: getUsageColor(ind.percent) }}>{ind.percent.toFixed(0)}%</span>
            </span>
          ))}

          {/* PAUSED badge when usage is in red zone */}
          {usage && isUsageRedZone(usage) && (
            <span className="text-xs font-bold animate-pulse" style={{ color: '#F85149' }}>
              PAUSED
            </span>
          )}

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

      {/* Launch dialog rendered via portal to document.body — completely outside
          the Router/NavLink DOM tree so that open/close re-renders cannot
          accidentally trigger SideNav navigation (see bug #3x Playwright). */}
      {createPortal(
        <LaunchDialog open={launchOpen} onClose={() => setLaunchOpen(false)} />,
        document.body,
      )}
    </>
  );
}
