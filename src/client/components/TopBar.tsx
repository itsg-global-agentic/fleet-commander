import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTeams } from '../context/FleetContext';
import { useFleetSSE } from '../hooks/useFleetSSE';
import { LaunchDialog } from './LaunchDialog';
import { useApi } from '../hooks/useApi';
import { RocketIcon } from './Icons';
import { STATUS_COLORS, getUsageColor } from '../utils/constants';
import { formatResetsAt } from '../utils/format-resets-at';
import type { UsageZone } from '../../shared/types';

interface RedThresholds {
  daily: number;
  weekly: number;
  sonnet: number;
  extra: number;
}

const DEFAULT_RED_THRESHOLDS: RedThresholds = { daily: 85, weekly: 95, sonnet: 95, extra: 95 };

interface UsageResponse {
  dailyPercent: number;
  weeklyPercent: number;
  sonnetPercent: number;
  extraPercent: number;
  zone?: UsageZone;
  redThresholds?: RedThresholds;
  dailyResetsAt?: string | null;
  weeklyResetsAt?: string | null;
  overrideActive?: boolean;
  hardPaused?: boolean;
  hardExtraThreshold?: number;
}

export function TopBar() {
  const { teams } = useTeams();
  const api = useApi();
  const [launchOpen, setLaunchOpen] = useState(false);
  const [usage, setUsage] = useState<UsageResponse | null>(null);

  const fetchUsage = useCallback(async () => {
    try {
      const data = await api.get<UsageResponse>('usage');
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

  // Re-fetch usage when override state changes (from any source, including other tabs)
  const handleSSEEvent = useCallback(() => {
    fetchUsage();
  }, [fetchUsage]);
  useFleetSSE(['usage_override_changed', 'usage_updated'], handleSSEEvent);

  // Count teams by status
  const counts = teams.reduce((acc, team) => {
    acc[team.status] = (acc[team.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const thresholds = usage?.redThresholds ?? DEFAULT_RED_THRESHOLDS;

  // Build usage indicators with full names
  const usageIndicators = usage
    ? [
        { key: 'daily', label: 'Daily', percent: usage.dailyPercent, redThreshold: thresholds.daily, resetLabel: formatResetsAt(usage.dailyResetsAt) },
        { key: 'weekly', label: 'Weekly', percent: usage.weeklyPercent, redThreshold: thresholds.weekly, resetLabel: formatResetsAt(usage.weeklyResetsAt) },
        { key: 'sonnet', label: 'Sonnet', percent: usage.sonnetPercent, redThreshold: thresholds.sonnet, resetLabel: null },
        { key: 'extra', label: 'Extra', percent: usage.extraPercent, redThreshold: thresholds.extra, resetLabel: null },
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

  // Three-state pause display
  const isHardPaused = usage?.hardPaused === true;
  const isSoftPaused = usage?.zone === 'red' && !usage?.overrideActive;
  const isOverrideActive = usage?.overrideActive === true;

  const handleResume = useCallback(async () => {
    try {
      await api.post<{ overrideActive: boolean }>('usage/override');
      await fetchUsage();
    } catch {
      // Silently ignore — SSE will update state
    }
  }, [api, fetchUsage]);

  return (
    <>
      <header className="h-12 min-h-[48px] bg-dark-surface border-b border-dark-border flex items-center px-4 justify-between shrink-0">
        <div className="flex items-center gap-3">
          <img src="/logo.svg" alt="Fleet Commander logo" width={20} height={20} />
          <h1 className="text-sm font-semibold text-dark-text tracking-wide">
            Fleet Commander
          </h1>
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
            <span key={ind.key} className="text-xs font-medium" title={ind.resetLabel ?? undefined}>
              <span className="text-dark-muted">{ind.label}</span>{' '}
              <span style={{ color: getUsageColor(ind.percent, ind.redThreshold) }}>{ind.percent.toFixed(0)}%</span>
            </span>
          ))}

          {/* Usage pause indicators */}
          {isHardPaused && (
            <span className="text-xs font-bold animate-pulse" style={{ color: '#F85149' }}>
              HARD PAUSED
            </span>
          )}
          {isSoftPaused && (
            <>
              <span className="text-xs font-bold animate-pulse" style={{ color: '#F85149' }}>
                PAUSED
              </span>
              <button
                type="button"
                onClick={handleResume}
                className="ml-1.5 px-2 py-0.5 text-[11px] font-medium rounded border border-amber-500/40 text-amber-400 hover:bg-amber-500/10 transition-colors"
                title="Resume launches using extra usage allowance"
              >
                Resume with extra
              </button>
            </>
          )}
          {isOverrideActive && !isHardPaused && !isSoftPaused && (
            <span className="text-xs font-bold" style={{ color: '#D29922' }}>
              EXTRA USAGE
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
