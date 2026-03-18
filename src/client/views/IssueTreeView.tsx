import { useState, useEffect, useCallback, useMemo } from 'react';
import { useApi } from '../hooks/useApi';
import { useFleet } from '../context/FleetContext';
import { TreeNode, type IssueNode } from '../components/TreeNode';
import type { ProjectSummary } from '../../shared/types';

// ---------------------------------------------------------------------------
// Status filter pill definitions
// ---------------------------------------------------------------------------

const STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'no-team', label: 'No Team' },
  { key: 'running', label: 'Running', color: '#3FB950' },
  { key: 'idle', label: 'Idle', color: '#D29922' },
  { key: 'stuck', label: 'Stuck', color: '#F85149' },
  { key: 'done', label: 'Done', color: '#56D4DD' },
  { key: 'failed', label: 'Failed', color: '#F85149' },
] as const;

// ---------------------------------------------------------------------------
// API response shape from GET /api/issues
// ---------------------------------------------------------------------------

interface IssueTreeResponse {
  tree: IssueNode[];
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
  const { selectedProjectId } = useFleet();
  const [tree, setTree] = useState<IssueNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [issueCount, setIssueCount] = useState(0);
  const [launchingIssues, setLaunchingIssues] = useState<Set<number>>(new Set());
  const [launchErrors, setLaunchErrors] = useState<Map<number, string>>(new Map());
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Fetch the project list so we can auto-resolve a project for launches
  // when "All Projects" is selected (selectedProjectId === null).
  useEffect(() => {
    api.get<ProjectSummary[]>('projects').then(setProjects).catch(() => {
      // Non-fatal — projects list is only used to auto-resolve launch target
    });
  }, [api]);

  // Resolve which project to use for launches:
  // 1. If user explicitly selected a project, use it.
  // 2. If only one project exists, auto-use it.
  // 3. Otherwise null — user must pick a project.
  const activeProjects = projects.filter((p) => p.status === 'active');
  const launchProjectId = selectedProjectId
    ?? (activeProjects.length === 1 ? activeProjects[0].id : null);

  // -------------------------------------------------------------------------
  // Fetch issue tree
  // -------------------------------------------------------------------------

  const fetchTree = useCallback(async () => {
    try {
      setError(null);
      const endpoint = selectedProjectId
        ? `projects/${selectedProjectId}/issues`
        : 'issues';
      const data = await api.get<IssueTreeResponse>(endpoint);
      setTree(data.tree);
      setCachedAt(data.cachedAt);
      setIssueCount(data.count);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [api, selectedProjectId]);

  useEffect(() => {
    fetchTree();
  }, [fetchTree]);

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

  const handleLaunch = useCallback(async (issueNumber: number, title: string) => {
    if (!launchProjectId) {
      const message = activeProjects.length > 1
        ? 'Multiple projects exist — select one from the top bar first'
        : 'Select a project first';
      setLaunchErrors(prev => {
        const next = new Map(prev);
        next.set(issueNumber, message);
        return next;
      });
      setTimeout(() => {
        setLaunchErrors(prev => {
          const next = new Map(prev);
          next.delete(issueNumber);
          return next;
        });
      }, 5000);
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
        projectId: launchProjectId,
      });
      // Don't immediately remove from launchingIssues — let it persist
      // so the user sees feedback until the tree refreshes with the active team badge.
      setTimeout(() => {
        setLaunchingIssues(prev => {
          const next = new Set(prev);
          next.delete(issueNumber);
          return next;
        });
        fetchTree();
      }, 5000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
      setTimeout(() => {
        setLaunchErrors(prev => {
          const next = new Map(prev);
          next.delete(issueNumber);
          return next;
        });
      }, 5000);
    }
  }, [api, fetchTree, launchProjectId, activeProjects.length]);

  // -------------------------------------------------------------------------
  // Filter tree by search query
  // -------------------------------------------------------------------------

  const filteredTree = useMemo(() => filterTree(tree, search, statusFilter), [tree, search, statusFilter]);

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
        ) : (
          <div className="space-y-0">
            {filteredTree.map((node) => (
              <TreeNode
                key={node.number}
                node={node}
                depth={0}
                onLaunch={handleLaunch}
                launchingIssues={launchingIssues}
                launchErrors={launchErrors}
                forceExpand={!!search || statusFilter !== 'all'}
              />
            ))}
          </div>
        )}
      </div>
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

/** Count nodes recursively */
function countNodes(nodes: IssueNode[]): number {
  let count = 0;
  for (const n of nodes) {
    count++;
    count += countNodes(n.children);
  }
  return count;
}

/** Format a timestamp as HH:MM local time */
function formatRelativeTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' });
  } catch {
    return '--:--';
  }
}
