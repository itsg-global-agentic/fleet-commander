import { memo, useState } from 'react';
import type { TeamDashboardRow } from '../../shared/types';
import { formatIssueKey } from '../../shared/issue-provider';
import { StatusBadge } from './StatusBadge';
import { QueueBlockReason } from './QueueBlockReason';
import { PRBadge } from './PRBadge';
import { useApi } from '../hooks/useApi';

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

/** Format a USD cost to a compact string (e.g. "$3.57") */
function formatCost(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  return '$' + usd.toFixed(2);
}

// ---------------------------------------------------------------------------
// Props & equality comparator
// ---------------------------------------------------------------------------

interface TeamRowProps {
  team: TeamDashboardRow;
  selected: boolean;
  isThinking: boolean;
  onSelect: (teamId: number) => void;
}

/** Custom shallow equality for React.memo — only re-render when visible data changes */
function areTeamRowPropsEqual(prev: TeamRowProps, next: TeamRowProps): boolean {
  if (prev.selected !== next.selected) return false;
  if (prev.isThinking !== next.isThinking) return false;
  if (prev.onSelect !== next.onSelect) return false;

  const a = prev.team;
  const b = next.team;

  return (
    a.id === b.id &&
    a.status === b.status &&
    a.phase === b.phase &&
    a.lastEventAt === b.lastEventAt &&
    a.prNumber === b.prNumber &&
    a.ciStatus === b.ciStatus &&
    a.prState === b.prState &&
    a.mergeStatus === b.mergeStatus &&
    a.totalInputTokens === b.totalInputTokens &&
    a.totalOutputTokens === b.totalOutputTokens &&
    a.totalCacheCreationTokens === b.totalCacheCreationTokens &&
    a.totalCacheReadTokens === b.totalCacheReadTokens &&
    a.totalCostUsd === b.totalCostUsd &&
    a.durationMin === b.durationMin &&
    a.model === b.model &&
    a.modelInherited === b.modelInherited &&
    a.issueTitle === b.issueTitle &&
    a.projectName === b.projectName &&
    a.issueNumber === b.issueNumber &&
    a.issueKey === b.issueKey &&
    a.issueProvider === b.issueProvider &&
    a.githubRepo === b.githubRepo &&
    a.retryCount === b.retryCount &&
    a.blockedByJson === b.blockedByJson &&
    a.maxActiveTeams === b.maxActiveTeams
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const TeamRow = memo(function TeamRow({ team, selected, isThinking: teamIsThinking, onSelect }: TeamRowProps) {
  const api = useApi();
  const [stopping, setStopping] = useState(false);
  const [forceLaunching, setForceLaunching] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [restarting, setRestarting] = useState(false);

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

  const handleForceLaunch = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (forceLaunching) return;
    setForceLaunching(true);
    try {
      await api.post(`teams/${team.id}/force-launch`);
    } catch {
      // Ignore — the SSE stream will reflect actual state
    } finally {
      setForceLaunching(false);
    }
  };

  const handleRetry = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (retrying) return;
    setRetrying(true);
    try {
      await api.post(`teams/${team.id}/resume`);
    } catch {
      // Ignore — the SSE stream will reflect actual state
    } finally {
      setRetrying(false);
    }
  };

  const handleRestart = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (restarting) return;
    setRestarting(true);
    try {
      await api.post(`teams/${team.id}/restart`);
    } catch {
      // Ignore — the SSE stream will reflect actual state
    } finally {
      setRestarting(false);
    }
  };

  const handleClick = () => {
    onSelect(team.id);
  };

  const isActive = team.status === 'running' || team.status === 'stuck' || team.status === 'idle' || team.status === 'launching';
  const title = team.issueTitle ? truncate(team.issueTitle, 40) : 'Untitled';

  // Last activity — minutes since last event (skip for terminal teams)
  const isTerminal = team.status === 'done' || team.status === 'failed';
  let activityLabel = '\u2014';
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
      onClick={handleClick}
      className={`h-16 border-b border-dark-border cursor-pointer transition-colors group ${
        selected
          ? 'bg-dark-accent/10'
          : 'bg-dark-surface hover:bg-[#1C2128]'
      }`}
    >
      {/* Status */}
      <td className="px-4 whitespace-nowrap">
        <StatusBadge status={team.status} retryCount={team.retryCount} />
        {team.status === 'queued' && <QueueBlockReason team={team} />}
      </td>

      {/* Project */}
      <td className="px-4 whitespace-nowrap">
        <span className="text-sm text-dark-muted">
          {team.projectName ?? '\u2014'}
        </span>
      </td>

      {/* Issue */}
      <td className="px-4 whitespace-nowrap">
        <span className="text-sm">
          <span className="text-dark-muted mr-1.5">{formatIssueKey(team.issueKey ?? String(team.issueNumber), team.issueProvider)}</span>
          <span className="text-dark-text">{title}</span>
        </span>
      </td>

      {/* Model */}
      <td className="px-4 whitespace-nowrap">
        <span
          className={`text-sm ${team.modelInherited ? 'text-dark-muted/50' : 'text-dark-muted'}`}
          title={team.modelInherited ? 'FC default' : undefined}
        >
          {team.model}
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
        {teamIsThinking ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-[#E8976C]">
            <span className="inline-block w-2 h-2 rounded-full bg-[#E8976C] animate-thinking-dot" />
            thinking...
          </span>
        ) : (
          <span className={`text-sm ${activityColor}`} title={team.lastEventAt ?? undefined}>
            {activityLabel}
          </span>
        )}
      </td>

      {/* Cost */}
      <td className="px-4 whitespace-nowrap">
        {(team.totalInputTokens + team.totalOutputTokens) > 0 ? (
          <span
            className="text-sm text-dark-muted"
            title={`Input: ${formatTokens(team.totalInputTokens)}, Output: ${formatTokens(team.totalOutputTokens)}, Cache: ${formatTokens(team.totalCacheCreationTokens + team.totalCacheReadTokens)}`}
          >
            {formatCost(team.totalCostUsd)}
          </span>
        ) : (
          <span className="text-sm text-dark-muted">{'\u2014'}</span>
        )}
      </td>

      {/* PR */}
      <td className="px-4 whitespace-nowrap">
        <PRBadge prNumber={team.prNumber} ciStatus={team.ciStatus} teamId={team.id} prState={team.prState} githubRepo={team.githubRepo} />
      </td>

      {/* Actions */}
      <td className="px-4 whitespace-nowrap">
        <span className="inline-flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
          {team.status === 'queued' && (
            <button
              onClick={handleForceLaunch}
              disabled={forceLaunching}
              className="px-2 py-1 text-xs rounded border border-dark-border text-dark-muted hover:text-[#D29922] hover:border-[#D29922]/50 transition-colors disabled:opacity-50"
              title="Launch immediately despite usage limit"
            >
              {forceLaunching ? 'Launching\u2026' : 'Force Launch'}
            </button>
          )}
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
          {team.status === 'failed' && (
            <>
              <button
                onClick={handleRetry}
                disabled={retrying}
                className="px-2 py-1 text-xs rounded border border-dark-border text-dark-muted hover:text-[#3FB950] hover:border-[#3FB950]/50 transition-colors disabled:opacity-50"
                title="Re-queue team (respects queue order)"
              >
                {retrying ? 'Retrying\u2026' : 'Retry'}
              </button>
              <button
                onClick={handleRestart}
                disabled={restarting}
                className="px-2 py-1 text-xs rounded border border-dark-border text-dark-muted hover:text-dark-accent hover:border-dark-accent/50 transition-colors disabled:opacity-50"
                title="Restart team (bypasses queue)"
              >
                {restarting ? 'Restarting\u2026' : 'Restart'}
              </button>
            </>
          )}
        </span>
      </td>
    </tr>
  );
}, areTeamRowPropsEqual);
