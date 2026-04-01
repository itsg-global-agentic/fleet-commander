import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useApi } from '../hooks/useApi';
import { useFleetSSE } from '../hooks/useFleetSSE';
import type { IssueRelations } from '../../shared/issue-provider';
import { usePrioritization, sortTreeByPriority } from '../hooks/usePrioritization';
import { useIssueSelection } from '../hooks/useIssueSelection';
import { useCollapseState } from '../hooks/useCollapseState';
import { useFlattenedTree } from '../hooks/useVirtualizedTree';
import { VirtualizedTreeList } from '../components/VirtualizedTreeList';
import { ProviderIcon, DependencyGraphIcon } from '../components/Icons';
import { DependencyGraphModal } from '../components/DependencyGraphModal';
import type { IssueNode } from '../components/TreeNode';
import type { ProjectSummary } from '../../shared/types';

// ---------------------------------------------------------------------------
// Status filter pill definitions
// ---------------------------------------------------------------------------

const STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'no-team', label: 'No Team' },
  { key: 'blocked-deps', label: 'Blocked', color: '#F85149' },
  { key: 'queued', label: 'Queued', color: '#58A6FF' },
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
  groupId: number | null;
  groupName: string | null;
  tree: IssueNode[];
  cachedAt: string | null;
  count: number;
  providers?: string[];
}

/** A top-level group of projects (for the project group collapsible level) */
interface ProjectGroupBucket {
  /** Unique key for collapse state — `group-{id}` or `group-ungrouped` */
  key: string;
  /** Display name for the group header */
  name: string;
  /** Projects within this group */
  projects: ProjectIssueGroup[];
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
  const [providerFilter, setProviderFilter] = useState<string>('all');

  // Relations panel state
  const [relationsOpenKeys, setRelationsOpenKeys] = useState<Set<string>>(new Set());
  const [relationsMap, setRelationsMap] = useState<Map<string, IssueRelations>>(new Map());

  // Collapse state — persisted to localStorage
  const collapseState = useCollapseState();

  // Dependency confirmation dialog state
  const [depConfirm, setDepConfirm] = useState<{
    issueNumber: number;
    title: string;
    projectId: number;
    message: string;
    blockers: string[];
    issueKey?: string;
    issueProvider?: string;
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
  const activeProjects = useMemo(() => projects.filter((p) => p.status === 'active'), [projects]);
  const launchProjectId = useMemo(() => activeProjects.length === 1 ? activeProjects[0].id : null, [activeProjects]);

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

  const handleSSEEvent = useCallback((type: string, data: unknown) => {
    if (type === 'dependency_resolved') {
      fetchTree();
    }
    const rec = data as Record<string, unknown> | undefined;
    if (type === 'relations_updated' && rec) {
      const issueKey = rec.issue_key as string | undefined;
      const relations = rec.relations as IssueRelations | undefined;
      if (issueKey && relations) {
        setRelationsMap((prev) => {
          const next = new Map(prev);
          next.set(issueKey, relations);
          return next;
        });
      }
      // Also refresh the tree to pick up cache updates
      fetchTree();
    }
  }, [fetchTree]);

  useFleetSSE('dependency_resolved', handleSSEEvent);
  useFleetSSE('relations_updated', handleSSEEvent);

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
  // Relations panel toggle + relation change handler
  // -------------------------------------------------------------------------

  const handleToggleRelations = useCallback(
    async (issueKey: string) => {
      setRelationsOpenKeys((prev) => {
        const next = new Set(prev);
        if (next.has(issueKey)) {
          next.delete(issueKey);
        } else {
          next.add(issueKey);
        }
        return next;
      });

      // If opening, fetch relations data if not already loaded
      if (!relationsOpenKeys.has(issueKey)) {
        // Find the project ID for this issue from the groups
        let pid: number | undefined;
        for (const g of groups) {
          // Walk the tree to find this issue
          const walk = (nodes: IssueNode[]): boolean => {
            for (const n of nodes) {
              const nk = n.issueKey ?? String(n.number);
              if (nk === issueKey) {
                pid = g.projectId;
                return true;
              }
              if (walk(n.children)) return true;
            }
            return false;
          };
          if (walk(g.tree)) break;
        }

        if (pid === undefined && launchProjectId) {
          pid = launchProjectId;
        }

        if (pid !== undefined) {
          try {
            const relations = await api.get<IssueRelations>(
              `projects/${pid}/issues/${issueKey}/relations`,
            );
            setRelationsMap((prev) => {
              const next = new Map(prev);
              next.set(issueKey, relations);
              return next;
            });
          } catch (err) {
            console.warn(`Failed to fetch relations for ${issueKey}:`, err);
          }
        }
      }
    },
    [api, groups, launchProjectId, relationsOpenKeys],
  );

  const handleRelationChanged = useCallback(
    async (issueKey: string) => {
      // Find the project ID for this issue
      let pid: number | undefined;
      for (const g of groups) {
        const walk = (nodes: IssueNode[]): boolean => {
          for (const n of nodes) {
            const nk = n.issueKey ?? String(n.number);
            if (nk === issueKey) {
              pid = g.projectId;
              return true;
            }
            if (walk(n.children)) return true;
          }
          return false;
        };
        if (walk(g.tree)) break;
      }

      if (pid === undefined && launchProjectId) {
        pid = launchProjectId;
      }

      if (pid !== undefined) {
        try {
          const relations = await api.get<IssueRelations>(
            `projects/${pid}/issues/${issueKey}/relations`,
          );
          setRelationsMap((prev) => {
            const next = new Map(prev);
            next.set(issueKey, relations);
            return next;
          });
        } catch (err) {
          console.warn(`Failed to refresh relations for ${issueKey}:`, err);
        }
      }

      // Also refresh the full tree
      fetchTree();
    },
    [api, groups, launchProjectId, fetchTree],
  );

  // -------------------------------------------------------------------------
  // Launch team for an issue (play button)
  // -------------------------------------------------------------------------

  const handleLaunch = useCallback(async (issueNumber: number, title: string, contextProjectId?: number, issueKey?: string, issueProvider?: string) => {
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
        issueKey: issueKey ?? String(issueNumber),
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
          issueKey,
          issueProvider,
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
    const { issueNumber, title, projectId, issueKey } = depConfirm;
    setDepConfirm(null);
    setLaunchingIssues(prev => new Set(prev).add(issueNumber));

    try {
      await api.post('teams/launch', {
        issueNumber,
        issueKey: issueKey ?? String(issueNumber),
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

  // Handle queue launch (queue with blockers until dependencies resolve)
  const handleQueueLaunch = useCallback(async () => {
    if (!depConfirm) return;
    const { issueNumber, title, projectId, issueKey } = depConfirm;
    setDepConfirm(null);
    setLaunchingIssues(prev => new Set(prev).add(issueNumber));

    try {
      await api.post('teams/launch', {
        issueNumber,
        issueKey: issueKey ?? String(issueNumber),
        issueTitle: title,
        projectId,
        queue: true,
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
  // Compute available providers across all groups/tree for filter pills
  // -------------------------------------------------------------------------

  const availableProviders = useMemo(() => {
    const providerSet = new Set<string>();
    function walkProviders(nodes: IssueNode[]) {
      for (const node of nodes) {
        providerSet.add(node.issueProvider ?? 'github');
        walkProviders(node.children);
      }
    }
    if (groups.length > 0) {
      for (const g of groups) {
        // Use server-provided providers if available, else walk the tree
        if (g.providers && g.providers.length > 0) {
          for (const p of g.providers) providerSet.add(p);
        } else {
          walkProviders(g.tree);
        }
      }
    } else {
      walkProviders(tree);
    }
    return [...providerSet].sort();
  }, [tree, groups]);

  // -------------------------------------------------------------------------
  // Filter tree by search query, status, and provider
  // -------------------------------------------------------------------------

  const filteredTree = useMemo(() => filterTree(tree, search, statusFilter, providerFilter), [tree, search, statusFilter, providerFilter]);

  // Filtered groups for the grouped view
  const filteredGroups = useMemo(() => {
    if (groups.length === 0) return [];
    return groups
      .map((g) => ({
        ...g,
        tree: filterTree(g.tree, search, statusFilter, providerFilter),
      }))
      .filter((g) => g.tree.length > 0);
  }, [groups, search, statusFilter, providerFilter]);

  // Group filtered project groups into top-level buckets by groupId
  // Only creates buckets when there are multiple distinct groups (at least one project has a groupId)
  const groupedBuckets = useMemo((): ProjectGroupBucket[] => {
    if (filteredGroups.length === 0) return [];

    // Check if any project has a groupId — if not, skip the grouping level entirely
    const hasAnyGroupId = filteredGroups.some((g) => g.groupId != null);
    if (!hasAnyGroupId) return [];

    const bucketMap = new Map<string, ProjectGroupBucket>();
    for (const pg of filteredGroups) {
      const key = pg.groupId != null ? `group-${pg.groupId}` : 'group-ungrouped';
      const name = pg.groupName ?? 'Ungrouped';
      let bucket = bucketMap.get(key);
      if (!bucket) {
        bucket = { key, name, projects: [] };
        bucketMap.set(key, bucket);
      }
      bucket.projects.push(pg);
    }

    // Sort alphabetically, with "Ungrouped" last
    const buckets = [...bucketMap.values()].sort((a, b) => {
      if (a.key === 'group-ungrouped') return 1;
      if (b.key === 'group-ungrouped') return -1;
      return a.name.localeCompare(b.name);
    });

    return buckets;
  }, [filteredGroups]);

  // Collect all node IDs from the full (unfiltered) tree for Collapse All
  // Includes group bucket IDs (group-{id}), project group IDs (project-{id}),
  // provider sub-group IDs (provider-{projectId}-{providerName}), and individual issue node IDs
  const allNodeIds = useMemo(() => {
    if (groups.length > 0) {
      const hasAnyGroupId = groups.some((g) => g.groupId != null);
      const groupKeys = hasAnyGroupId
        ? [...new Set(groups.map((g) => g.groupId != null ? `group-${g.groupId}` : 'group-ungrouped'))]
        : [];
      return [
        ...groupKeys,
        ...groups.flatMap((g) => {
          // Collect provider sub-group keys when multiple providers exist
          const providerKeys: string[] = [];
          if (g.providers && g.providers.length > 1) {
            for (const p of g.providers) {
              providerKeys.push(`provider-${g.projectId}-${p}`);
            }
          }
          return [
            `project-${g.projectId}`,
            ...providerKeys,
            ...collectAllNodeIds(g.tree),
          ];
        }),
      ];
    }
    return collectAllNodeIds(tree);
  }, [tree, groups]);

  // Seed default collapse state: collapse parent nodes at depth >= 2
  // This only fires once on first load when localStorage is empty.
  const deepNodeIds = useMemo(() => {
    if (groups.length > 0) {
      return groups.flatMap((g) => collectDeepParentNodeIds(g.tree, 0, 2));
    }
    return collectDeepParentNodeIds(tree, 0, 2);
  }, [tree, groups]);

  useEffect(() => {
    if (deepNodeIds.length > 0) {
      collapseState.seedDefaults(deepNodeIds);
    }
  }, [deepNodeIds, collapseState.seedDefaults]);

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
            {search || statusFilter !== 'all' || providerFilter !== 'all'
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

        {/* Provider filter pills — only shown when 2+ providers */}
        {availableProviders.length > 1 && (
          <div className="flex items-center gap-1 flex-wrap" data-testid="provider-filter-pills">
            <button
              onClick={() => setProviderFilter('all')}
              className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-full border transition-colors ${
                providerFilter === 'all'
                  ? 'border-dark-accent/50 bg-dark-accent/20 text-dark-accent'
                  : 'border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-muted'
              }`}
            >
              All Sources
            </button>
            {availableProviders.map((p) => (
              <button
                key={p}
                onClick={() => setProviderFilter(p)}
                className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-full border transition-colors ${
                  providerFilter === p
                    ? 'border-dark-accent/50 bg-dark-accent/20 text-dark-accent'
                    : 'border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-muted'
                }`}
              >
                <ProviderIcon provider={p} size={12} />
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </button>
            ))}
          </div>
        )}

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
              onClick={() => { setSearch(''); setStatusFilter('all'); setProviderFilter('all'); }}
              className="text-xs text-dark-accent hover:underline"
            >
              Clear filters
            </button>
          </div>
        ) : groupedBuckets.length > 0 ? (
          /* Grouped view with project groups — group bucket > project > issues */
          <div className="space-y-2">
            {groupedBuckets.map((bucket) => (
              <ProjectGroupSection
                key={bucket.key}
                bucket={bucket}
                onLaunch={handleLaunch}
                launchingIssues={launchingIssues}
                launchErrors={launchErrors}
                forceExpand={!!search || statusFilter !== 'all' || providerFilter !== 'all'}
                fetchTree={fetchTree}
                collapsedNodes={collapseState.collapsedNodes}
                onToggleCollapse={collapseState.toggleCollapse}
                relationsOpenKeys={relationsOpenKeys}
                onToggleRelations={handleToggleRelations}
                relationsMap={relationsMap}
                onRelationChanged={handleRelationChanged}
              />
            ))}
          </div>
        ) : filteredGroups.length > 0 ? (
          /* Multi-project view without group assignments — flat project groups */
          <div className="space-y-1">
            {filteredGroups.map((group) => (
              <ProjectGroup
                key={group.projectId}
                group={group}
                onLaunch={handleLaunch}
                launchingIssues={launchingIssues}
                launchErrors={launchErrors}
                forceExpand={!!search || statusFilter !== 'all' || providerFilter !== 'all'}
                fetchTree={fetchTree}
                collapsedNodes={collapseState.collapsedNodes}
                onToggleCollapse={collapseState.toggleCollapse}
                relationsOpenKeys={relationsOpenKeys}
                onToggleRelations={handleToggleRelations}
                relationsMap={relationsMap}
                onRelationChanged={handleRelationChanged}
              />
            ))}
          </div>
        ) : (
          /* Single-project fallback — render as a ProjectGroup with launchProjectId */
          <SingleProjectTree
            tree={filteredTree}
            projectId={launchProjectId}
            projectName={activeProjects.length === 1 ? activeProjects[0].name : undefined}
            onLaunch={handleLaunch}
            launchingIssues={launchingIssues}
            launchErrors={launchErrors}
            forceExpand={!!search || statusFilter !== 'all' || providerFilter !== 'all'}
            fetchTree={fetchTree}
            collapsedNodes={collapseState.collapsedNodes}
            onToggleCollapse={collapseState.toggleCollapse}
            relationsOpenKeys={relationsOpenKeys}
            onToggleRelations={handleToggleRelations}
            relationsMap={relationsMap}
            onRelationChanged={handleRelationChanged}
          />
        )}
      </div>

      {/* Dependency confirmation dialog */}
      {depConfirm && (
        <DependencyConfirmDialog
          issueNumber={depConfirm.issueNumber}
          issueKey={depConfirm.issueKey}
          message={depConfirm.message}
          onForce={handleForceLaunch}
          onQueue={handleQueueLaunch}
          onCancel={() => setDepConfirm(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DependencyConfirmDialog — shown when launching a blocked issue
// ---------------------------------------------------------------------------

function DependencyConfirmDialog({ issueNumber, issueKey, message, onForce, onQueue, onCancel }: {
  issueNumber: number;
  issueKey?: string;
  message: string;
  onForce: () => void;
  onQueue: () => void;
  onCancel: () => void;
}) {
  const displayKey = issueKey ?? `#${issueNumber}`;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[420px] max-w-[95vw] bg-dark-surface border border-dark-border rounded-lg shadow-2xl">
        <div className="px-5 py-4 border-b border-dark-border">
          <h3 className="text-sm font-semibold text-dark-text flex items-center gap-2">
            <svg className="w-4 h-4 text-[#F85149]" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.25 7.25a.75.75 0 0 0 0 1.5h7.5a.75.75 0 0 0 0-1.5h-7.5Z" />
              <path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z" />
            </svg>
            Issue {displayKey} has unresolved dependencies
          </h3>
        </div>
        <div className="px-5 py-4">
          <p className="text-sm text-dark-muted mb-3">
            {message}
          </p>
          <p className="text-xs text-dark-muted">
            You can <strong>queue</strong> this issue to auto-launch when blockers resolve, or <strong>force launch</strong> to bypass the dependency check.
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
            onClick={onQueue}
            className="px-4 py-1.5 text-sm font-medium rounded border border-[#58A6FF]/40 text-[#58A6FF] bg-[#58A6FF]/10 hover:bg-[#58A6FF]/20 transition-colors"
          >
            Queue
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

function RunAllConfirmDialog({ issues, skippedActive, blockedIssues, projectId, api, fetchTree, onClose }: {
  issues: IssueNode[];
  skippedActive: number;
  blockedIssues: IssueNode[];
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
        issues: issues.map((n) => ({
          number: n.number,
          title: n.title,
          issueKey: n.issueKey,
          issueProvider: n.issueProvider,
        })),
        blockedIssues: blockedIssues.length > 0
          ? blockedIssues.map((n) => ({
              number: n.number,
              title: n.title,
              issueKey: n.issueKey,
              issueProvider: n.issueProvider,
              blockedBy: n.dependencies?.blockedBy
                ?.filter((b) => b.state === 'open')
                .map((b) => b.number) ?? [],
            }))
          : undefined,
      });
      onClose();
      // Give the server a moment to process, then refresh
      setTimeout(() => fetchTree(), 3000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setLaunching(false);
    }
  }, [api, projectId, issues, blockedIssues, onClose, fetchTree]);

  if (issues.length === 0 && blockedIssues.length === 0) return null;

  const headerText = issues.length > 0
    ? `Launch ${issues.length} team${issues.length !== 1 ? 's' : ''}?`
    : `Queue ${blockedIssues.length} team${blockedIssues.length !== 1 ? 's' : ''}?`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[480px] max-w-[95vw] bg-dark-surface border border-dark-border rounded-lg shadow-2xl">
        <div className="px-5 py-4 border-b border-dark-border">
          <h3 className="text-sm font-semibold text-dark-text flex items-center gap-2">
            <svg className="w-4 h-4 text-[#3FB950]" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215Z" />
            </svg>
            {headerText}
          </h3>
        </div>
        <div className="px-5 py-4 max-h-[50vh] overflow-auto">
          {/* List of issues to launch now */}
          {issues.length > 0 && (
            <ul className="space-y-1 mb-3">
              {issues.map((n) => (
                <li key={n.issueKey ?? n.number} className="text-xs text-dark-text flex items-center gap-2">
                  <svg className="w-3 h-3 text-[#3FB950] shrink-0" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
                    <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" />
                  </svg>
                  <span className="text-dark-muted">{n.issueKey ?? `#${n.number}`}</span>
                  <span className="truncate">{n.title}</span>
                </li>
              ))}
            </ul>
          )}

          {/* Blocked issues — queued, waiting for dependencies */}
          {blockedIssues.length > 0 && (
            <div className={issues.length > 0 ? 'border-t border-dark-border/40 pt-2 mb-3' : 'mb-3'}>
              <p className="text-xs text-[#D29922] mb-1">
                {blockedIssues.length} issue{blockedIssues.length !== 1 ? 's' : ''} queued (waiting for dependencies to resolve)
              </p>
              <ul className="space-y-1">
                {blockedIssues.map((n) => (
                  <li key={n.issueKey ?? n.number} className="text-xs text-dark-text flex items-center gap-2">
                    <svg className="w-3 h-3 text-[#D29922] shrink-0" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
                      <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" />
                    </svg>
                    <span className="text-dark-muted">{n.issueKey ?? `#${n.number}`}</span>
                    <span className="truncate">{n.title}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Skipped counts */}
          {skippedActive > 0 && (
            <div className="text-xs text-dark-muted space-y-0.5 mb-3 border-t border-dark-border/40 pt-2">
              <p>{skippedActive} issue{skippedActive !== 1 ? 's' : ''} skipped (already have active teams)</p>
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
            {launching ? 'Launching...' : issues.length > 0 ? 'Launch All' : 'Queue All'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PrioritizeButtons — shared Prioritize + Reset button pair
// ---------------------------------------------------------------------------

function PrioritizeButtons({ prioritization, tree, className, onRunAll, runAllDisabled, onRunSelected, runSelectedCount, runSelectedDisabled, onSelectAll, onDeselectAll, isAllSelected, showSelectionControls }: {
  prioritization: ReturnType<typeof usePrioritization>;
  tree: IssueNode[];
  className?: string;
  onRunAll?: () => void;
  runAllDisabled?: boolean;
  onRunSelected?: () => void;
  runSelectedCount?: number;
  runSelectedDisabled?: boolean;
  onSelectAll?: () => void;
  onDeselectAll?: () => void;
  isAllSelected?: boolean;
  showSelectionControls?: boolean;
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

      {/* Run Selected button — shown when issues are selected */}
      {onRunSelected && (runSelectedCount ?? 0) > 0 && (
        <button
          onClick={onRunSelected}
          disabled={runSelectedDisabled}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-[#58A6FF]/50 text-[#58A6FF] hover:bg-[#58A6FF]/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title="Launch teams for selected issues"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215Z" />
          </svg>
          Run Selected ({runSelectedCount})
        </button>
      )}

      {/* Select All / Deselect All toggle */}
      {showSelectionControls && onSelectAll && onDeselectAll && (
        <button
          onClick={isAllSelected ? onDeselectAll : onSelectAll}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-accent/50 transition-colors"
          title={isAllSelected ? 'Deselect all issues' : 'Select all issues'}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
            {isAllSelected ? (
              <path d="M2.75 1h10.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25V2.75C1 1.784 1.784 1 2.75 1Zm0 1.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25Z" />
            ) : (
              <path d="M2.75 1h10.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25V2.75C1 1.784 1.784 1 2.75 1ZM2.5 2.75v10.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25H2.75a.25.25 0 0 0-.25.25Zm9.28 3.53-4.5 4.5a.75.75 0 0 1-1.06 0l-2-2a.75.75 0 0 1 1.06-1.06l1.47 1.47 3.97-3.97a.75.75 0 0 1 1.06 1.06Z" />
            )}
          </svg>
          {isAllSelected ? 'Deselect All' : 'Select All'}
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
// ProjectGroupSection — top-level collapsible group of projects
// ---------------------------------------------------------------------------

interface ProjectGroupSectionProps {
  bucket: ProjectGroupBucket;
  onLaunch: (issueNumber: number, title: string, projectId?: number, issueKey?: string, issueProvider?: string) => Promise<void>;
  launchingIssues: Set<number>;
  launchErrors: Map<number, string>;
  forceExpand: boolean;
  fetchTree: () => Promise<void>;
  collapsedNodes: Set<string>;
  onToggleCollapse: (nodeId: string) => void;
  relationsOpenKeys?: Set<string>;
  onToggleRelations?: (issueKey: string) => void;
  relationsMap?: Map<string, IssueRelations>;
  onRelationChanged?: (issueKey: string) => void;
}

function ProjectGroupSection({ bucket, onLaunch, launchingIssues, launchErrors, forceExpand, fetchTree, collapsedNodes, onToggleCollapse, relationsOpenKeys, onToggleRelations, relationsMap, onRelationChanged }: ProjectGroupSectionProps) {
  const expanded = !collapsedNodes.has(bucket.key);
  const totalIssueCount = (bucket.projects ?? []).reduce((sum, p) => sum + countNodes(p.tree), 0);

  return (
    <div>
      {/* Group section header */}
      <div className="flex items-center gap-2 py-2 px-2 rounded hover:bg-dark-surface/60 transition-colors">
        <button
          onClick={() => onToggleCollapse(bucket.key)}
          className="flex items-center gap-2 flex-1 text-left min-w-0"
        >
          {/* Expand/collapse arrow */}
          <span className={`w-4 h-4 flex items-center justify-center text-dark-muted shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}>
            <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
              <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </span>
          {/* Folder icon for group */}
          <svg className="w-4 h-4 text-dark-accent/70 shrink-0" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
          </svg>
          <span className="text-sm font-semibold text-dark-text truncate">
            {bucket.name}
          </span>
          <span className="text-xs text-dark-muted shrink-0">
            {bucket.projects.length} project{bucket.projects.length !== 1 ? 's' : ''}
            {' \u00B7 '}
            {totalIssueCount} issue{totalIssueCount !== 1 ? 's' : ''}
          </span>
        </button>
      </div>

      {/* Nested project groups */}
      {expanded && (
        <div className="ml-2 border-l border-dark-accent/20 pl-1">
          <div className="space-y-1">
            {bucket.projects.map((group) => (
              <ProjectGroup
                key={group.projectId}
                group={group}
                onLaunch={onLaunch}
                launchingIssues={launchingIssues}
                launchErrors={launchErrors}
                forceExpand={forceExpand}
                fetchTree={fetchTree}
                collapsedNodes={collapsedNodes}
                onToggleCollapse={onToggleCollapse}
                relationsOpenKeys={relationsOpenKeys}
                onToggleRelations={onToggleRelations}
                relationsMap={relationsMap}
                onRelationChanged={onRelationChanged}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProjectGroup — collapsible project section with its own prioritization
// ---------------------------------------------------------------------------

interface ProjectGroupProps {
  group: { projectId: number; projectName: string; tree: IssueNode[]; count: number; providers?: string[] };
  onLaunch: (issueNumber: number, title: string, projectId?: number, issueKey?: string, issueProvider?: string) => Promise<void>;
  launchingIssues: Set<number>;
  launchErrors: Map<number, string>;
  forceExpand: boolean;
  fetchTree: () => Promise<void>;
  collapsedNodes: Set<string>;
  onToggleCollapse: (nodeId: string) => void;
  relationsOpenKeys?: Set<string>;
  onToggleRelations?: (issueKey: string) => void;
  relationsMap?: Map<string, IssueRelations>;
  onRelationChanged?: (issueKey: string) => void;
}

function ProjectGroup({ group, onLaunch, launchingIssues, launchErrors, forceExpand, fetchTree, collapsedNodes, onToggleCollapse, relationsOpenKeys, onToggleRelations, relationsMap, onRelationChanged }: ProjectGroupProps) {
  const api = useApi();
  const projectNodeId = `project-${group.projectId}`;
  const expanded = !collapsedNodes.has(projectNodeId);
  const prioritization = usePrioritization();
  const selection = useIssueSelection();
  const [showRunAllDialog, setShowRunAllDialog] = useState(false);
  const [showRunSelectedDialog, setShowRunSelectedDialog] = useState(false);
  const [showDepGraph, setShowDepGraph] = useState(false);

  // Detect distinct providers in this group's tree
  const distinctProviders = useMemo(() => {
    if (group.providers && group.providers.length > 0) return group.providers;
    const providerSet = new Set<string>();
    function walk(nodes: IssueNode[]) {
      for (const n of nodes) {
        providerSet.add(n.issueProvider ?? 'github');
        walk(n.children);
      }
    }
    walk(group.tree);
    return [...providerSet].sort();
  }, [group.tree, group.providers]);

  const hasMultipleProviders = distinctProviders.length > 1;

  // Per-provider issue counts for the header badges
  const providerCounts = useMemo(() => {
    if (!hasMultipleProviders) return null;
    const counts = new Map<string, number>();
    function walk(nodes: IssueNode[]) {
      for (const n of nodes) {
        const p = n.issueProvider ?? 'github';
        counts.set(p, (counts.get(p) ?? 0) + 1);
        walk(n.children);
      }
    }
    walk(group.tree);
    return counts;
  }, [group.tree, hasMultipleProviders]);

  // Split tree into per-provider buckets (only when multiple providers exist)
  const providerBuckets = useMemo(() => {
    if (!hasMultipleProviders) return null;
    const buckets = new Map<string, IssueNode[]>();
    function walk(nodes: IssueNode[]): Map<string, IssueNode[]> {
      for (const node of nodes) {
        const p = node.issueProvider ?? 'github';
        if (!buckets.has(p)) buckets.set(p, []);
        buckets.get(p)!.push(node);
      }
      return buckets;
    }
    walk(group.tree);
    return buckets;
  }, [group.tree, hasMultipleProviders]);

  const displayTree = useMemo(() => {
    if (!prioritization.hasPriority) return group.tree;
    return sortTreeByPriority(group.tree, prioritization.priorityMap);
  }, [group.tree, prioritization.hasPriority, prioritization.priorityMap]);

  const launchableInfo = useMemo(() => collectLaunchableIssues(group.tree), [group.tree]);
  const selectedLaunchableInfo = useMemo(
    () => collectLaunchableFromSelection(group.tree, selection.selectedIssues),
    [group.tree, selection.selectedIssues],
  );

  const flatRows = useFlattenedTree(displayTree, collapsedNodes, forceExpand);

  // Build header count text
  const totalCount = countNodes(group.tree);
  const headerCountText = useMemo(() => {
    if (!hasMultipleProviders || !providerCounts) {
      return `${totalCount} issue${totalCount !== 1 ? 's' : ''}`;
    }
    const parts = distinctProviders
      .filter((p) => providerCounts.has(p))
      .map((p) => `${p.charAt(0).toUpperCase() + p.slice(1)}: ${providerCounts.get(p)}`);
    return `${totalCount} issue${totalCount !== 1 ? 's' : ''} (${parts.join(', ')})`;
  }, [totalCount, hasMultipleProviders, providerCounts, distinctProviders]);

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
            {headerCountText}
          </span>
        </button>

        <button
          onClick={() => setShowDepGraph(true)}
          className="inline-flex items-center justify-center w-7 h-7 rounded border border-dark-border text-dark-muted hover:text-dark-accent hover:border-dark-accent/50 transition-colors"
          title="View dependency graph"
        >
          <DependencyGraphIcon size={14} />
        </button>

        <PrioritizeButtons
          prioritization={prioritization}
          tree={group.tree}
          onRunAll={() => setShowRunAllDialog(true)}
          runAllDisabled={launchableInfo.launchable.length === 0 && launchableInfo.blocked.length === 0}
          onRunSelected={() => setShowRunSelectedDialog(true)}
          runSelectedCount={selectedLaunchableInfo.launchable.length + selectedLaunchableInfo.blocked.length}
          runSelectedDisabled={selectedLaunchableInfo.launchable.length === 0 && selectedLaunchableInfo.blocked.length === 0}
          onSelectAll={() => selection.selectAll(group.tree)}
          onDeselectAll={selection.deselectAll}
          isAllSelected={selection.isAllSelected(group.tree)}
          showSelectionControls={!prioritization.hasPriority}
        />
      </div>

      {/* Prioritization error banner */}
      {prioritization.error && (
        <div className="mx-2 mb-1 px-3 py-2 rounded border border-[#F85149]/30 bg-[#F85149]/10 text-xs text-[#F85149]">
          Prioritization failed: {prioritization.error}
        </div>
      )}

      {/* Prioritization loading banner */}
      {prioritization.loading && (
        <div className="mx-2 mb-1 px-3 py-2 rounded border border-[#A371F7]/30 bg-[#A371F7]/10 flex items-center gap-2">
          <svg className="w-4 h-4 text-[#A371F7] animate-spin shrink-0" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          <span className="text-xs text-[#A371F7]">Prioritizing issues... this may take a few minutes</span>
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
          {hasMultipleProviders && providerBuckets ? (
            /* Multi-provider: render per-provider sub-groups */
            <div className="space-y-1">
              {distinctProviders.map((provider) => {
                const providerIssues = providerBuckets.get(provider) ?? [];
                if (providerIssues.length === 0) return null;
                return (
                  <ProviderSubGroup
                    key={`provider-${group.projectId}-${provider}`}
                    provider={provider}
                    issues={providerIssues}
                    projectId={group.projectId}
                    nodeKey={`provider-${group.projectId}-${provider}`}
                    onLaunch={onLaunch}
                    launchingIssues={launchingIssues}
                    launchErrors={launchErrors}
                    forceExpand={forceExpand}
                    fetchTree={fetchTree}
                    collapsedNodes={collapsedNodes}
                    onToggleCollapse={onToggleCollapse}
                    api={api}
                    relationsOpenKeys={relationsOpenKeys}
                    onToggleRelations={onToggleRelations}
                    relationsMap={relationsMap}
                    onRelationChanged={onRelationChanged}
                  />
                );
              })}
            </div>
          ) : (
            /* Single provider: flat list as before (virtualized) */
            <VirtualizedTreeList
              rows={flatRows}
              onLaunch={onLaunch}
              launchingIssues={launchingIssues}
              launchErrors={launchErrors}
              projectId={group.projectId}
              priorityMap={prioritization.hasPriority ? prioritization.priorityMap : undefined}
              checkedIssues={prioritization.hasPriority ? prioritization.checkedIssues : selection.selectedIssues}
              onCheckChange={prioritization.hasPriority ? prioritization.toggleCheck : selection.toggleCheck}
              onCheckWithChildren={prioritization.hasPriority ? undefined : selection.toggleWithChildren}
              onPrioritizeSubtree={prioritization.prioritizeSubtree}
              prioritizing={prioritization.loading}
              collapsedNodes={collapsedNodes}
              onToggleCollapse={onToggleCollapse}
              relationsOpenKeys={relationsOpenKeys}
              onToggleRelations={onToggleRelations}
              relationsMap={relationsMap}
              onRelationChanged={onRelationChanged}
              className="max-h-[70vh]"
            />
          )}
        </div>
      )}

      {/* Run All confirmation dialog */}
      {showRunAllDialog && (
        <RunAllConfirmDialog
          issues={launchableInfo.launchable}
          skippedActive={launchableInfo.skippedActive}
          blockedIssues={launchableInfo.blocked}
          projectId={group.projectId}
          api={api}
          fetchTree={fetchTree}
          onClose={() => setShowRunAllDialog(false)}
        />
      )}

      {/* Run Selected confirmation dialog */}
      {showRunSelectedDialog && (
        <RunAllConfirmDialog
          issues={selectedLaunchableInfo.launchable}
          skippedActive={selectedLaunchableInfo.skippedActive}
          blockedIssues={selectedLaunchableInfo.blocked}
          projectId={group.projectId}
          api={api}
          fetchTree={fetchTree}
          onClose={() => {
            setShowRunSelectedDialog(false);
            selection.deselectAll();
          }}
        />
      )}

      {/* Dependency graph modal */}
      {showDepGraph && (
        <DependencyGraphModal
          issues={group.tree}
          projectName={group.projectName}
          onClose={() => setShowDepGraph(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProviderSubGroup — collapsible sub-group for a single provider within a project
// ---------------------------------------------------------------------------

interface ProviderSubGroupProps {
  provider: string;
  issues: IssueNode[];
  projectId: number;
  nodeKey: string;
  onLaunch: (issueNumber: number, title: string, projectId?: number, issueKey?: string, issueProvider?: string) => Promise<void>;
  launchingIssues: Set<number>;
  launchErrors: Map<number, string>;
  forceExpand: boolean;
  fetchTree: () => Promise<void>;
  collapsedNodes: Set<string>;
  onToggleCollapse: (nodeId: string) => void;
  api: ReturnType<typeof useApi>;
  relationsOpenKeys?: Set<string>;
  onToggleRelations?: (issueKey: string) => void;
  relationsMap?: Map<string, IssueRelations>;
  onRelationChanged?: (issueKey: string) => void;
}

function ProviderSubGroup({ provider, issues, projectId, nodeKey, onLaunch, launchingIssues, launchErrors, forceExpand, fetchTree, collapsedNodes, onToggleCollapse, api, relationsOpenKeys, onToggleRelations, relationsMap, onRelationChanged }: ProviderSubGroupProps) {
  const expanded = !collapsedNodes.has(nodeKey);
  const selection = useIssueSelection();
  const [showRunAllDialog, setShowRunAllDialog] = useState(false);
  const [showRunSelectedDialog, setShowRunSelectedDialog] = useState(false);

  const flatRows = useFlattenedTree(issues, collapsedNodes, forceExpand);
  const launchableInfo = useMemo(() => collectLaunchableIssues(issues), [issues]);
  const selectedLaunchableInfo = useMemo(
    () => collectLaunchableFromSelection(issues, selection.selectedIssues),
    [issues, selection.selectedIssues],
  );
  const issueCount = countNodes(issues);
  const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);

  return (
    <div data-testid={`provider-subgroup-${provider}`}>
      {/* Provider sub-group header */}
      <div className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-dark-surface/40 transition-colors">
        <button
          onClick={() => onToggleCollapse(nodeKey)}
          className="flex items-center gap-2 flex-1 text-left min-w-0"
        >
          {/* Expand/collapse arrow */}
          <span className={`w-3.5 h-3.5 flex items-center justify-center text-dark-muted shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}>
            <svg className="w-2.5 h-2.5" viewBox="0 0 16 16" fill="currentColor">
              <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </span>
          {/* Provider icon */}
          <ProviderIcon provider={provider} size={14} className="text-dark-muted shrink-0" />
          <span className="text-xs font-medium text-dark-text">
            {providerLabel}
          </span>
          <span className="text-xs text-dark-muted shrink-0">
            {issueCount} issue{issueCount !== 1 ? 's' : ''}
          </span>
        </button>

        {/* Provider-scoped Run All */}
        <button
          onClick={() => setShowRunAllDialog(true)}
          disabled={launchableInfo.launchable.length === 0 && launchableInfo.blocked.length === 0}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-[#3FB950]/50 text-[#3FB950] hover:bg-[#3FB950]/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title={`Launch teams for all ${providerLabel} issues`}
        >
          <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1.5 3.5a.5.5 0 0 1 .8-.4l4.5 3.4a.5.5 0 0 1 0 .8l-4.5 3.4a.5.5 0 0 1-.8-.4V3.5Zm7 0a.5.5 0 0 1 .8-.4l4.5 3.4a.5.5 0 0 1 0 .8l-4.5 3.4a.5.5 0 0 1-.8-.4V3.5Z" />
          </svg>
          Run All
        </button>

        {/* Provider-scoped Run Selected */}
        {(selectedLaunchableInfo.launchable.length + selectedLaunchableInfo.blocked.length) > 0 && (
          <button
            onClick={() => setShowRunSelectedDialog(true)}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-[#58A6FF]/50 text-[#58A6FF] hover:bg-[#58A6FF]/10 transition-colors"
            title="Launch teams for selected issues"
          >
            <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215Z" />
            </svg>
            Run Selected ({selectedLaunchableInfo.launchable.length + selectedLaunchableInfo.blocked.length})
          </button>
        )}

        {/* Provider-scoped Select All / Deselect All */}
        <button
          onClick={selection.isAllSelected(issues) ? selection.deselectAll : () => selection.selectAll(issues)}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-accent/50 transition-colors"
          title={selection.isAllSelected(issues) ? 'Deselect all issues' : 'Select all issues'}
        >
          {selection.isAllSelected(issues) ? 'Deselect All' : 'Select All'}
        </button>
      </div>

      {/* Provider sub-group issue tree */}
      {expanded && (
        <div className="ml-2 border-l border-dark-border/20 pl-1">
          <VirtualizedTreeList
            rows={flatRows}
            onLaunch={onLaunch}
            launchingIssues={launchingIssues}
            launchErrors={launchErrors}
            projectId={projectId}
            checkedIssues={selection.selectedIssues}
            onCheckChange={selection.toggleCheck}
            onCheckWithChildren={selection.toggleWithChildren}
            collapsedNodes={collapsedNodes}
            onToggleCollapse={onToggleCollapse}
            relationsOpenKeys={relationsOpenKeys}
            onToggleRelations={onToggleRelations}
            relationsMap={relationsMap}
            onRelationChanged={onRelationChanged}
            className="max-h-[60vh]"
          />
        </div>
      )}

      {/* Provider-scoped Run All dialog */}
      {showRunAllDialog && (
        <RunAllConfirmDialog
          issues={launchableInfo.launchable}
          skippedActive={launchableInfo.skippedActive}
          blockedIssues={launchableInfo.blocked}
          projectId={projectId}
          api={api}
          fetchTree={fetchTree}
          onClose={() => setShowRunAllDialog(false)}
        />
      )}

      {/* Provider-scoped Run Selected dialog */}
      {showRunSelectedDialog && (
        <RunAllConfirmDialog
          issues={selectedLaunchableInfo.launchable}
          skippedActive={selectedLaunchableInfo.skippedActive}
          blockedIssues={selectedLaunchableInfo.blocked}
          projectId={projectId}
          api={api}
          fetchTree={fetchTree}
          onClose={() => {
            setShowRunSelectedDialog(false);
            selection.deselectAll();
          }}
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
  projectName?: string;
  onLaunch: (issueNumber: number, title: string, projectId?: number, issueKey?: string, issueProvider?: string) => Promise<void>;
  launchingIssues: Set<number>;
  launchErrors: Map<number, string>;
  forceExpand: boolean;
  fetchTree: () => Promise<void>;
  collapsedNodes: Set<string>;
  onToggleCollapse: (nodeId: string) => void;
  relationsOpenKeys?: Set<string>;
  onToggleRelations?: (issueKey: string) => void;
  relationsMap?: Map<string, IssueRelations>;
  onRelationChanged?: (issueKey: string) => void;
}

function SingleProjectTree({ tree, projectId, projectName, onLaunch, launchingIssues, launchErrors, forceExpand, fetchTree, collapsedNodes, onToggleCollapse, relationsOpenKeys, onToggleRelations, relationsMap, onRelationChanged }: SingleProjectTreeProps) {
  const api = useApi();
  const prioritization = usePrioritization();
  const selection = useIssueSelection();
  const [showRunAllDialog, setShowRunAllDialog] = useState(false);
  const [showRunSelectedDialog, setShowRunSelectedDialog] = useState(false);
  const [showDepGraph, setShowDepGraph] = useState(false);

  const displayTree = useMemo(() => {
    if (!prioritization.hasPriority) return tree;
    return sortTreeByPriority(tree, prioritization.priorityMap);
  }, [tree, prioritization.hasPriority, prioritization.priorityMap]);

  const launchableInfo = useMemo(() => collectLaunchableIssues(tree), [tree]);
  const selectedLaunchableInfo = useMemo(
    () => collectLaunchableFromSelection(tree, selection.selectedIssues),
    [tree, selection.selectedIssues],
  );

  const flatRows = useFlattenedTree(displayTree, collapsedNodes, forceExpand);

  return (
    <div className="flex flex-col h-full">
      {/* Prioritize controls */}
      <div className="flex items-center gap-2 px-2 pb-2 shrink-0">
        <button
          onClick={() => setShowDepGraph(true)}
          className="inline-flex items-center justify-center w-7 h-7 rounded border border-dark-border text-dark-muted hover:text-dark-accent hover:border-dark-accent/50 transition-colors"
          title="View dependency graph"
        >
          <DependencyGraphIcon size={14} />
        </button>

        <PrioritizeButtons
          prioritization={prioritization}
          tree={tree}
          onRunAll={projectId ? () => setShowRunAllDialog(true) : undefined}
          runAllDisabled={launchableInfo.launchable.length === 0 && launchableInfo.blocked.length === 0}
          onRunSelected={projectId ? () => setShowRunSelectedDialog(true) : undefined}
          runSelectedCount={selectedLaunchableInfo.launchable.length + selectedLaunchableInfo.blocked.length}
          runSelectedDisabled={selectedLaunchableInfo.launchable.length === 0 && selectedLaunchableInfo.blocked.length === 0}
          onSelectAll={() => selection.selectAll(tree)}
          onDeselectAll={selection.deselectAll}
          isAllSelected={selection.isAllSelected(tree)}
          showSelectionControls={!prioritization.hasPriority}
        />
      </div>

      {/* Prioritization error banner */}
      {prioritization.error && (
        <div className="mx-2 mb-2 px-3 py-2 rounded border border-[#F85149]/30 bg-[#F85149]/10 text-xs text-[#F85149] shrink-0">
          Prioritization failed: {prioritization.error}
        </div>
      )}

      {/* Prioritization loading banner */}
      {prioritization.loading && (
        <div className="mx-2 mb-2 px-3 py-2 rounded border border-[#A371F7]/30 bg-[#A371F7]/10 flex items-center gap-2 shrink-0">
          <svg className="w-4 h-4 text-[#A371F7] animate-spin shrink-0" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          <span className="text-xs text-[#A371F7]">Prioritizing issues... this may take a few minutes</span>
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

      <VirtualizedTreeList
        rows={flatRows}
        onLaunch={onLaunch}
        launchingIssues={launchingIssues}
        launchErrors={launchErrors}
        projectId={projectId ?? undefined}
        priorityMap={prioritization.hasPriority ? prioritization.priorityMap : undefined}
        checkedIssues={prioritization.hasPriority ? prioritization.checkedIssues : selection.selectedIssues}
        onCheckChange={prioritization.hasPriority ? prioritization.toggleCheck : selection.toggleCheck}
        onCheckWithChildren={prioritization.hasPriority ? undefined : selection.toggleWithChildren}
        onPrioritizeSubtree={prioritization.prioritizeSubtree}
        prioritizing={prioritization.loading}
        collapsedNodes={collapsedNodes}
        onToggleCollapse={onToggleCollapse}
        relationsOpenKeys={relationsOpenKeys}
        onToggleRelations={onToggleRelations}
        relationsMap={relationsMap}
        onRelationChanged={onRelationChanged}
        className="max-h-[70vh]"
      />

      {/* Run All confirmation dialog */}
      {showRunAllDialog && projectId && (
        <RunAllConfirmDialog
          issues={launchableInfo.launchable}
          skippedActive={launchableInfo.skippedActive}
          blockedIssues={launchableInfo.blocked}
          projectId={projectId}
          api={api}
          fetchTree={fetchTree}
          onClose={() => setShowRunAllDialog(false)}
        />
      )}

      {/* Run Selected confirmation dialog */}
      {showRunSelectedDialog && projectId && (
        <RunAllConfirmDialog
          issues={selectedLaunchableInfo.launchable}
          skippedActive={selectedLaunchableInfo.skippedActive}
          blockedIssues={selectedLaunchableInfo.blocked}
          projectId={projectId}
          api={api}
          fetchTree={fetchTree}
          onClose={() => {
            setShowRunSelectedDialog(false);
            selection.deselectAll();
          }}
        />
      )}

      {/* Dependency graph modal */}
      {showDepGraph && (
        <DependencyGraphModal
          issues={tree}
          projectName={projectName ?? 'Project'}
          onClose={() => setShowDepGraph(false)}
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

/** Filter tree nodes by search query, status filter, and provider filter, keeping parents of matching children */
function filterTree(nodes: IssueNode[], query: string, statusFilter: string, providerFilter: string = 'all'): IssueNode[] {
  const hasQuery = query.trim().length > 0;
  const hasStatusFilter = statusFilter !== 'all';
  const hasProviderFilter = providerFilter !== 'all';

  // No filters active — return as-is
  if (!hasQuery && !hasStatusFilter && !hasProviderFilter) return nodes;

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

    // Check if this node matches the provider filter
    const matchesProvider = !hasProviderFilter ||
      (node.issueProvider ?? 'github') === providerFilter;

    // A node directly matches if it passes ALL filters
    const directMatch = matchesSearch && matchesStatus && matchesProvider;

    // Recursively filter children
    const filteredChildren = filterTree(node.children, query, statusFilter, providerFilter);

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
  blocked: IssueNode[];
} {
  const launchable: IssueNode[] = [];
  let skippedActive = 0;
  const blocked: IssueNode[] = [];

  function walk(items: IssueNode[]) {
    for (const node of items) {
      if (node.state === 'open') {
        if (node.activeTeam) {
          skippedActive++;
        } else if (node.dependencies && !node.dependencies.resolved) {
          blocked.push(node);
        } else {
          launchable.push(node);
        }
      }
      walk(node.children);
    }
  }

  walk(nodes);
  return { launchable, skippedActive, blocked };
}

/** Collect launchable issues from a tree, filtered to only those in the selected set */
function collectLaunchableFromSelection(
  nodes: IssueNode[],
  selected: Set<number>,
): { launchable: IssueNode[]; skippedActive: number; blocked: IssueNode[] } {
  const all = collectLaunchableIssues(nodes);
  return {
    launchable: all.launchable.filter((n) => selected.has(n.number)),
    skippedActive: all.skippedActive, // We keep the full count for informational purposes
    blocked: all.blocked.filter((n) => selected.has(n.number)),
  };
}

/**
 * Collect IDs of parent nodes (nodes with children) at depth >= minDepth.
 * Used to pre-collapse deep branches on first load.
 */
function collectDeepParentNodeIds(nodes: IssueNode[], currentDepth: number, minDepth: number): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    if (node.children.length > 0) {
      if (currentDepth >= minDepth) {
        ids.push(node.number.toString());
      }
      ids.push(...collectDeepParentNodeIds(node.children, currentDepth + 1, minDepth));
    }
  }
  return ids;
}

/** Format a timestamp as HH:MM local time */
function formatRelativeTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' });
  } catch {
    return '--:--';
  }
}
