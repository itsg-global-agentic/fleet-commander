import { useMemo } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import type { UsageSnapshot } from '../../shared/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RedThresholds {
  daily: number;
  weekly: number;
}

interface UsageChartProps {
  snapshots: UsageSnapshot[];
  redThresholds: RedThresholds;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Line colors — match the GitHub-dark palette used elsewhere */
const LINE_COLORS = {
  dailyPercent: '#58A6FF',   // blue (accent)
  weeklyPercent: '#A371F7',  // purple
  sonnetPercent: '#3FB950',  // green
  extraPercent: '#D29922',   // yellow
} as const;

const LINE_LABELS: Record<string, string> = {
  dailyPercent: 'Daily',
  weeklyPercent: 'Weekly',
  sonnetPercent: 'Sonnet',
  extraPercent: 'Extra',
};

const LINE_KEYS = ['dailyPercent', 'weeklyPercent', 'sonnetPercent', 'extraPercent'] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ChartDataPoint {
  time: number;
  label: string;
  dailyPercent: number;
  weeklyPercent: number;
  sonnetPercent: number;
  extraPercent: number;
}

/** Format a date+time label for the X axis (e.g. "Mar 14 12:00") */
function formatTickLabel(date: Date): string {
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Format a full time string for the tooltip */
function formatTooltipTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Custom Tooltip
// ---------------------------------------------------------------------------

interface TooltipPayloadItem {
  dataKey: string;
  value: number;
  color: string;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: number;
}

function UsageTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0 || label === undefined) return null;

  return (
    <div className="bg-dark-surface border border-dark-border rounded-md px-3 py-2 shadow-lg">
      <p className="text-xs text-dark-muted mb-1">{formatTooltipTime(label)}</p>
      {payload.map((entry) => (
        <div key={entry.dataKey} className="flex items-center gap-2 text-xs">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-dark-text">
            {LINE_LABELS[entry.dataKey] ?? entry.dataKey}:
          </span>
          <span className="text-dark-text font-semibold tabular-nums">
            {entry.value.toFixed(1)}%
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UsageChart({ snapshots, redThresholds }: UsageChartProps) {
  const chartData = useMemo<ChartDataPoint[]>(() => {
    const now = Date.now();
    const cutoff = now - 7 * 24 * 60 * 60 * 1000; // 7 days ago

    return snapshots
      .map((snap) => {
        const time = new Date(snap.recordedAt).getTime();
        return {
          time,
          label: formatTickLabel(new Date(time)),
          dailyPercent: snap.dailyPercent,
          weeklyPercent: snap.weeklyPercent,
          sonnetPercent: snap.sonnetPercent,
          extraPercent: snap.extraPercent,
        };
      })
      .filter((point) => point.time >= cutoff)
      .sort((a, b) => a.time - b.time);
  }, [snapshots]);

  // Compute a fixed 7-day domain for the X axis
  const domain = useMemo<[number, number]>(() => {
    const now = Date.now();
    return [now - 7 * 24 * 60 * 60 * 1000, now];
  }, [chartData]); // eslint-disable-line -- recalculate when data changes

  if (chartData.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-dark-muted text-sm">No usage data in the last 7 days</p>
      </div>
    );
  }

  return (
    <div className="w-full h-72">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="rgba(48, 54, 61, 0.6)"
            vertical={false}
          />
          <XAxis
            dataKey="time"
            type="number"
            domain={domain}
            tickFormatter={(ts: number) => formatTickLabel(new Date(ts))}
            stroke="#8B949E"
            tick={{ fill: '#8B949E', fontSize: 11 }}
            axisLine={{ stroke: '#30363D' }}
            tickLine={{ stroke: '#30363D' }}
          />
          <YAxis
            domain={[0, 100]}
            ticks={[0, 25, 50, 75, 100]}
            tickFormatter={(v: number) => `${v}%`}
            stroke="#8B949E"
            tick={{ fill: '#8B949E', fontSize: 11 }}
            axisLine={{ stroke: '#30363D' }}
            tickLine={{ stroke: '#30363D' }}
            width={48}
          />
          <Tooltip
            content={<UsageTooltip />}
            cursor={{ stroke: 'rgba(139, 148, 158, 0.3)' }}
          />

          {/* Threshold reference lines */}
          <ReferenceLine
            y={redThresholds.daily}
            stroke="#F85149"
            strokeDasharray="6 4"
            strokeOpacity={0.6}
            label={{
              value: `Daily ${redThresholds.daily}%`,
              position: 'right',
              fill: '#F85149',
              fontSize: 10,
            }}
          />
          <ReferenceLine
            y={redThresholds.weekly}
            stroke="#A371F7"
            strokeDasharray="6 4"
            strokeOpacity={0.6}
            label={{
              value: `Weekly ${redThresholds.weekly}%`,
              position: 'right',
              fill: '#A371F7',
              fontSize: 10,
            }}
          />

          {/* Usage lines */}
          {LINE_KEYS.map((key) => (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              stroke={LINE_COLORS[key]}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: LINE_COLORS[key], stroke: '#161B22', strokeWidth: 2 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
