import { useState, useEffect, useCallback } from 'react';
import { useApi } from '../hooks/useApi';
import { TreeNode, type IssueNode } from '../components/TreeNode';

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
  const [tree, setTree] = useState<IssueNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [issueCount, setIssueCount] = useState(0);

  // -------------------------------------------------------------------------
  // Fetch issue tree
  // -------------------------------------------------------------------------

  const fetchTree = useCallback(async () => {
    try {
      setError(null);
      const data = await api.get<IssueTreeResponse>('issues');
      setTree(data.tree);
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
  // Refresh (force re-fetch from GitHub)
  // -------------------------------------------------------------------------

  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      setError(null);
      const data = await api.post<IssueRefreshResponse>('issues/refresh');
      setTree(data.tree);
      setCachedAt(data.refreshedAt);
      setIssueCount(data.issueCount ?? countNodes(data.tree));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setRefreshing(false);
    }
  }, [api, refreshing]);

  // -------------------------------------------------------------------------
  // Launch team for an issue (play button)
  // -------------------------------------------------------------------------

  const handleLaunch = useCallback(async (issueNumber: number, title: string) => {
    try {
      await api.post('teams/launch', { issueNumber, issueTitle: title });
      // Re-fetch tree so activeTeam info updates
      await fetchTree();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[IssueTree] Failed to launch team for #${issueNumber}:`, message);
    }
  }, [api, fetchTree]);

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
      <div className="flex items-center justify-between px-4 py-3 border-b border-dark-border shrink-0">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-dark-text">Issue Tree</h2>
          <span className="text-xs text-dark-muted">
            {issueCount} issue{issueCount !== 1 ? 's' : ''}
          </span>
          {cachedAt && (
            <span className="text-xs text-dark-muted" title={cachedAt}>
              {'\u00B7'} cached {formatRelativeTime(cachedAt)}
            </span>
          )}
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
        ) : (
          <div className="space-y-0">
            {tree.map((node) => (
              <TreeNode
                key={node.number}
                node={node}
                depth={0}
                onLaunch={handleLaunch}
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

/** Count nodes recursively */
function countNodes(nodes: IssueNode[]): number {
  let count = 0;
  for (const n of nodes) {
    count++;
    count += countNodes(n.children);
  }
  return count;
}

/** Format a timestamp as relative time (e.g., "2m ago", "1h ago") */
function formatRelativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffSec = Math.floor((now - then) / 1000);

  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}
