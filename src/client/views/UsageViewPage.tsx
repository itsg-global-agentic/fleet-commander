import { useState, useEffect, useCallback } from 'react';
import { useApi } from '../hooks/useApi';
import { getUsageColor } from '../utils/constants';
import type { UsageSnapshot } from '../../shared/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REFRESH_INTERVAL_MS = 30_000; // 30 seconds

interface RedThresholds {
  daily: number;
  weekly: number;
  sonnet: number;
  extra: number;
}

const DEFAULT_RED_THRESHOLDS: RedThresholds = { daily: 85, weekly: 95, sonnet: 95, extra: 95 };

interface UsageBar {
  label: string;
  key: 'dailyPercent' | 'weeklyPercent' | 'sonnetPercent' | 'extraPercent';
  thresholdKey: keyof RedThresholds;
}

const USAGE_BARS: UsageBar[] = [
  { label: 'Daily Usage', key: 'dailyPercent', thresholdKey: 'daily' },
  { label: 'Weekly Usage', key: 'weeklyPercent', thresholdKey: 'weekly' },
  { label: 'Sonnet Usage', key: 'sonnetPercent', thresholdKey: 'sonnet' },
  { label: 'Extra Usage', key: 'extraPercent', thresholdKey: 'extra' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a date string for display */
function formatTimestamp(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

interface UsageResponse extends UsageSnapshot {
  redThresholds?: RedThresholds;
}

interface UsageHistoryResponse {
  count: number;
  snapshots: UsageSnapshot[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UsageViewPage() {
  const api = useApi();
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [redThresholds, setRedThresholds] = useState<RedThresholds>(DEFAULT_RED_THRESHOLDS);
  const [history, setHistory] = useState<UsageSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchUsage = useCallback(async () => {
    try {
      const [latest, historyData] = await Promise.all([
        api.get<UsageResponse>('usage'),
        api.get<UsageHistoryResponse>('usage/history?limit=10'),
      ]);
      setUsage(latest);
      if (latest.redThresholds) {
        setRedThresholds(latest.redThresholds);
      }
      setHistory(historyData.snapshots);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch usage data');
    } finally {
      setLoading(false);
    }
  }, [api]);

  // Initial fetch + auto-refresh every 30s
  useEffect(() => {
    fetchUsage();

    const interval = setInterval(() => {
      fetchUsage();
    }, REFRESH_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [fetchUsage]);

  return (
    <div className="p-6 max-w-4xl mx-auto flex flex-col gap-8">
      {/* -------------------------------------------------------------------
        Usage Overview — hero section with progress bars
      ------------------------------------------------------------------- */}
      <section className="flex flex-col gap-2 py-4">
        <h2 className="text-xs font-medium text-dark-muted uppercase tracking-widest mb-4">
          Usage Overview
        </h2>

        {loading && !usage ? (
          <p className="text-dark-muted text-lg text-center py-8">Loading...</p>
        ) : error && !usage ? (
          <p className="text-[#F85149] text-sm text-center py-8">{error}</p>
        ) : usage ? (
          <div className="flex flex-col gap-4">
            {USAGE_BARS.map((bar) => {
              const percent = usage[bar.key] ?? 0;
              const color = getUsageColor(percent, redThresholds[bar.thresholdKey]);
              const clampedPercent = Math.min(Math.max(percent, 0), 100);

              return (
                <div key={bar.key} className="flex flex-col gap-1">
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-medium text-dark-text">
                      {bar.label}
                    </span>
                    <span
                      className="text-sm font-semibold tabular-nums"
                      style={{ color }}
                    >
                      {percent.toFixed(1)}%
                    </span>
                  </div>
                  {/* Bar container */}
                  <div className="w-full h-6 bg-dark-base rounded-md overflow-hidden border border-dark-border">
                    <div
                      className="h-full rounded-md transition-all duration-500 ease-out"
                      style={{
                        width: `${Math.max(clampedPercent, 0.5)}%`,
                        backgroundColor: color + '40',
                        borderRight: clampedPercent > 0 ? `2px solid ${color}` : 'none',
                      }}
                    />
                  </div>
                </div>
              );
            })}

            {usage.recordedAt && (
              <p className="text-xs text-dark-muted mt-2">
                Last updated: {formatTimestamp(usage.recordedAt)}
              </p>
            )}
          </div>
        ) : null}
      </section>

      {/* -------------------------------------------------------------------
        Recent Snapshots — history table
      ------------------------------------------------------------------- */}
      <section>
        <h3 className="text-sm font-medium text-dark-muted uppercase tracking-wider mb-3">
          Recent Snapshots
        </h3>
        <div className="bg-dark-surface rounded-lg border border-dark-border overflow-hidden">
          {history.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <p className="text-dark-muted text-sm">No usage history yet</p>
            </div>
          ) : (
            <div className="w-full overflow-x-auto">
              <table className="w-full table-auto">
                <thead>
                  <tr className="border-b border-dark-border">
                    <th className="px-4 py-3 text-left text-xs font-medium text-dark-muted uppercase tracking-wider">
                      Time
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-dark-muted uppercase tracking-wider">
                      Daily
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-dark-muted uppercase tracking-wider">
                      Weekly
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-dark-muted uppercase tracking-wider">
                      Sonnet
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-dark-muted uppercase tracking-wider">
                      Extra
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((snap) => (
                    <tr
                      key={snap.id}
                      className="h-10 border-b border-dark-border bg-dark-surface hover:bg-[#1C2128] transition-colors"
                    >
                      <td className="px-4 whitespace-nowrap text-sm text-dark-muted">
                        {snap.recordedAt ? formatTimestamp(snap.recordedAt) : '--'}
                      </td>
                      <td className="px-4 whitespace-nowrap text-sm text-right tabular-nums"
                        style={{ color: getUsageColor(snap.dailyPercent, redThresholds.daily) }}>
                        {snap.dailyPercent.toFixed(1)}%
                      </td>
                      <td className="px-4 whitespace-nowrap text-sm text-right tabular-nums"
                        style={{ color: getUsageColor(snap.weeklyPercent, redThresholds.weekly) }}>
                        {snap.weeklyPercent.toFixed(1)}%
                      </td>
                      <td className="px-4 whitespace-nowrap text-sm text-right tabular-nums"
                        style={{ color: getUsageColor(snap.sonnetPercent, redThresholds.sonnet) }}>
                        {snap.sonnetPercent.toFixed(1)}%
                      </td>
                      <td className="px-4 whitespace-nowrap text-sm text-right tabular-nums"
                        style={{ color: getUsageColor(snap.extraPercent, redThresholds.extra) }}>
                        {snap.extraPercent.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
