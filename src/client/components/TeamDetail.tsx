import { useState, useEffect, useCallback, useRef } from 'react';
import { useFleet } from '../context/FleetContext';
import { useApi } from '../hooks/useApi';
import { StatusBadge } from './StatusBadge';
import { CIChecks } from './CIChecks';
import { EventTimeline } from './EventTimeline';
import { CommandInput } from './CommandInput';
import type { TeamDetail as TeamDetailType } from '../../shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format duration in minutes to "Xh Ym" or "Xm" */
function formatDuration(minutes: number | undefined | null): string {
  if (minutes == null || minutes < 0) return '0m';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Phase labels for display */
const PHASE_LABELS: Record<string, string> = {
  init: 'Init',
  analyzing: 'Analyzing',
  implementing: 'Implementing',
  reviewing: 'Reviewing',
  pr: 'PR',
  done: 'Done',
  blocked: 'Blocked',
};

/** Phase badge colors */
const PHASE_COLORS: Record<string, string> = {
  init: '#8B949E',
  analyzing: '#58A6FF',
  implementing: '#D29922',
  reviewing: '#A371F7',
  pr: '#3FB950',
  done: '#56D4DD',
  blocked: '#F85149',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TeamDetail() {
  const { selectedTeamId, setSelectedTeamId, lastEvent } = useFleet();
  const api = useApi();
  const [detail, setDetail] = useState<TeamDetailType | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);

  const isOpen = selectedTeamId !== null;

  // Fetch team detail when selectedTeamId changes
  useEffect(() => {
    if (selectedTeamId == null) {
      setDetail(null);
      return;
    }

    let cancelled = false;

    async function fetchDetail() {
      setLoading(true);
      setError(null);
      try {
        const data = await api.get<TeamDetailType>(`teams/${selectedTeamId}`);
        if (!cancelled) {
          setDetail(data);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load team detail');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchDetail();

    return () => {
      cancelled = true;
    };
  }, [selectedTeamId, api]);

  // Refresh detail on SSE updates (when lastEvent changes and panel is open)
  useEffect(() => {
    if (selectedTeamId == null || !lastEvent) return;

    let cancelled = false;

    async function refreshDetail() {
      try {
        const data = await api.get<TeamDetailType>(`teams/${selectedTeamId}`);
        if (!cancelled) {
          setDetail(data);
          setRefreshKey((k) => k + 1);
        }
      } catch {
        // Silently ignore refresh errors — stale data is acceptable
      }
    }

    refreshDetail();

    return () => {
      cancelled = true;
    };
  }, [lastEvent, selectedTeamId, api]);

  // Close panel handler
  const handleClose = useCallback(() => {
    setSelectedTeamId(null);
  }, [setSelectedTeamId]);

  // Escape key to close
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && isOpen) {
        handleClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose]);

  // Click outside to close
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        handleClose();
      }
    },
    [handleClose],
  );

  // Action handlers
  const handleAction = useCallback(
    async (action: 'stop' | 'resume' | 'restart') => {
      if (!selectedTeamId || actionLoading) return;
      setActionLoading(action);
      try {
        await api.post(`teams/${selectedTeamId}/${action}`);
        // Refresh detail after action
        const data = await api.get<TeamDetailType>(`teams/${selectedTeamId}`);
        setDetail(data);
        setRefreshKey((k) => k + 1);
      } catch {
        // Action errors are transient; SSE will update the real state
      } finally {
        setActionLoading(null);
      }
    },
    [selectedTeamId, actionLoading, api],
  );

  // Determine which action buttons to show
  const isActive =
    detail?.status === 'running' ||
    detail?.status === 'idle' ||
    detail?.status === 'stuck' ||
    detail?.status === 'launching';

  const isStopped =
    detail?.status === 'done' ||
    detail?.status === 'failed' ||
    detail?.status === 'idle';

  // PR merge status label
  const mergeStatusLabel = detail?.pr?.mergeStatus ?? null;

  return (
    <>
      {/* Backdrop overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-40 transition-opacity"
          onClick={handleBackdropClick}
          aria-hidden="true"
        />
      )}

      {/* Slide-over panel */}
      <div
        ref={panelRef}
        className={`fixed top-0 right-0 h-full w-[520px] max-w-full bg-dark-surface border-l border-dark-border z-50 flex flex-col shadow-2xl transition-transform duration-300 ease-in-out ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Panel header with close button */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-dark-border shrink-0">
          <h2 className="text-lg font-semibold text-dark-text truncate">
            Team Detail
          </h2>
          <button
            onClick={handleClose}
            className="text-dark-muted hover:text-dark-text transition-colors p-1 rounded hover:bg-dark-border/30"
            title="Close panel (Esc)"
          >
            <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          {loading && !detail && (
            <div className="flex items-center justify-center py-16">
              <span className="text-dark-muted">Loading...</span>
            </div>
          )}

          {error && !detail && (
            <div className="flex items-center justify-center py-16">
              <span className="text-[#F85149]">{error}</span>
            </div>
          )}

          {detail && (
            <div className="p-5 space-y-6">
              {/* ---- Header Section ---- */}
              <section>
                <h3 className="text-base font-semibold text-dark-text mb-2">
                  <span className="text-dark-muted mr-1.5">#{detail.issueNumber}</span>
                  {detail.issueTitle ?? 'Untitled'}
                </h3>

                <div className="flex items-center gap-3 flex-wrap">
                  <StatusBadge status={detail.status} />

                  {/* Phase badge */}
                  <span
                    className="text-xs font-medium px-2 py-0.5 rounded border"
                    style={{
                      color: PHASE_COLORS[detail.phase] ?? '#8B949E',
                      borderColor: (PHASE_COLORS[detail.phase] ?? '#8B949E') + '40',
                      backgroundColor: (PHASE_COLORS[detail.phase] ?? '#8B949E') + '10',
                    }}
                  >
                    {PHASE_LABELS[detail.phase] ?? detail.phase}
                  </span>
                </div>

                {/* Duration + Cost row */}
                <div className="flex items-center gap-4 mt-3 text-sm">
                  <span className="text-dark-muted">
                    Duration: <span className="text-dark-text">{formatDuration(detail.durationMin)}</span>
                  </span>
                  <span className="text-dark-muted">
                    Cost: <span className="text-dark-text">${(detail.totalCost ?? 0).toFixed(2)}</span>
                  </span>
                  <span className="text-dark-muted">
                    Sessions: <span className="text-dark-text">{detail.sessionCount ?? 0}</span>
                  </span>
                </div>

                {/* Worktree info */}
                <div className="mt-2 text-xs text-dark-muted">
                  <span>Worktree: {detail.worktreeName}</span>
                  {detail.branchName && (
                    <span className="ml-3">Branch: {detail.branchName}</span>
                  )}
                </div>
              </section>

              {/* ---- PR Section ---- */}
              {detail.pr && (
                <section>
                  <h4 className="text-sm font-semibold text-dark-text mb-2 border-b border-dark-border/50 pb-1">
                    Pull Request
                  </h4>

                  <div className="flex items-center gap-3 mb-3 text-sm">
                    <span className="text-dark-accent font-medium">
                      PR #{detail.pr.number}
                    </span>
                    <span
                      className="text-xs px-1.5 py-0.5 rounded border"
                      style={{
                        color:
                          detail.pr.state === 'merged'
                            ? '#A371F7'
                            : detail.pr.state === 'open'
                              ? '#3FB950'
                              : detail.pr.state === 'closed'
                                ? '#F85149'
                                : '#8B949E',
                        borderColor:
                          (detail.pr.state === 'merged'
                            ? '#A371F7'
                            : detail.pr.state === 'open'
                              ? '#3FB950'
                              : detail.pr.state === 'closed'
                                ? '#F85149'
                                : '#8B949E') + '40',
                      }}
                    >
                      {detail.pr.state?.toUpperCase() ?? 'UNKNOWN'}
                    </span>
                    {mergeStatusLabel && (
                      <span className="text-xs text-dark-muted">
                        Merge: {mergeStatusLabel}
                      </span>
                    )}
                    {detail.pr.autoMerge && (
                      <span className="text-xs text-[#3FB950]">Auto-merge</span>
                    )}
                  </div>

                  {/* CI Checks */}
                  <div className="ml-1">
                    <p className="text-xs text-dark-muted mb-1.5 uppercase tracking-wide">CI Checks</p>
                    <CIChecks checks={detail.pr.checks ?? []} />
                  </div>
                </section>
              )}

              {!detail.pr && detail.prNumber && (
                <section>
                  <h4 className="text-sm font-semibold text-dark-text mb-2 border-b border-dark-border/50 pb-1">
                    Pull Request
                  </h4>
                  <p className="text-sm text-dark-muted">PR #{detail.prNumber} (details loading...)</p>
                </section>
              )}

              {/* ---- Event Timeline ---- */}
              <section>
                <h4 className="text-sm font-semibold text-dark-text mb-2 border-b border-dark-border/50 pb-1">
                  Recent Events
                </h4>
                <EventTimeline teamId={detail.id} refreshKey={refreshKey} />
              </section>

              {/* ---- Command Input ---- */}
              <section>
                <h4 className="text-sm font-semibold text-dark-text mb-2 border-b border-dark-border/50 pb-1">
                  Send Command
                </h4>
                <CommandInput teamId={detail.id} />
              </section>

              {/* ---- Action Buttons ---- */}
              <section>
                <h4 className="text-sm font-semibold text-dark-text mb-2 border-b border-dark-border/50 pb-1">
                  Actions
                </h4>
                <div className="flex items-center gap-2 flex-wrap">
                  {isActive && (
                    <button
                      onClick={() => handleAction('stop')}
                      disabled={actionLoading !== null}
                      className="px-3 py-1.5 text-sm rounded border border-[#F85149]/40 text-[#F85149] hover:bg-[#F85149]/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {actionLoading === 'stop' ? 'Stopping...' : 'Stop'}
                    </button>
                  )}

                  {isStopped && (
                    <button
                      onClick={() => handleAction('resume')}
                      disabled={actionLoading !== null}
                      className="px-3 py-1.5 text-sm rounded border border-[#3FB950]/40 text-[#3FB950] hover:bg-[#3FB950]/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {actionLoading === 'resume' ? 'Resuming...' : 'Resume'}
                    </button>
                  )}

                  <button
                    onClick={() => handleAction('restart')}
                    disabled={actionLoading !== null}
                    className="px-3 py-1.5 text-sm rounded border border-dark-accent/40 text-dark-accent hover:bg-dark-accent/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {actionLoading === 'restart' ? 'Restarting...' : 'Restart'}
                  </button>
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
