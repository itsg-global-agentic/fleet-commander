import { useState, useEffect, useRef, useCallback } from 'react';
import { useApi } from '../hooks/useApi';
import { CIChecks } from './CIChecks';
import type { TeamDetail } from '../../shared/types';

// ---------------------------------------------------------------------------
// State badge color map
// ---------------------------------------------------------------------------

const STATE_COLORS: Record<string, { color: string; label: string }> = {
  open: { color: '#3FB950', label: 'OPEN' },
  merged: { color: '#A371F7', label: 'MERGED' },
  closed: { color: '#8B949E', label: 'CLOSED' },
  draft: { color: '#8B949E', label: 'DRAFT' },
};

const MERGE_STATUS_COLORS: Record<string, string> = {
  clean: '#3FB950',
  behind: '#D29922',
  blocked: '#F85149',
  dirty: '#F85149',
  unstable: '#D29922',
  has_hooks: '#D29922',
  draft: '#8B949E',
  unknown: '#8B949E',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface PRDetailProps {
  prNumber: number;
  teamId: number;
  onClose: () => void;
}

export function PRDetail({ prNumber, teamId, onClose }: PRDetailProps) {
  const api = useApi();
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Fetch team detail (which includes PR info with checks)
  useEffect(() => {
    let cancelled = false;

    async function fetchDetail() {
      setLoading(true);
      setError(null);
      try {
        const data = await api.get<TeamDetail>(`teams/${teamId}`);
        if (!cancelled) {
          setDetail(data);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load PR detail');
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
  }, [teamId, api]);

  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    // Delay attaching so the opening click doesn't immediately close
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  // Action: enable/disable auto-merge
  const handleAutoMerge = useCallback(
    async (enable: boolean) => {
      if (actionLoading) return;
      const action = enable ? 'enable-auto-merge' : 'disable-auto-merge';
      setActionLoading(action);
      try {
        await api.post(`prs/${prNumber}/${action}`);
        // Refresh detail
        const data = await api.get<TeamDetail>(`teams/${teamId}`);
        setDetail(data);
      } catch {
        // Errors are transient; poller will sync state
      } finally {
        setActionLoading(null);
      }
    },
    [actionLoading, api, prNumber, teamId],
  );

  // Action: update branch
  const handleUpdateBranch = useCallback(async () => {
    if (actionLoading) return;
    setActionLoading('update-branch');
    try {
      await api.post(`prs/${prNumber}/update-branch`);
      // Refresh detail
      const data = await api.get<TeamDetail>(`teams/${teamId}`);
      setDetail(data);
    } catch {
      // Errors are transient
    } finally {
      setActionLoading(null);
    }
  }, [actionLoading, api, prNumber, teamId]);

  const pr = detail?.pr ?? null;
  const stateInfo = STATE_COLORS[pr?.state ?? ''] ?? { color: '#8B949E', label: 'UNKNOWN' };
  const mergeStatusColor = MERGE_STATUS_COLORS[(pr?.mergeStatus ?? 'unknown').toLowerCase()] ?? '#8B949E';
  const isOpen = pr?.state === 'open';

  return (
    <div
      ref={popoverRef}
      className="absolute top-full left-0 mt-1.5 z-50 w-[360px] bg-[#1C2128] border border-dark-border rounded-lg shadow-2xl"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-8">
          <span className="text-dark-muted text-sm">Loading PR details...</span>
        </div>
      )}

      {/* Error state */}
      {error && !loading && (
        <div className="flex items-center justify-center py-8">
          <span className="text-[#F85149] text-sm">{error}</span>
        </div>
      )}

      {/* Content */}
      {!loading && !error && pr && (
        <div className="p-4 space-y-3">
          {/* Header: PR number as link */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-dark-accent">
              PR #{pr.number}
            </span>
            <button
              onClick={onClose}
              className="text-dark-muted hover:text-dark-text transition-colors p-0.5 rounded hover:bg-dark-border/30"
              title="Close"
            >
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          </div>

          {/* State + Merge status row */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* State badge */}
            <span
              className="text-xs font-medium px-2 py-0.5 rounded border"
              style={{
                color: stateInfo.color,
                borderColor: stateInfo.color + '40',
                backgroundColor: stateInfo.color + '10',
              }}
            >
              {stateInfo.label}
            </span>

            {/* Merge status — hide for merged/closed PRs where GitHub returns "unknown" */}
            {pr.mergeStatus && pr.state !== 'merged' && pr.state !== 'closed' && (
              <span
                className="text-xs px-2 py-0.5 rounded border"
                style={{
                  color: mergeStatusColor,
                  borderColor: mergeStatusColor + '40',
                  backgroundColor: mergeStatusColor + '10',
                }}
              >
                {pr.mergeStatus.toUpperCase()}
              </span>
            )}

            {/* Auto-merge indicator */}
            {pr.autoMerge && (
              <span className="text-xs text-[#3FB950] flex items-center gap-1">
                <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M5.22 14.78a.75.75 0 001.06 0l7.22-7.22v5.69a.75.75 0 001.5 0v-7.5a.75.75 0 00-.75-.75h-7.5a.75.75 0 000 1.5h5.69l-7.22 7.22a.75.75 0 000 1.06z" />
                </svg>
                Auto-merge
              </span>
            )}
          </div>

          {/* CI Checks section */}
          <div>
            <p className="text-xs text-dark-muted mb-1.5 uppercase tracking-wide font-medium">
              CI Checks
              {pr.ciFailCount > 0 && (
                <span className="ml-1.5 text-[#F85149] normal-case">
                  ({pr.ciFailCount} failing)
                </span>
              )}
            </p>
            <div className="max-h-[200px] overflow-y-auto custom-scrollbar">
              <CIChecks checks={pr.checks ?? []} />
            </div>
          </div>

          {/* Actions (only for open PRs) */}
          {isOpen && (
            <div className="pt-2 border-t border-dark-border/50">
              <div className="flex items-center gap-2">
                {/* Auto-merge toggle */}
                {pr.autoMerge ? (
                  <button
                    onClick={() => handleAutoMerge(false)}
                    disabled={actionLoading !== null}
                    className="px-2.5 py-1 text-xs rounded border border-dark-border text-dark-muted hover:text-[#F85149] hover:border-[#F85149]/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {actionLoading === 'disable-auto-merge' ? 'Disabling...' : 'Disable Auto-merge'}
                  </button>
                ) : (
                  <button
                    onClick={() => handleAutoMerge(true)}
                    disabled={actionLoading !== null}
                    className="px-2.5 py-1 text-xs rounded border border-[#3FB950]/40 text-[#3FB950] hover:bg-[#3FB950]/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {actionLoading === 'enable-auto-merge' ? 'Enabling...' : 'Enable Auto-merge'}
                  </button>
                )}

                {/* Update branch button */}
                <button
                  onClick={handleUpdateBranch}
                  disabled={actionLoading !== null}
                  className="px-2.5 py-1 text-xs rounded border border-dark-accent/40 text-dark-accent hover:bg-dark-accent/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {actionLoading === 'update-branch' ? 'Updating...' : 'Update Branch'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* No PR data found */}
      {!loading && !error && !pr && (
        <div className="flex items-center justify-center py-8">
          <span className="text-dark-muted text-sm">PR #{prNumber} details not available</span>
        </div>
      )}
    </div>
  );
}
