import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import React from 'react';
import { useApi } from '../hooks/useApi';
import { useSSE } from '../hooks/useSSE';
import { usePrioritization, sortTreeByPriority } from '../hooks/usePrioritization';
import { useCollapseState } from '../hooks/useCollapseState';
import { TreeNode, type IssueNode } from '../components/TreeNode';
import type { ProjectSummary } from '../../shared/types';

// ---------------------------------------------------------------------------
// Status filter pill definitions
// ---------------------------------------------------------------------------

const STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'no-team', label: 'No Team' },
  { key: 'blocked-deps', label: 'Blocked', color: '#F85149' },
  { key: 'running', label: 'Running', color: '#3FB950' },
  { key: 'idle', label: 'Idle', color: '#D29922' },
  { key: 'stuck', label: 'Stuck', color: '#F85149' },
  { key: 'done', label: 'Done', color: '#A371F7' },
  { key: 'failed', label: 'Failed', color: '#F85149' },
] as const;

// ---------------------------------------------------------------------------
// API response shape from GET /api/issues
// ---------------------------------------------------------------------------

interface ProjectIssueGroup {
  projectId: number;
  projectName: string;
  tree: IssueNode[];
  cachedAt: string | null;
  count: number;
}

interface IssueTreeResponse {
  tree: IssueNode[];
  groups?: ProjectIssueGroup[];
  cachedAt: string | null;
  count: number;
}

/** POST /api/issues/refresh returns slightly different field names */
interface IssueRefreshResponse {
  tree: IssueNode[];
  refreshedAt: string | null;
  issueCount: number;
}

// ---------------------------------------------------------------------------
// IssueTreeView — main container
// ---------------------------------------------------------------------------

export function IssueTreeView() {
  const api = useApi();
  const [tree, setTree] = useState<IssueNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [issueCount, setIssueCount] = useState(0);
  const [launchingIssues, setLaunchingIssues] = useState<Set<number>>(new Set());
  const [launchErrors, setLaunchErrors] = useState<Map<number, string>>(new Map());
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [groups, setGroups] = useState<ProjectIssueGroup[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Collapse state — persisted to localStorage
  const collapseState = useCollapseState();

  // Dependency confirmation dialog state
  const [depConfirm, setDepConfirm] = useState<{
    issueNumber: number;
    title: string;
    projectId: number;
    message: string;
    blockers: string[];
  } | null>(null);

  // Track pending timeouts so we can clear them on unmount
  const pendingTimeouts = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    return () => {
      for (const id of pendingTimeouts.current) {
        clearTimeout(id);
      }
      pendingTimeouts.current.clear();
    };
  }, []);

  // Fetch the project list so we can auto-resolve a project for launches
  // when only one project exists.
  useEffect(() => {
    api.get<ProjectSummary[]>('projects').then(setProjects).catch(() => {
      // Non-fatal — projects list is only used to auto-resolve launch target
    });
  }, [api]);

  // Resolve which project to use for launches:
  // If only one project exists, auto-use it. Otherwise null — user must pick.
  const activeProjects = projects.filter((p) => p.status === 'active');
  const launchProjectId = activeProjects.length === 1 ? activeProjects[0].id : null;

  // -------------------------------------------------------------------------
  // Fetch issue tree
  // -------------------------------------------------------------------------

  const fetchTree = useCallback(async () => {
    try {
      setError(null);
      const data = await api.get<IssueTreeResponse>('issues');
      setTree(data.tree);
      setGroups(data.groups ?? []);
      setCachedAt(data.cachedAt);
      setIssueCount(data.count);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    fetchTree();
  }, [fetchTree]);

  // -------------------------------------------------------------------------
  // SSE: auto-refresh when a dependency is resolved
  // -------------------------------------------------------------------------

  const handleSSEEvent = useCallback((type: string) => {
    if (type === 'dependency_resolved') {
      fetchTree();
    }
  }, [fetchTree]);

  useSSE({ onEvent: handleSSEEvent });

  // -------------------------------------------------------------------------
  // Refresh (force re-fetch from GitHub)
  // -------------------------------------------------------------------------

  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      setError(null);
      // Refresh all projects on the server, then re-fetch with the active filter
      await api.post<IssueRefreshResponse>('issues/refresh');
      await fetchTree();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setRefreshing(false);
    }
  }, [api, refreshing, fetchTree]);

  // -------------------------------------------------------------------------
  // Launch team for an issue (play button)
  // -------------------------------------------------------------------------

  const handleLaunch = useCallback(async (issueNumber: number, title: string, contextProjectId?: number) => {
    // Use the project from the grouped context if provided, otherwise fall back to launchProjectId
    const resolvedProjectId = contextProjectId ?? launchProjectId;

    if (!resolvedProjectId) {
      const message = activeProjects.length > 1
        ? 'Multiple projects exist — use the Launch Team dialog to select one'
        : 'No active project found';
      setLaunchErrors(prev => {
        const next = new Map(prev);
        next.set(issueNumber, message);
        return next;
      });
      const tid = setTimeout(() => {
        pendingTimeouts.current.delete(tid);
        setLaunchErrors(prev => {
          const next = new Map(prev);
          next.delete(issueNumber);
          return next;
        });
      }, 5000);
      pendingTimeouts.current.add(tid);
      return;
    }

    setLaunchingIssues(prev => new Set(prev).add(issueNumber));
    // Clear any previous error for this issue
    setLaunchErrors(prev => {
      if (!prev.has(issueNumber)) return prev;
      const next = new Map(prev);
      next.delete(issueNumber);
      return next;
    });

    try {
      await api.post('teams/launch', {
        issueNumber,
        issueTitle: title,
        projectId: resolvedProjectId,
      });
      // Don't immediately remove from launchingIssues — let it persist
      // so the user sees feedback until the tree refreshes with the active team badge.
      const tid = setTimeout(() => {
        pendingTimeouts.current.delete(tid);
        setLaunchingIssues(prev => {
          const next = new Set(prev);
          next.delete(issueNumber);
          return next;
        });
        fetchTree();
      }, 5000);
      pendingTimeouts.current.add(tid);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      // Check for 409 dependency block — show confirmation dialog
      // Use status code from ApiError (has a .status property) rather than fragile string matching
      const errorStatus = (err as { status?: number }).status;
      const is409 = errorStatus === 409;
      if (is409 && resolvedProjectId) {
        // Remove from launching state
        setLaunchingIssues(prev => {
          const next = new Set(prev);
          next.delete(issueNumber);
          return next;
        });
        // Extract blocker info from the error message
        setDepConfirm({
          issueNumber,
          title,
          projectId: resolvedProjectId,
          message,
          blockers: [], // The error message contains the details
        });
        return;
      }

      console.error(`[IssueTree] Failed to launch team for #${issueNumber}:`, message);
      // Remove from launching state immediately on error
      setLaunchingIssues(prev => {
        const next = new Set(prev);
        next.delete(issueNumber);
        return next;
      });
      // Show error inline on the tree node
      setLaunchErrors(prev => {
        const next = new Map(prev);
        next.set(issueNumber, message);
        return next;
      });
      // Auto-clear error after 5 seconds
      const tid = setTimeout(() => {
        pendingTimeouts.current.delete(tid);
        setLaunchErrors(prev => {
          const next = new Map(prev);
          next.delete(issueNumber);
          return next;
        });
      }, 5000);
      pendingTimeouts.current.add(tid);
    }
  }, [api, fetchTree, launchProjectId, activeProjects.length]);

  // Handle force launch (bypassing dependency check)
  const handleForceLaunch = useCallback(async () => {
    if (!depConfirm) return;
    const { issueNumber, title, projectId } = depConfirm;
    setDepConfirm(null);
    setLaunchingIssues(prev => new Set(prev).add(issueNumber));

    try {
      await api.post('teams/launch', {
        issueNumber,
        issueTitle: title,
        projectId,
        force: true,
      });
      const tid = setTimeout(() => {
        pendingTimeouts.current.delete(tid);
        setLaunchingIssues(prev => {
          const next = new Set(prev);
          next.delete(issueNumber);
          return next;
        });
        fetchTree();
      }, 5000);
      pendingTimeouts.current.add(tid);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLaunchingIssues(prev => {
        const next = new Set(prev);
        next.delete(issueNumber);
        return next;
      });
      setLaunchErrors(prev => {
        const next = new Map(prev);
        next.set(issueNumber, message);
        return next;
      });
      const tid = setTimeout(() => {
        pendingTimeouts.current.delete(tid);
        setLaunchErrors(prev => {
          const next = new Map(prev);
          next.delete(issueNumber);
          return next;
        });
      }, 5000);
      pendingTimeouts.current.add(tid);
    }
  }, [api, depConfirm, fetchTree]);

  // -------------------------------------------------------------------------
  // Filter tree by search query
  // -------------------------------------------------------------------------

  const filteredTree = useMemo(() => filterTree(tree, search, statusFilter), [tree, search, statusFilter]);

  // Filtered groups for the grouped view
  const filteredGroups = useMemo(() => {
    if (groups.length === 0) return [];
    return groups
      .map((g) => ({
        ...g,
        tree: filterTree(g.tree, search, statusFilter),
      }))
      .filter((g) => g.tree.length > 0);
  }, [groups, search, statusFilter]);

  // Collect all node IDs from the full (unfiltered) tree for Collapse All
  // Includes project group IDs (project-{id}) so Collapse All covers project groups too
  const allNodeIds = useMemo(() => {
    if (groups.length > 0) {
      return groups.flatMap((g) => [
        `project-${g.projectId}`,
        ...collectAllNodeIds(g.tree),
      ]);
    }
    return collectAllNodeIds(tree);
  }, [tree, groups]);

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <svg
            className="w-8 h-8 text-dark-accent animate-spin"
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4Z"
            />
          </svg>
          <p className="text-dark-muted text-sm">Loading issue tree...</p>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-dark-border shrink-0 gap-3">
        <div className="flex items-center gap-3 shrink-0">
          <h2 className="text-sm font-semibold text-dark-text">Issue Tree</h2>
          <span className="text-xs text-dark-muted">
            {search || statusFilter !== 'all'
              ? `${countNodes(filteredTree)} of ${issueCount} issues`
              : `${issueCount} issue${issueCount !== 1 ? 's' : ''}`}
          </span>
          {cachedAt && !search && (
            <span className="text-xs text-dark-muted" title={cachedAt}>
              {'\u00B7'} cached {formatRelativeTime(cachedAt)}
            </span>
          )}
        </div>

        {/* Search input */}
        <div className="relative flex-1 max-w-xs">
          <input
            type="text"
            placeholder="Search issues... (#number or title)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search issues"
            className="w-full px-3 py-1 text-xs bg-[#0D1117] border border-[#30363D] rounded text-[#E6EDF3] placeholder-[#8B949E] focus:outline-none focus:border-[#58A6FF]"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8B949E] hover:text-[#E6EDF3] transition-colors"
              aria-label="Clear search"
            >
              <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
              </svg>
            </button>
          )}
        </div>

        {/* Status filter pills */}
        <div className="flex items-center gap-1 flex-wrap">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setStatusFilter(f.key)}
              className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                statusFilter === f.key
                  ? 'border-dark-accent/50 bg-dark-accent/20 text-dark-accent'
                  : 'border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-muted'
              }`}
              style={statusFilter === f.key && 'color' in f ? { color: f.color, borderColor: f.color + '50', backgroundColor: f.color + '15' } : undefined}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Expand / Collapse All buttons */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={collapseState.expandAll}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded border border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-accent/50 transition-colors"
            title="Expand all tree nodes"
          >
            <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8.177 14.323a.75.75 0 0 1-1.06-.146l-3.5-4.5A.75.75 0 0 1 4.211 8.5h7.578a.75.75 0 0 1 .594 1.177l-3.5 4.5a.75.75 0 0 1-.706.146ZM7.823 1.677a.75.75 0 0 1 1.06.146l3.5 4.5A.75.75 0 0 1 11.789 7.5H4.211a.75.75 0 0 1-.594-1.177l3.5-4.5a.75.75 0 0 1 .706-.146Z" />
            </svg>
            Expand All
          </button>
          <button
            onClick={() => collapseState.collapseAll(allNodeIds)}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded border border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-accent/50 transition-colors"
            title="Collapse all tree nodes"
          >
            <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.177 7.823a.75.75 0 0 1 .146-1.06l3.5-3.5A.75.75 0 0 1 8.5 3.557V7.5h-3.5a.75.75 0 0 1-.823-.677ZM11.823 7.823a.75.75 0 0 0-.146-1.06l-3.5-3.5A.75.75 0 0 0 7.5 3.557V7.5h3.5a.75.75 0 0 0 .823-.677ZM4.177 8.177a.75.75 0 0 0 .146 1.06l3.5 3.5a.75.75 0 0 0 .677.823V9.5H5a.75.75 0 0 0-.823.677ZM11.823 8.177a.75.75 0 0 1-.146 1.06l-3.5 3.5a.75.75 0 0 1-.677.823V9.5H11a.75.75 0 0 1 .823.677Z" />
            </svg>
            Collapse All
          </button>
        </div>

        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-accent/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg
            className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`}
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z" />
          </svg>
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-4 mt-3 px-3 py-2 rounded border border-[#F85149]/30 bg-[#F85149]/10 text-xs text-[#F85149]">
          {error}
        </div>
      )}

      {/* Tree content */}
      <div className="flex-1 overflow-auto p-2">
        {tree.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <svg
              className="w-12 h-12 text-dark-muted/40"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z"
              />
            </svg>
            <p className="text-dark-muted text-lg">No issues found</p>
            <p className="text-dark-muted/60 text-sm">
              Click Refresh to fetch issues from GitHub
            </p>
          </div>
        ) : filteredTree.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <p className="text-dark-muted text-sm">
              {search && statusFilter !== 'all'
                ? <>No issues match &ldquo;{search}&rdquo; with filter &ldquo;{STATUS_FILTERS.find(f => f.key === statusFilter)?.label}&rdquo;</>
                : search
                  ? <>No issues match &ldquo;{search}&rdquo;</>
                  : <>No issues match filter &ldquo;{STATUS_FILTERS.find(f => f.key === statusFilter)?.label}&rdquo;</>}
            </p>
            <button
              onClick={() => { setSearch(''); setStatusFilter('all'); }}
              className="text-xs text-dark-accent hover:underline"
            >
              Clear filters
            </button>
          </div>
        ) : filteredGroups.length > 0 ? (
          /* Grouped view — each ProjectGroup has its own prioritization */
          <div className="space-y-1">
            {filteredGroups.map((group) => (
              <ProjectGroup
                key={group.projectId}
                group={group}
                onLaunch={handleLaunch}
                launchingIssues={launchingIssues}
                launchErrors={launchErrors}
                forceExpand={!!search || statusFilter !== 'all'}
                fetchTree={fetchTree}
                collapsedNodes={collapseState.collapsedNodes}
                onToggleCollapse={collapseState.toggleCollapse}
              />
            ))}
          </div>
        ) : (
          /* Single-project fallback — render as a ProjectGroup with launchProjectId */
          <SingleProjectTree
            tree={filteredTree}
            projectId={launchProjectId}
            onLaunch={handleLaunch}
            launchingIssues={launchingIssues}
            launchErrors={launchErrors}
            forceExpand={!!search || statusFilter !== 'all'}
            fetchTree={fetchTree}
            collapsedNodes={collapseState.collapsedNodes}
            onToggleCollapse={collapseState.toggleCollapse}
          />
        )}
      </div>

      {/* Dependency confirmation dialog */}
      {depConfirm && (
        <DependencyConfirmDialog
          issueNumber={depConfirm.issueNumber}
          message={depConfirm.message}
          onForce={handleForceLaunch}
          onCancel={() => setDepConfirm(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DependencyConfirmDialog — shown when launching a blocked issue
// ---------------------------------------------------------------------------

function DependencyConfirmDialog({ issueNumber, message, onForce, onCancel }: {
  issueNumber: number;
  message: string;
  onForce: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[420px] max-w-[95vw] bg-dark-surface border border-dark-border rounded-lg shadow-2xl">
        <div className="px-5 py-4 border-b border-dark-border">
          <h3 className="text-sm font-semibold text-dark-text flex items-center gap-2">
            <svg className="w-4 h-4 text-[#F85149]" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.25 7.25a.75.75 0 0 0 0 1.5h7.5a.75.75 0 0 0 0-1.5h-7.5Z" />
              <path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z" />
            </svg>
            Issue #{issueNumber} has unresolved dependencies
          </h3>
        </div>
        <div className="px-5 py-4">
          <p className="text-sm text-dark-muted mb-3">
            {message}
          </p>
          <p className="text-xs text-dark-muted">
            You can force launch to bypass the dependency check, but the issue may not be ready to work on.
          </p>
        </div>
        <div className="flex items-center justify-end gap-3 px-5 py-3 border-t border-dark-border">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded border border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-muted transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onForce}
            className="px-4 py-1.5 text-sm font-medium rounded border border-[#F85149]/40 text-[#F85149] bg-[#F85149]/10 hover:bg-[#F85149]/20 transition-colors"
          >
            Force Launch
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RunAllConfirmDialog — confirmation modal for Run All action
// ---------------------------------------------------------------------------

function RunAllConfirmDialog({ issues, skippedActive, skippedBlocked, projectId, api, fetchTree, onClose }: {
  issues: IssueNode[];
  skippedActive: number;
  skippedBlocked: number;
  projectId: number;
  api: ReturnType<typeof useApi>;
  fetchTree: () => Promise<void>;
  onClose: () => void;
}) {
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLaunchAll = useCallback(async () => {
    setLaunching(true);
    setError(null);
    try {
      await api.post('teams/launch-batch', {
        projectId,
        issues: issues.map((n) => ({ number: n.number, title: n.title })),
      });
      onClose();
      // Give the server a moment to process, then refresh
      setTimeout(() => fetchTree(), 3000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setLaunching(false);
    }
  }, [api, projectId, issues, onClose, fetchTree]);

  if (issues.length === 0) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[480px] max-w-[95vw] bg-dark-surface border border-dark-border rounded-lg shadow-2xl">
        <div className="px-5 py-4 border-b border-dark-border">
          <h3 className="text-sm font-semibold text-dark-text flex items-center gap-2">
            <svg className="w-4 h-4 text-[#3FB950]" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215Z" />
            </svg>
            Launch {issues.length} team{issues.length !== 1 ? 's' : ''}?
          </h3>
        </div>
        <div className="px-5 py-4 max-h-[50vh] overflow-auto">
          {/* List of issues to launch */}
          <ul className="space-y-1 mb-3">
            {issues.map((n) => (
              <li key={n.number} className="text-xs text-dark-text flex items-center gap-2">
                <svg className="w-3 h-3 text-[#3FB950] shrink-0" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
                  <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" />
                </svg>
                <span className="text-dark-muted">#{n.number}</span>
                <span className="truncate">{n.title}</span>
              </li>
            ))}
          </ul>

          {/* Skipped counts */}
          {(skippedActive > 0 || skippedBlocked > 0) && (
            <div className="text-xs text-dark-muted space-y-0.5 mb-3 border-t border-dark-border/40 pt-2">
              {skippedActive > 0 && (
                <p>{skippedActive} issue{skippedActive !== 1 ? 's' : ''} skipped (already have active teams)</p>
              )}
              {skippedBlocked > 0 && (
                <p>{skippedBlocked} issue{skippedBlocked !== 1 ? 's' : ''} skipped (blocked by dependencies)</p>
              )}
            </div>
          )}

          {/* Error display */}
          {error && (
            <div className="px-3 py-2 rounded border border-[#F85149]/30 bg-[#F85149]/10 text-xs text-[#F85149] mb-3">
              {error}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-3 px-5 py-3 border-t border-dark-border">
          <button
            onClick={onClose}
            disabled={launching}
            className="px-3 py-1.5 text-sm rounded border border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-muted transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleLaunchAll}
            disabled={launching}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded border border-[#3FB950]/40 text-[#3FB950] bg-[#3FB950]/10 hover:bg-[#3FB950]/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {launching ? (
              <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215Z" />
              </svg>
            )}
            {launching ? 'Launching...' : 'Launch All'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PrioritizeButtons — shared Prioritize + Reset button pair
// ---------------------------------------------------------------------------

function PrioritizeButtons({ prioritization, tree, className, onRunAll, runAllDisabled }: {
  prioritization: ReturnType<typeof usePrioritization>;
  tree: IssueNode[];
  className?: string;
  onRunAll?: () => void;
  runAllDisabled?: boolean;
}) {
  return (
    <div className={`flex items-center gap-2 ${className ?? ''}`}>
      <button
        onClick={() => prioritization.prioritize(tree)}
        disabled={prioritization.loading || tree.length === 0}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-[#A371F7]/50 text-[#A371F7] hover:bg-[#A371F7]/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        title="AI-prioritize open issues"
      >
        {prioritization.loading ? (
          <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
        ) : (
          <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
            <path d="M7.823.9l4.584 4.584-7.636 7.636L.187 8.536 7.823.9ZM14.2 6.1l-1.3 1.3-4.584-4.584L9.6 1.5a1.5 1.5 0 012.122 0L14.2 3.978a1.5 1.5 0 010 2.122Z" />
          </svg>
        )}
        {prioritization.loading ? 'Prioritizing...' : 'Prioritize'}
      </button>

      {onRunAll && (
        <button
          onClick={onRunAll}
          disabled={runAllDisabled}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-[#3FB950]/50 text-[#3FB950] hover:bg-[#3FB950]/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title="Launch teams for all launchable issues"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1.5 3.5a.5.5 0 0 1 .8-.4l4.5 3.4a.5.5 0 0 1 0 .8l-4.5 3.4a.5.5 0 0 1-.8-.4V3.5Zm7 0a.5.5 0 0 1 .8-.4l4.5 3.4a.5.5 0 0 1 0 .8l-4.5 3.4a.5.5 0 0 1-.8-.4V3.5Z" />
          </svg>
          Run All
        </button>
      )}

      {prioritization.hasPriority && (
        <button
          onClick={prioritization.reset}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-accent/50 transition-colors"
          title="Clear prioritization"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
          </svg>
          Reset
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PrioritizationActionBar — batch launch bar shown when prioritization active
// ---------------------------------------------------------------------------

function PrioritizationActionBar({ prioritization, projectId, api, fetchTree }: {
  prioritization: ReturnType<typeof usePrioritization>;
  projectId: number;
  api: ReturnType<typeof useApi>;
  fetchTree: () => Promise<void>;
}) {
  const [batchLaunching, setBatchLaunching] = useState(false);
  const pendingTimeouts = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    return () => {
      for (const id of pendingTimeouts.current) clearTimeout(id);
      pendingTimeouts.current.clear();
    };
  }, []);

  const handleBatchLaunch = useCallback(async () => {
    const issuesToLaunch = prioritization.checkedSortedIssueNumbers;
    if (issuesToLaunch.length === 0) return;

    setBatchLaunching(true);
    try {
      await api.post('teams/launch-batch', {
        projectId,
        issues: issuesToLaunch.map((num) => {
          const data = prioritization.priorityMap.get(num);
          return { number: num, title: data?.title };
        }),
      });
      const tid = setTimeout(() => {
        pendingTimeouts.current.delete(tid);
        fetchTree();
      }, 3000);
      pendingTimeouts.current.add(tid);
    } catch (err) {
      console.error('[IssueTree] Batch launch failed:', err instanceof Error ? err.message : String(err));
    } finally {
      setBatchLaunching(false);
    }
  }, [api, prioritization.checkedSortedIssueNumbers, prioritization.priorityMap, projectId, fetchTree]);

  if (!prioritization.hasPriority) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-dark-border/40 bg-[#A371F7]/5">
      <span className="text-xs text-dark-muted">
        {prioritization.checkedIssues.size} of {prioritization.priorityMap.size} selected
      </span>

      <button
        onClick={handleBatchLaunch}
        disabled={batchLaunching || prioritization.checkedIssues.size === 0}
        className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded border border-[#3FB950]/50 text-[#3FB950] hover:bg-[#3FB950]/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {batchLaunching ? (
          <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
        ) : (
          <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215Z" />
          </svg>
        )}
        {prioritization.checkedIssues.size === prioritization.priorityMap.size
          ? 'Launch all in order'
          : `Launch ${prioritization.checkedIssues.size} selected in order`}
      </button>

      {prioritization.costUsd != null && (
        <span className="text-xs text-dark-muted ml-auto">
          ${prioritization.costUsd.toFixed(4)} &middot; {((prioritization.durationMs ?? 0) / 1000).toFixed(1)}s
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProjectGroup — collapsible project section with its own prioritization
// ---------------------------------------------------------------------------

interface ProjectGroupProps {
  group: { projectId: number; projectName: string; tree: IssueNode[]; count: number };
  onLaunch: (issueNumber: number, title: string, projectId?: number) => Promise<void>;
  launchingIssues: Set<number>;
  launchErrors: Map<number, string>;
  forceExpand: boolean;
  fetchTree: () => Promise<void>;
  collapsedNodes: Set<string>;
  onToggleCollapse: (nodeId: string) => void;
}

function ProjectGroup({ group, onLaunch, launchingIssues, launchErrors, forceExpand, fetchTree, collapsedNodes, onToggleCollapse }: ProjectGroupProps) {
  const api = useApi();
  const projectNodeId = `project-${group.projectId}`;
  const expanded = !collapsedNodes.has(projectNodeId);
  const prioritization = usePrioritization();
  const [showRunAllDialog, setShowRunAllDialog] = useState(false);

  const displayTree = useMemo(() => {
    if (!prioritization.hasPriority) return group.tree;
    return sortTreeByPriority(group.tree, prioritization.priorityMap);
  }, [group.tree, prioritization.hasPriority, prioritization.priorityMap]);

  const launchableInfo = useMemo(() => collectLaunchableIssues(group.tree), [group.tree]);

  return (
    <div>
      {/* Project section header */}
      <div className="flex items-center gap-2 py-2 px-2 rounded hover:bg-dark-surface/60 transition-colors">
        <button
          onClick={() => onToggleCollapse(projectNodeId)}
          className="flex items-center gap-2 flex-1 text-left min-w-0"
        >
          {/* Expand/collapse arrow */}
          <span className={`w-4 h-4 flex items-center justify-center text-dark-muted shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}>
            <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
              <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </span>
          {/* Repo icon */}
          <svg className="w-4 h-4 text-dark-muted shrink-0" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.25.25 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z" />
          </svg>
          <span className="text-sm font-semibold text-dark-text truncate">
            {group.projectName}
          </span>
          <span className="text-xs text-dark-muted shrink-0">
            {countNodes(group.tree)} issue{countNodes(group.tree) !== 1 ? 's' : ''}
          </span>
        </button>

        <PrioritizeButtons
          prioritization={prioritization}
          tree={group.tree}
          onRunAll={() => setShowRunAllDialog(true)}
          runAllDisabled={launchableInfo.launchable.length === 0}
        />
      </div>

      {/* Prioritization error banner */}
      {prioritization.error && (
        <div className="mx-2 mb-1 px-3 py-2 rounded border border-[#F85149]/30 bg-[#F85149]/10 text-xs text-[#F85149]">
          Prioritization failed: {prioritization.error}
        </div>
      )}

      {/* Prioritization action bar */}
      <PrioritizationActionBar
        prioritization={prioritization}
        projectId={group.projectId}
        api={api}
        fetchTree={fetchTree}
      />

      {/* Issue tree within this project group */}
      {expanded && (
        <div className="ml-2 border-l border-dark-border/40 pl-1">
          {displayTree.map((node) => (
            <TreeNode
              key={node.number}
              node={node}
              depth={0}
              onLaunch={onLaunch}
              launchingIssues={launchingIssues}
              launchErrors={launchErrors}
              forceExpand={forceExpand}
              projectId={group.projectId}
              priorityMap={prioritization.hasPriority ? prioritization.priorityMap : undefined}
              checkedIssues={prioritization.hasPriority ? prioritization.checkedIssues : undefined}
              onCheckChange={prioritization.hasPriority ? prioritization.toggleCheck : undefined}
              onPrioritizeSubtree={prioritization.prioritizeSubtree}
              prioritizing={prioritization.loading}
              collapsedNodes={collapsedNodes}
              onToggleCollapse={onToggleCollapse}
            />
          ))}
        </div>
      )}

      {/* Run All confirmation dialog */}
      {showRunAllDialog && (
        <RunAllConfirmDialog
          issues={launchableInfo.launchable}
          skippedActive={launchableInfo.skippedActive}
          skippedBlocked={launchableInfo.skippedBlocked}
          projectId={group.projectId}
          api={api}
          fetchTree={fetchTree}
          onClose={() => setShowRunAllDialog(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SingleProjectTree — fallback for single-project with its own prioritization
// ---------------------------------------------------------------------------

interface SingleProjectTreeProps {
  tree: IssueNode[];
  projectId: number | null;
  onLaunch: (issueNumber: number, title: string, projectId?: number) => Promise<void>;
  launchingIssues: Set<number>;
  launchErrors: Map<number, string>;
  forceExpand: boolean;
  fetchTree: () => Promise<void>;
  collapsedNodes: Set<string>;
  onToggleCollapse: (nodeId: string) => void;
}

function SingleProjectTree({ tree, projectId, onLaunch, launchingIssues, launchErrors, forceExpand, fetchTree, collapsedNodes, onToggleCollapse }: SingleProjectTreeProps) {
  const api = useApi();
  const prioritization = usePrioritization();
  const [showRunAllDialog, setShowRunAllDialog] = useState(false);

  const displayTree = useMemo(() => {
    if (!prioritization.hasPriority) return tree;
    return sortTreeByPriority(tree, prioritization.priorityMap);
  }, [tree, prioritization.hasPriority, prioritization.priorityMap]);

  const launchableInfo = useMemo(() => collectLaunchableIssues(tree), [tree]);

  return (
    <div>
      {/* Prioritize controls */}
      <div className="flex items-center gap-2 px-2 pb-2">
        <PrioritizeButtons
          prioritization={prioritization}
          tree={tree}
          onRunAll={projectId ? () => setShowRunAllDialog(true) : undefined}
          runAllDisabled={launchableInfo.launchable.length === 0}
        />
      </div>

      {/* Prioritization error banner */}
      {prioritization.error && (
        <div className="mx-2 mb-2 px-3 py-2 rounded border border-[#F85149]/30 bg-[#F85149]/10 text-xs text-[#F85149]">
          Prioritization failed: {prioritization.error}
        </div>
      )}

      {/* Prioritization action bar */}
      {projectId && (
        <PrioritizationActionBar
          prioritization={prioritization}
          projectId={projectId}
          api={api}
          fetchTree={fetchTree}
        />
      )}

      <div className="space-y-0">
        {displayTree.map((node) => (
          <TreeNode
            key={node.number}
            node={node}
            depth={0}
            onLaunch={onLaunch}
            launchingIssues={launchingIssues}
            launchErrors={launchErrors}
            forceExpand={forceExpand}
            priorityMap={prioritization.hasPriority ? prioritization.priorityMap : undefined}
            checkedIssues={prioritization.hasPriority ? prioritization.checkedIssues : undefined}
            onCheckChange={prioritization.hasPriority ? prioritization.toggleCheck : undefined}
            onPrioritizeSubtree={prioritization.prioritizeSubtree}
            prioritizing={prioritization.loading}
            collapsedNodes={collapsedNodes}
            onToggleCollapse={onToggleCollapse}
          />
        ))}
      </div>

      {/* Run All confirmation dialog */}
      {showRunAllDialog && projectId && (
        <RunAllConfirmDialog
          issues={launchableInfo.launchable}
          skippedActive={launchableInfo.skippedActive}
          skippedBlocked={launchableInfo.skippedBlocked}
          projectId={projectId}
          api={api}
          fetchTree={fetchTree}
          onClose={() => setShowRunAllDialog(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a node matches the status filter */
function matchesStatusFilter(node: IssueNode, filter: string): boolean {
  if (filter === 'all') return true;
  if (filter === 'no-team') return !node.activeTeam;
  if (filter === 'blocked-deps') return !!(node.dependencies && !node.dependencies.resolved);
  return node.activeTeam?.status === filter;
}

/** Filter tree nodes by search query and status filter, keeping parents of matching children */
function filterTree(nodes: IssueNode[], query: string, statusFilter: string): IssueNode[] {
  const hasQuery = query.trim().length > 0;
  const hasStatusFilter = statusFilter !== 'all';

  // No filters active — return as-is
  if (!hasQuery && !hasStatusFilter) return nodes;

  const q = query.toLowerCase().trim();
  const isNumericQuery = /^\d+$/.test(q);
  const numMatch = q.startsWith('#') ? parseInt(q.slice(1), 10) : (isNumericQuery ? parseInt(q, 10) : NaN);

  return nodes.reduce<IssueNode[]>((acc, node) => {
    // Check if this node matches the text search
    const matchesSearch = !hasQuery ||
      (!isNaN(numMatch) && node.number === numMatch) ||
      node.title.toLowerCase().includes(q);

    // Check if this node matches the status filter
    const matchesStatus = matchesStatusFilter(node, statusFilter);

    // A node directly matches if it passes BOTH filters
    const directMatch = matchesSearch && matchesStatus;

    // Recursively filter children
    const filteredChildren = filterTree(node.children, query, statusFilter);

    // Include node if it directly matches OR has matching children
    if (directMatch || filteredChildren.length > 0) {
      acc.push({ ...node, children: filteredChildren });
    }
    return acc;
  }, []);
}

/** Collect all node IDs (issue numbers as strings) from a tree recursively */
function collectAllNodeIds(nodes: IssueNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    ids.push(node.number.toString());
    if (node.children.length > 0) {
      ids.push(...collectAllNodeIds(node.children));
    }
  }
  return ids;
}

/** Count nodes recursively */
function countNodes(nodes: IssueNode[]): number {
  let count = 0;
  for (const n of nodes) {
    count++;
    count += countNodes(n.children);
  }
  return count;
}

/** Collect launchable issues from a tree — open, no active team, no unresolved deps */
function collectLaunchableIssues(nodes: IssueNode[]): {
  launchable: IssueNode[];
  skippedActive: number;
  skippedBlocked: number;
} {
  const launchable: IssueNode[] = [];
  let skippedActive = 0;
  let skippedBlocked = 0;

  function walk(items: IssueNode[]) {
    for (const node of items) {
      if (node.state === 'open') {
        if (node.activeTeam) {
          skippedActive++;
        } else if (node.dependencies && !node.dependencies.resolved) {
          skippedBlocked++;
        } else {
          launchable.push(node);
        }
      }
      walk(node.children);
    }
  }

  walk(nodes);
  return { launchable, skippedActive, skippedBlocked };
}

/** Format a timestamp as HH:MM local time */
function formatRelativeTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' });
  } catch {
    return '--:--';
  }
}
