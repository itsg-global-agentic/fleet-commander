import { useState, useEffect, useCallback, useRef } from 'react';
import { useSelection, useConnection, useThinking } from '../context/FleetContext';
import { useApi } from '../hooks/useApi';
import { useTeamDetailData } from '../hooks/useTeamDetailData';
import { StatusBadge } from './StatusBadge';
import { CIChecks } from './CIChecks';
import { UnifiedTimeline } from './UnifiedTimeline';
import { CommandInput } from './CommandInput';
import { CommGraph } from './CommGraph';
import { STATUS_COLORS } from '../utils/constants';
import type { TeamTask } from '../../shared/types';

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


// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TeamDetail() {
  const { selectedTeamId, setSelectedTeamId } = useSelection();
  const { lastEvent, lastEventTeamId } = useConnection();
  const { isThinking } = useThinking();
  const api = useApi();

  // Parallelized data fetching with caching (extracted hook)
  const { detail, transitions, roster, messageEdges, loading, error, refreshDetail } =
    useTeamDetailData(selectedTeamId, lastEvent, lastEventTeamId);

  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [quickActionLoading, setQuickActionLoading] = useState<string | null>(null);
  const [quickActionSent, setQuickActionSent] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'session-log' | 'tasks' | 'team'>('session-log');
  const [tasks, setTasks] = useState<TeamTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [metadataCollapsed, setMetadataCollapsed] = useState(false);
  const [agentFilters, setAgentFilters] = useState<Set<string>>(new Set());
  const templateCacheRef = useRef<{ data: Array<{ id: string; template: string; enabled: boolean }>; fetchedAt: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const selectedTeamIdRef = useRef(selectedTeamId);

  const isOpen = selectedTeamId !== null;

  // Keep ref in sync with selectedTeamId for use in async callbacks
  useEffect(() => {
    selectedTeamIdRef.current = selectedTeamId;
  }, [selectedTeamId]);

  // Reset active tab, metadata collapse state, and agent filters when team changes
  useEffect(() => {
    setActiveTab('session-log');
    // Auto-collapse metadata for done/failed teams to give more space to content
    setMetadataCollapsed(false);
    // Reset agent filters to "All" for new team
    setAgentFilters(new Set());
  }, [selectedTeamId]);

  // Auto-collapse metadata when team transitions to terminal state
  useEffect(() => {
    if (detail?.status === 'done' || detail?.status === 'failed') {
      setMetadataCollapsed(true);
    }
  }, [detail?.status]);

  // Fetch tasks when the Tasks tab is selected
  useEffect(() => {
    if (activeTab !== 'tasks' || !selectedTeamId) return;
    let cancelled = false;
    setTasksLoading(true);
    api.get<TeamTask[]>(`teams/${selectedTeamId}/tasks`)
      .then((data) => {
        if (!cancelled) setTasks(data);
      })
      .catch(() => {
        if (!cancelled) setTasks([]);
      })
      .finally(() => {
        if (!cancelled) setTasksLoading(false);
      });
    return () => { cancelled = true; };
  }, [activeTab, selectedTeamId, api]);

  // Refresh tasks on SSE task_updated events
  useEffect(() => {
    if (activeTab !== 'tasks' || !selectedTeamId) return;
    if (!lastEvent || lastEventTeamId !== selectedTeamId) return;
    try {
      const parsed = typeof lastEvent === 'string' ? JSON.parse(lastEvent) : lastEvent;
      if (parsed?.type === 'task_updated') {
        api.get<TeamTask[]>(`teams/${selectedTeamId}/tasks`)
          .then((data) => setTasks(data))
          .catch(() => { /* SSE refresh is best-effort */ });
      }
    } catch {
      // Ignore parse errors
    }
  }, [activeTab, selectedTeamId, lastEvent, lastEventTeamId, api]);

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
        // Refresh detail (and stale caches) after action
        refreshDetail();
      } catch {
        // Action errors are transient; SSE will update the real state
      } finally {
        setActionLoading(null);
      }
    },
    [selectedTeamId, actionLoading, api, refreshDetail],
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
              {/* TOP: Metadata — collapsible, auto-collapsed for done/failed */}
              <div className="shrink-0">
                {/* Always-visible header with collapse toggle */}
                <div
                  className="flex items-center justify-between px-5 py-3 cursor-pointer hover:bg-dark-border/10 transition-colors"
                  onClick={() => setMetadataCollapsed((c) => !c)}
                >
                  <h3 className="text-base font-semibold text-dark-text">
                    <span className="text-dark-muted mr-1.5">#{detail.issueNumber}</span>
                    {detail.issueTitle ?? 'Untitled'}
                  </h3>
                  <div className="flex items-center gap-2 shrink-0">
                    <StatusBadge status={detail.status} />
                    <svg
                      className={`w-4 h-4 text-dark-muted transition-transform duration-200 ${metadataCollapsed ? '' : 'rotate-180'}`}
                      viewBox="0 0 20 20"
                      fill="currentColor"
                    >
                      <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                    </svg>
                  </div>
                </div>

                {/* Collapsible metadata content */}
                <div className={`overflow-y-auto custom-scrollbar transition-all duration-200 ${metadataCollapsed ? 'max-h-0 overflow-hidden' : 'max-h-[2000px]'}`}>
                <div className="px-5 pb-4 space-y-4">
                  {/* ---- Header Section ---- */}
                  <section>
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
                        <div className="max-h-[120px] overflow-y-auto custom-scrollbar">
                          <CIChecks checks={detail.pr.checks ?? []} />
                        </div>
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
              </div>

              {/* MIDDLE: Tabbed content area */}
              <div className="flex-1 min-h-0 flex flex-col">
                {/* Tab bar */}
                <div className="shrink-0 flex items-center gap-0 px-5 border-b border-dark-border">
                  <button
                    onClick={() => setActiveTab('session-log')}
                    className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                      activeTab === 'session-log'
                        ? 'border-dark-accent text-dark-text'
                        : 'border-transparent text-dark-muted hover:text-dark-text'
                    }`}
                  >
                    Session Log
                  </button>
                  <button
                    onClick={() => setActiveTab('tasks')}
                    className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                      activeTab === 'tasks'
                        ? 'border-dark-accent text-dark-text'
                        : 'border-transparent text-dark-muted hover:text-dark-text'
                    }`}
                  >
                    Tasks
                    {tasks.length > 0 && (
                      <span className="ml-1.5 text-xs text-dark-muted">
                        ({tasks.filter(t => t.status === 'completed').length}/{tasks.length})
                      </span>
                    )}
                  </button>
                  <button
                    onClick={() => setActiveTab('team')}
                    className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                      activeTab === 'team'
                        ? 'border-dark-accent text-dark-text'
                        : 'border-transparent text-dark-muted hover:text-dark-text'
                    }`}
                  >
                    Team
                  </button>
                </div>

                {/* Tab content */}
                {activeTab === 'session-log' && (
                  <div className="flex-1 min-h-0 flex flex-col px-5 py-3">
                    <div className="flex-1 min-h-0 flex flex-col">
                      <UnifiedTimeline
                        teamId={detail.id}
                        teamStatus={detail.status}
                        isThinking={isThinking(detail.id)}
                        roster={roster}
                        agentFilters={agentFilters}
                        onAgentFiltersChange={setAgentFilters}
                      />
                    </div>
                  </div>
                )}

                {activeTab === 'tasks' && (
                  <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-5 py-3">
                    {tasksLoading && tasks.length === 0 && (
                      <div className="flex items-center justify-center py-8">
                        <span className="text-dark-muted">Loading tasks...</span>
                      </div>
                    )}

                    {!tasksLoading && tasks.length === 0 && (
                      <div className="flex flex-col items-center justify-center py-12 text-center">
                        <svg className="w-10 h-10 text-dark-muted/40 mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <p className="text-sm text-dark-muted">No tasks yet.</p>
                        <p className="text-xs text-dark-muted/60 mt-1">Tasks appear when the TL creates a task list.</p>
                      </div>
                    )}

                    {tasks.length > 0 && (
                      <div className="space-y-1">
                        {tasks.map((task) => (
                          <div
                            key={task.id}
                            className={`flex items-start gap-2.5 px-3 py-2 rounded border transition-colors ${
                              task.status === 'completed'
                                ? 'border-dark-border/30 bg-dark-border/5'
                                : task.status === 'in_progress'
                                  ? 'border-[#58A6FF]/30 bg-[#58A6FF]/5'
                                  : 'border-dark-border/50 bg-transparent'
                            }`}
                          >
                            {/* Status icon */}
                            <div className="shrink-0 mt-0.5">
                              {task.status === 'completed' && (
                                <svg className="w-4 h-4 text-[#3FB950]" viewBox="0 0 16 16" fill="currentColor">
                                  <path fillRule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" clipRule="evenodd" />
                                </svg>
                              )}
                              {task.status === 'in_progress' && (
                                <svg className="w-4 h-4 text-[#58A6FF] animate-spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                                  <circle cx="8" cy="8" r="6" strokeOpacity="0.3" />
                                  <path d="M8 2a6 6 0 014.9 9.4" />
                                </svg>
                              )}
                              {task.status === 'pending' && (
                                <svg className="w-4 h-4 text-dark-muted" viewBox="0 0 16 16" fill="currentColor">
                                  <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
                                </svg>
                              )}
                            </div>

                            {/* Task content */}
                            <div className="flex-1 min-w-0">
                              <p className={`text-sm leading-snug ${
                                task.status === 'completed' ? 'text-dark-muted line-through' : 'text-dark-text'
                              }`}>
                                {task.subject}
                              </p>
                              {task.description && (
                                <p className="text-xs text-dark-muted mt-0.5 truncate">{task.description}</p>
                              )}
                            </div>

                            {/* Owner badge */}
                            <span className="shrink-0 text-[10px] text-dark-muted px-1.5 py-0.5 rounded bg-dark-border/20">
                              {task.owner}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'team' && (
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
                    { id: 'check_ci', label: 'Fix CI', color: '#F85149', show: !!detail?.prNumber },
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

                  {detail?.status !== 'done' && (
                    <button
                      onClick={() => handleAction('restart')}
                      disabled={actionLoading !== null}
                      className="px-3 py-1.5 text-sm rounded border border-dark-accent/40 text-dark-accent hover:bg-dark-accent/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {actionLoading === 'restart' ? 'Restarting...' : 'Restart'}
                    </button>
                  )}

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
