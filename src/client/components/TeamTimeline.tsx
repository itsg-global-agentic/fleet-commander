import { useMemo, useState } from 'react';
import type { TeamDashboardRow, TeamStatus } from '../../shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Status -> bar color */
const BAR_COLORS: Record<TeamStatus, string> = {
  running: '#3FB950',
  idle: '#D29922',
  launching: '#58A6FF',
  queued: '#8B949E',
  done: '#56D4DD',
  failed: '#F85149',
  stuck: '#F85149',
};

/** Format duration in minutes to "Xh Ym" or "Xm" */
function formatDuration(minutes: number): string {
  if (minutes < 1) return '<1m';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Format a date to a short relative label */
function relativeLabel(date: Date, now: Date): string {
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin <= 0) return 'now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.round(diffH / 24);
  return `${diffD}d ago`;
}

/** Truncate a string */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TeamTimelineProps {
  teams: TeamDashboardRow[];
}

interface BarInfo {
  team: TeamDashboardRow;
  startMs: number;
  endMs: number;
  isRunning: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TeamTimeline({ teams }: TeamTimelineProps) {
  const [hoveredId, setHoveredId] = useState<number | null>(null);

  const now = useMemo(() => Date.now(), []);

  // Build bar info for each team that has a launchedAt timestamp
  const bars = useMemo<BarInfo[]>(() => {
    return teams
      .filter((t) => t.launchedAt)
      .map((t) => {
        const startMs = new Date(t.launchedAt!).getTime();
        const isRunning =
          t.status === 'running' || t.status === 'launching' || t.status === 'idle' || t.status === 'stuck';
        const durationMs = (t.durationMin ?? 0) * 60_000;
        const endMs = isRunning ? now : startMs + durationMs;
        return { team: t, startMs, endMs, isRunning };
      })
      .sort((a, b) => a.startMs - b.startMs);
  }, [teams, now]);

  // Calculate the full time range
  const { rangeStart, rangeTotal } = useMemo(() => {
    if (bars.length === 0) {
      return { rangeStart: now - 3600_000, rangeTotal: 3600_000 };
    }
    const earliest = Math.min(...bars.map((b) => b.startMs));
    const latest = Math.max(...bars.map((b) => b.endMs), now);
    // Add 5% padding on each side
    const total = latest - earliest || 3600_000;
    const pad = total * 0.05;
    return {
      rangeStart: earliest - pad,
      rangeTotal: total + pad * 2,
    };
  }, [bars, now]);

  // Build time axis labels (up to 6 evenly spaced)
  const axisLabels = useMemo(() => {
    const count = 6;
    const step = rangeTotal / (count - 1);
    const nowDate = new Date(now);
    const labels: { pct: number; text: string }[] = [];
    for (let i = 0; i < count; i++) {
      const t = rangeStart + step * i;
      const pct = ((t - rangeStart) / rangeTotal) * 100;
      labels.push({ pct, text: relativeLabel(new Date(t), nowDate) });
    }
    return labels;
  }, [rangeStart, rangeTotal, now]);

  if (bars.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-dark-muted text-sm">
        No teams with timeline data
      </div>
    );
  }

  return (
    <div className="w-full overflow-x-auto">
      {/* Chart area */}
      <div className="min-w-[600px]">
        {/* Rows */}
        {bars.map(({ team, startMs, endMs, isRunning }) => {
          const leftPct = ((startMs - rangeStart) / rangeTotal) * 100;
          const widthPct = ((endMs - startMs) / rangeTotal) * 100;
          const clampedWidth = Math.max(widthPct, 0.5); // minimum visible width
          const color = BAR_COLORS[team.status] ?? '#8B949E';
          const isHovered = hoveredId === team.id;
          const title = team.issueTitle ? truncate(team.issueTitle, 30) : 'Untitled';

          return (
            <div
              key={team.id}
              className="flex items-center h-8 group"
              onMouseEnter={() => setHoveredId(team.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              {/* Team label */}
              <div className="w-[120px] min-w-[120px] pr-2 text-right text-xs text-dark-muted truncate shrink-0">
                #{team.issueNumber}
              </div>

              {/* Bar track */}
              <div className="relative flex-1 h-5 bg-dark-base rounded overflow-visible">
                {/* The bar */}
                <div
                  className={`absolute top-0 h-full rounded transition-opacity ${
                    isRunning ? 'timeline-bar-pulse' : ''
                  }`}
                  style={{
                    left: `${leftPct}%`,
                    width: `${clampedWidth}%`,
                    backgroundColor: color,
                    opacity: isHovered ? 1 : 0.8,
                  }}
                >
                  {/* Label on bar if wide enough */}
                  {clampedWidth > 8 && (
                    <span className="absolute inset-0 flex items-center px-1.5 text-[10px] font-medium text-dark-base truncate">
                      #{team.issueNumber} {formatDuration(team.durationMin ?? 0)}
                    </span>
                  )}
                </div>

                {/* Tooltip */}
                {isHovered && (
                  <div
                    className="absolute z-50 bottom-full mb-1 px-2.5 py-1.5 rounded bg-dark-surface border border-dark-border text-xs text-dark-text whitespace-nowrap shadow-lg pointer-events-none"
                    style={{
                      left: `${Math.min(leftPct + clampedWidth / 2, 90)}%`,
                      transform: 'translateX(-50%)',
                    }}
                  >
                    <div className="font-medium">
                      #{team.issueNumber} {title}
                    </div>
                    <div className="text-dark-muted mt-0.5">
                      {team.status} &middot; {formatDuration(team.durationMin ?? 0)}
                    </div>
                    {team.prNumber && (
                      <div className="text-dark-muted">
                        PR #{team.prNumber} &middot; CI: {team.ciStatus ?? 'none'}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* Time axis */}
        <div className="flex items-center h-6 mt-1">
          <div className="w-[120px] min-w-[120px] shrink-0" />
          <div className="relative flex-1 h-full border-t border-dark-border">
            {axisLabels.map((label, i) => (
              <span
                key={i}
                className="absolute top-1 text-[10px] text-dark-muted -translate-x-1/2"
                style={{ left: `${label.pct}%` }}
              >
                {label.text}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
