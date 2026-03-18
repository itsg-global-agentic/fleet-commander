import type { TeamDashboardRow } from '../../shared/types';
import { StatusBadge } from './StatusBadge';
import { PRBadge } from './PRBadge';
import { useApi } from '../hooks/useApi';
import { useState } from 'react';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format duration in minutes to "Xh Ym" or "Xm" */
function formatDuration(minutes: number): string {
  if (minutes < 0) return '0m';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Truncate a string to maxLen characters with ellipsis */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

/** Format a token count to a compact string (e.g. "125K", "1.2M") */
function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return (count / 1000).toFixed(count < 10_000 ? 1 : 0) + 'K';
  return (count / 1_000_000).toFixed(1) + 'M';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface TeamRowProps {
  team: TeamDashboardRow;
  selected: boolean;
  onClick: () => void;
}

export function TeamRow({ team, selected, onClick }: TeamRowProps) {
  const api = useApi();
  const [stopping, setStopping] = useState(false);

  const handleStop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (stopping) return;
    setStopping(true);
    try {
      await api.post(`teams/${team.id}/stop`);
    } catch {
      // Ignore — the SSE stream will reflect actual state
    } finally {
      setStopping(false);
    }
  };

  const isActive = team.status === 'running' || team.status === 'stuck' || team.status === 'idle' || team.status === 'launching';
  const title = team.issueTitle ? truncate(team.issueTitle, 40) : 'Untitled';

  // Last activity — minutes since last event (skip for terminal teams)
  const isTerminal = team.status === 'done' || team.status === 'failed';
  let activityLabel = '—';
  let activityColor = 'text-dark-muted';
  if (team.lastEventAt && !isTerminal) {
    const agoMs = Date.now() - new Date(team.lastEventAt).getTime();
    const agoMin = Math.floor(agoMs / 60000);
    if (agoMin < 1) {
      activityLabel = 'just now';
      activityColor = 'text-[#3FB950]';
    } else if (agoMin < 5) {
      activityLabel = `${agoMin}m ago`;
      activityColor = 'text-[#3FB950]';
    } else if (agoMin < 15) {
      activityLabel = `${agoMin}m ago`;
      activityColor = 'text-[#D29922]';
    } else {
      activityLabel = `${agoMin}m ago`;
      activityColor = 'text-[#F85149]';
    }
  }

  return (
    <tr
      onClick={onClick}
      className={`h-16 border-b border-dark-border cursor-pointer transition-colors group ${
        selected
          ? 'bg-dark-accent/10'
          : 'bg-dark-surface hover:bg-[#1C2128]'
      }`}
    >
      {/* Status */}
      <td className="px-4 whitespace-nowrap">
        <StatusBadge status={team.status} />
      </td>

      {/* Issue */}
      <td className="px-4 whitespace-nowrap">
        <span className="text-sm">
          <span className="text-dark-muted mr-1.5">#{team.issueNumber}</span>
          <span className="text-dark-text">{title}</span>
        </span>
      </td>

      {/* Model */}
      <td className="px-4 whitespace-nowrap">
        <span className="text-sm text-dark-muted">
          {team.model ?? '\u2014'}
        </span>
      </td>

      {/* Duration */}
      <td className="px-4 whitespace-nowrap">
        <span className="text-sm text-dark-muted">
          {formatDuration(team.durationMin ?? 0)}
        </span>
      </td>

      {/* Last Activity */}
      <td className="px-4 whitespace-nowrap">
        <span className={`text-sm ${activityColor}`} title={team.lastEventAt ?? undefined}>
          {activityLabel}
        </span>
      </td>

      {/* Tokens */}
      <td className="px-4 whitespace-nowrap">
        {(team.totalInputTokens + team.totalOutputTokens) > 0 ? (
          <span
            className="text-sm text-dark-muted"
            title={`Input: ${formatTokens(team.totalInputTokens)}, Output: ${formatTokens(team.totalOutputTokens)}, Cache: ${formatTokens(team.totalCacheCreationTokens + team.totalCacheReadTokens)}`}
          >
            {formatTokens(team.totalInputTokens + team.totalOutputTokens)}
          </span>
        ) : (
          <span className="text-sm text-dark-muted">{'\u2014'}</span>
        )}
      </td>

      {/* PR */}
      <td className="px-4 whitespace-nowrap">
        <PRBadge prNumber={team.prNumber} ciStatus={team.ciStatus} teamId={team.id} prState={team.prState} />
      </td>

      {/* Actions */}
      <td className="px-4 whitespace-nowrap">
        <span className="inline-flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
          {isActive && (
            <button
              onClick={handleStop}
              disabled={stopping}
              className="px-2 py-1 text-xs rounded border border-dark-border text-dark-muted hover:text-[#F85149] hover:border-[#F85149]/50 transition-colors disabled:opacity-50"
              title="Stop team"
            >
              {stopping ? 'Stopping\u2026' : 'Stop'}
            </button>
          )}
        </span>
      </td>
    </tr>
  );
}
