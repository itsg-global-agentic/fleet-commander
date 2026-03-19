import { useState, useEffect, useCallback, useRef } from 'react';
import { useFleet } from '../context/FleetContext';
import { useApi } from '../hooks/useApi';
import { StatusBadge } from './StatusBadge';
import { CIChecks } from './CIChecks';
import { EventTimeline } from './EventTimeline';
import { TeamOutput } from './TeamOutput';
import { CommandInput } from './CommandInput';
import { CommGraph } from './CommGraph';
import type { TeamDetail as TeamDetailType, TeamTransition, TeamMember, MessageEdge } from '../../shared/types';
import { STATUS_COLORS } from '../utils/constants';

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

/** Deterministic color from agent name — hash name to pick from a palette. */
const AGENT_PALETTE = [
  '#58A6FF', '#3FB950', '#D29922', '#A371F7', '#F778BA',
  '#79C0FF', '#7EE787', '#E3B341', '#D2A8FF', '#FF7B72',
];

function agentColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return AGENT_PALETTE[Math.abs(hash) % AGENT_PALETTE.length];
}

/** Format a relative time string like "2m", "1h", "just now" */
function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return `${h}h`;
}

/** Truncate agent name to fit in a small card */
function truncateName(name: string, maxLen = 5): string {
  if (name.length <= maxLen) return name;
  return name.slice(0, maxLen);
}

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
  const [quickActionLoading, setQuickActionLoading] = useState<string | null>(null);
  const [quickActionSent, setQuickActionSent] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [transitions, setTransitions] = useState<TeamTransition[]>([]);
  const [roster, setRoster] = useState<TeamMember[]>([]);
  const [activeTab, setActiveTab] = useState<'activity' | 'communication'>('activity');
  const [messageEdges, setMessageEdges] = useState<MessageEdge[]>([]);
  const templateCacheRef = useRef<{ data: Array<{ id: string; template: string; enabled: boolean }>; fetchedAt: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedTeamIdRef = useRef(selectedTeamId);

  const isOpen = selectedTeamId !== null;

  // Keep ref in sync with selectedTeamId for use in async callbacks
  useEffect(() => {
    selectedTeamIdRef.current = selectedTeamId;
  }, [selectedTeamId]);

  // Fetch transitions when selectedTeamId changes or detail refreshes
  useEffect(() => {
    if (selectedTeamId == null) {
      setTransitions([]);
      return;
    }

    let cancelled = false;

    async function fetchTransitions() {
      try {
        const data = await api.get<TeamTransition[]>(`teams/${selectedTeamId}/transitions`);
        if (!cancelled) {
          setTransitions(data);
        }
      } catch {
        // Non-critical — transitions are informational
      }
    }

    fetchTransitions();

    return () => {
      cancelled = true;
    };
  }, [selectedTeamId, refreshKey, api]);

  // Fetch roster when selectedTeamId changes or detail refreshes
  useEffect(() => {
    if (selectedTeamId == null) {
      setRoster([]);
      return;
    }

    let cancelled = false;

    async function fetchRoster() {
      try {
        const data = await api.get<TeamMember[]>(`teams/${selectedTeamId}/roster`);
        if (!cancelled) {
          setRoster(data);
        }
      } catch {
        // Non-critical — roster is informational
      }
    }

    fetchRoster();

    return () => {
      cancelled = true;
    };
  }, [selectedTeamId, refreshKey, api]);

  // Fetch message edges when selectedTeamId changes or detail refreshes
  useEffect(() => {
    if (selectedTeamId == null) {
      setMessageEdges([]);
      return;
    }

    let cancelled = false;

    async function fetchEdges() {
      try {
        const data = await api.get<MessageEdge[]>(`teams/${selectedTeamId}/messages/summary`);
        if (!cancelled) {
          setMessageEdges(data);
        }
      } catch {
        // Non-critical — comm graph is informational
      }
    }

    fetchEdges();

    return () => {
      cancelled = true;
    };
  }, [selectedTeamId, refreshKey, api]);

  // Reset active tab when team changes
  useEffect(() => {
    setActiveTab('activity');
  }, [selectedTeamId]);

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
  // Debounced to 2 seconds to avoid hammering the REST API on rapid SSE events
  useEffect(() => {
    if (selectedTeamId == null || !lastEvent) return;

    // Clear any pending debounce timer
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
    }

    const teamIdAtSchedule = selectedTeamId;

    refreshTimerRef.current = setTimeout(async () => {
      try {
        const data = await api.get<TeamDetailType>(`teams/${teamIdAtSchedule}`);
        // Guard against stale response if panel switched teams
        if (selectedTeamIdRef.current === teamIdAtSchedule) {
          setDetail(data);
          setRefreshKey((k) => k + 1);
        }
      } catch {
        // Silently ignore refresh errors — stale data is acceptable
      }
    }, 2000);

    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
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
      const teamId = selectedTeamId;
      setActionLoading(action);
      try {
        await api.post(`teams/${teamId}/${action}`);
        if (selectedTeamIdRef.current !== teamId) return;
        // Refresh detail after action
        const data = await api.get<TeamDetailType>(`teams/${teamId}`);
        if (selectedTeamIdRef.current !== teamId) return;
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

  // Quick action handler — send a pre-defined message template to the team
  // Templates are cached for 60s to avoid re-fetching on every click.
  const handleQuickAction = useCallback(
    async (templateId: string) => {
      if (!selectedTeamId || !detail || quickActionLoading) return;
      setQuickActionLoading(templateId);
      try {
        // Use cached templates if fresh (< 60s), otherwise re-fetch
        const CACHE_TTL = 60_000;
        let templates: Array<{ id: string; template: string; enabled: boolean }>;
        const cached = templateCacheRef.current;
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
          templates = cached.data;
        } else {
          templates = await api.get<Array<{ id: string; template: string; enabled: boolean }>>('message-templates');
          templateCacheRef.current = { data: templates, fetchedAt: Date.now() };
        }

        const tmpl = templates.find(t => t.id === templateId);
        if (!tmpl || !tmpl.enabled) return;

        // Replace placeholders
        let message = tmpl.template;
        message = message.replace(/\{\{ISSUE_NUMBER\}\}/g, String(detail.issueNumber));
        if (detail.prNumber) {
          message = message.replace(/\{\{PR_NUMBER\}\}/g, String(detail.prNumber));
        }

        await api.post(`teams/${selectedTeamId}/send-message`, { message });

        // Show brief "Sent!" confirmation
        setQuickActionSent(templateId);
        setTimeout(() => setQuickActionSent((prev) => prev === templateId ? null : prev), 1500);
      } catch {
        // Silent — message will appear in session log if delivered
      } finally {
        setQuickActionLoading(null);
      }
    },
    [selectedTeamId, detail, quickActionLoading, api],
  );

  // Determine which action buttons to show
  const isActive =
    detail?.status === 'running' ||
    detail?.status === 'idle' ||
    detail?.status === 'stuck' ||
    detail?.status === 'launching';

  const isStopped =
    detail?.status === 'done' ||
    detail?.status === 'failed';

  // PR merge status label — hide when PR is merged or closed (GitHub returns
  // "unknown" for mergeStateStatus once a PR is no longer open, which is confusing)
  const mergeStatusLabel =
    detail?.pr && detail.pr.state !== 'merged' && detail.pr.state !== 'closed'
      ? (detail.pr.mergeStatus ?? null)
      : null;

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
        className={`fixed top-0 right-0 h-full w-[960px] max-w-full bg-dark-surface border-l border-dark-border z-50 flex flex-col shadow-2xl transition-transform duration-300 ease-in-out ${
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

        {/* Content area */}
        <div className="flex-1 flex flex-col min-h-0">
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
            <>
              {/* TOP: Metadata — scrollable if needed */}
              <div className="shrink-0 overflow-y-auto max-h-[40%] custom-scrollbar">
                <div className="p-5 space-y-4">
                  {/* ---- Header Section ---- */}
                  <section>
                    <h3 className="text-base font-semibold text-dark-text mb-2">
                      <span className="text-dark-muted mr-1.5">#{detail.issueNumber}</span>
                      {detail.issueTitle ?? 'Untitled'}
                    </h3>

                    <div className="flex items-center gap-3 flex-wrap">
                      <StatusBadge status={detail.status} />
                    </div>

                    {/* Duration + Last Activity row */}
                    <div className="flex items-center gap-4 mt-3 text-sm">
                      <span className="text-dark-muted">
                        Duration: <span className="text-dark-text">{formatDuration(detail.durationMin)}</span>
                      </span>
                      {detail.lastEventAt && !isStopped && (
                        <span className="text-dark-muted">
                          Last activity: <span className="text-dark-text">
                            {(() => {
                              const agoMin = Math.floor((Date.now() - new Date(detail.lastEventAt).getTime()) / 60000);
                              if (agoMin < 1) return 'just now';
                              return `${agoMin}m ago`;
                            })()}
                          </span>
                        </span>
                      )}
                    </div>

                    {/* Worktree info */}
                    <div className="mt-2 text-xs text-dark-muted">
                      <span>Worktree: {detail.worktreeName}</span>
                      {detail.branchName && (
                        <span className="ml-3">Branch: {detail.branchName}</span>
                      )}
                      <span className="ml-3">Model: {detail.model ?? '\u2014'}</span>
                    </div>

                    {/* Token breakdown */}
                    {(detail.totalInputTokens + detail.totalOutputTokens) > 0 && (
                      <div className="mt-3 flex items-center gap-4 text-sm">
                        <span className="text-dark-muted">
                          Input: <span className="text-dark-text">{detail.totalInputTokens.toLocaleString()}</span>
                        </span>
                        <span className="text-dark-muted">
                          Output: <span className="text-dark-text">{detail.totalOutputTokens.toLocaleString()}</span>
                        </span>
                        {(detail.totalCacheCreationTokens + detail.totalCacheReadTokens) > 0 && (
                          <span className="text-dark-muted">
                            Cache: <span className="text-dark-text">
                              {(detail.totalCacheCreationTokens + detail.totalCacheReadTokens).toLocaleString()}
                            </span>
                          </span>
                        )}
                        {detail.totalCostUsd > 0 && (
                          <span className="text-dark-muted">
                            Cost: <span className="text-[#3FB950]">${detail.totalCostUsd.toFixed(4)}</span>
                          </span>
                        )}
                      </div>
                    )}
                  </section>

                  {/* ---- Team Roster ---- */}
                  {roster.length > 0 && (
                    <section>
                      <h4 className="text-sm font-semibold text-dark-text mb-2 border-b border-dark-border/50 pb-1">
                        Team Members ({roster.filter(m => m.isActive).length} active)
                      </h4>
                      <div className="flex items-start gap-2 overflow-x-auto pb-1 custom-scrollbar">
                        {roster.map((member) => {
                          const color = agentColor(member.name);
                          const lastActivity = member.isActive ? relativeTime(member.lastSeen) : 'done';
                          return (
                            <div
                              key={member.name}
                              className="flex flex-col items-center w-14 shrink-0 group relative cursor-default"
                            >
                              {/* Status dot */}
                              <div
                                className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border-2"
                                style={{
                                  borderColor: member.isActive ? color : '#484F58',
                                  color: member.isActive ? color : '#484F58',
                                  backgroundColor: (member.isActive ? color : '#484F58') + '18',
                                }}
                              >
                                {member.name.charAt(0).toUpperCase()}
                              </div>
                              {/* Name */}
                              <span
                                className="text-[10px] mt-1 leading-tight text-center"
                                style={{ color: member.isActive ? '#E6EDF3' : '#484F58' }}
                              >
                                {truncateName(member.name)}
                              </span>
                              {/* Last activity */}
                              <span
                                className="text-[9px] leading-none"
                                style={{ color: member.isActive ? '#8B949E' : '#484F58' }}
                              >
                                {lastActivity}
                              </span>
                              {/* Tooltip */}
                              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1.5 bg-dark-surface border border-dark-border rounded text-[10px] text-dark-text whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10 shadow-lg">
                                <div className="font-semibold">{member.name}</div>
                                <div className="text-dark-muted">{member.role}</div>
                                <div className="text-dark-muted mt-0.5">
                                  Tools: {member.toolUseCount}
                                  {member.errorCount > 0 && (
                                    <span className="text-[#F85149] ml-1">Errors: {member.errorCount}</span>
                                  )}
                                </div>
                                <div className="text-dark-muted">
                                  First: {new Date(member.firstSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                  {' / '}
                                  Last: {new Date(member.lastSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  )}

                  {/* ---- Transition History ---- */}
                  {transitions.length > 0 && (
                    <section className="min-w-0">
                      <h4 className="text-sm font-semibold text-dark-text mb-2 border-b border-dark-border/50 pb-1">
                        State Transitions
                      </h4>
                      <div className="flex items-center gap-0 overflow-x-auto pb-1 custom-scrollbar max-w-full">
                        {transitions.map((t, i) => {
                          const isFirst = i === 0;
                          const toColor = STATUS_COLORS[t.toStatus] ?? '#8B949E';
                          const timeStr = (() => {
                            try {
                              const d = new Date(t.createdAt);
                              return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                            } catch {
                              return '';
                            }
                          })();
                          return (
                            <div key={t.id} className="flex items-center shrink-0">
                              {/* Show from_status pill only for the first transition */}
                              {isFirst && (
                                <>
                                  <div className="flex flex-col items-center">
                                    <span
                                      className="text-[10px] font-medium px-1.5 py-0.5 rounded"
                                      style={{
                                        color: STATUS_COLORS[t.fromStatus] ?? '#8B949E',
                                        backgroundColor: (STATUS_COLORS[t.fromStatus] ?? '#8B949E') + '18',
                                      }}
                                    >
                                      {t.fromStatus}
                                    </span>
                                  </div>
                                  <svg className="w-3 h-3 text-dark-muted shrink-0 mx-0.5" viewBox="0 0 12 12" fill="currentColor">
                                    <path d="M4.5 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" />
                                  </svg>
                                </>
                              )}
                              <div
                                className="flex flex-col items-center group relative"
                              >
                                <span
                                  className="text-[10px] font-medium px-1.5 py-0.5 rounded"
                                  style={{
                                    color: toColor,
                                    backgroundColor: toColor + '18',
                                  }}
                                >
                                  {t.toStatus}
                                </span>
                                <span className="text-[9px] text-dark-muted mt-0.5 leading-none">
                                  {timeStr}
                                </span>
                                {/* Tooltip with reason */}
                                {t.reason && (
                                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 bg-dark-surface border border-dark-border rounded text-[10px] text-dark-text whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10 shadow-lg max-w-[240px] truncate">
                                    {t.reason}
                                  </div>
                                )}
                              </div>
                              {i < transitions.length - 1 && (
                                <svg className="w-3 h-3 text-dark-muted shrink-0 mx-0.5" viewBox="0 0 12 12" fill="currentColor">
                                  <path d="M4.5 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" />
                                </svg>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  )}

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
                </div>
              </div>

              {/* MIDDLE: Tabbed content area */}
              <div className="flex-1 min-h-0 flex flex-col">
                {/* Tab bar */}
                <div className="shrink-0 flex items-center gap-0 px-5 border-b border-dark-border">
                  <button
                    onClick={() => setActiveTab('activity')}
                    className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                      activeTab === 'activity'
                        ? 'border-dark-accent text-dark-text'
                        : 'border-transparent text-dark-muted hover:text-dark-text'
                    }`}
                  >
                    Activity
                  </button>
                  <button
                    onClick={() => setActiveTab('communication')}
                    className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                      activeTab === 'communication'
                        ? 'border-dark-accent text-dark-text'
                        : 'border-transparent text-dark-muted hover:text-dark-text'
                    }`}
                  >
                    Communication
                  </button>
                </div>

                {/* Tab content */}
                {activeTab === 'activity' && (
                  <div className="flex-1 min-h-0 flex flex-col md:flex-row gap-4 px-5 py-3">
                    {/* Left: Events */}
                    <div className="flex-1 min-w-0 flex flex-col min-h-[200px] md:min-h-0">
                      <h4 className="text-sm font-semibold text-dark-text mb-2 border-b border-dark-border/50 pb-1 shrink-0">
                        Recent Events
                      </h4>
                      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                        <EventTimeline teamId={detail.id} refreshKey={refreshKey} />
                      </div>
                    </div>

                    {/* Right: Session Log */}
                    <div className="flex-1 min-w-0 flex flex-col min-h-[200px] md:min-h-0">
                      <h4 className="text-sm font-semibold text-dark-text mb-2 border-b border-dark-border/50 pb-1 shrink-0">
                        Session Log
                      </h4>
                      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                        <TeamOutput teamId={detail.id} teamStatus={detail.status} />
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === 'communication' && (
                  <div className="flex-1 min-h-0 px-5 py-3">
                    <CommGraph edges={messageEdges} agents={roster} />
                  </div>
                )}
              </div>

              {/* BOTTOM: Command + Actions footer */}
              <div className="shrink-0 border-t border-dark-border px-5 py-4 space-y-4">
                <CommandInput teamId={detail.id} disabled={!isActive} />
                {/* Quick Actions */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs text-dark-muted mr-1">Quick:</span>
                  {[
                    { id: 'nudge_progress', label: 'Status?', color: '#58A6FF' },
                    { id: 'ask_for_pr', label: 'Open PR', color: '#3FB950' },
                    { id: 'check_ci', label: 'Fix CI', color: '#F85149', show: !!detail?.prNumber },
                    { id: 'wrap_up', label: 'Wrap Up', color: '#D29922' },
                  ].filter(a => a.show !== false).map((action) => (
                    <button
                      key={action.id}
                      onClick={() => handleQuickAction(action.id)}
                      disabled={!isActive || quickActionLoading !== null}
                      className="px-2.5 py-1 text-xs rounded-full border transition-colors disabled:opacity-40"
                      style={{
                        color: action.color,
                        borderColor: action.color + '40',
                      }}
                      title={`Send "${action.label}" message to TL`}
                    >
                      {quickActionLoading === action.id
                          ? '...'
                          : quickActionSent === action.id
                            ? 'Sent!'
                            : action.label}
                    </button>
                  ))}
                </div>
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

                  <button
                    onClick={() => {
                      window.open(`/api/teams/${detail.id}/export?format=txt`, '_blank');
                    }}
                    className="px-3 py-1.5 text-sm rounded border border-dark-muted/40 text-dark-muted hover:text-dark-text hover:bg-dark-border/30 transition-colors flex items-center gap-1.5"
                    title="Export team log as text file"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z" />
                      <path d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06l1.97 1.969Z" />
                    </svg>
                    Export Log
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
