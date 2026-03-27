// =============================================================================
// Fleet Commander -- Issue Hierarchy Service (Provider-based)
// =============================================================================
// Orchestration and caching layer for issue hierarchy fetching. Delegates
// GitHub-specific GraphQL logic to GitHubIssueProvider. Retains caching,
// polling, tree-building, team enrichment, and priority/filtering logic.
//
// Per-project: issue cache is keyed by projectId. Each project fetches from
// its own configured issue provider. The polling loop iterates over all
// active projects.
// =============================================================================

import config from '../config.js';
import { getDatabase } from '../db.js';
import type { DependencyRef, IssueDependencyInfo } from '../../shared/types.js';
import type { GenericIssue, GenericDependencyRef } from '../../shared/issue-provider.js';
import { getIssueProvider, resetProviders } from '../providers/index.js';
import {
  type GraphQLIssueNode,
  GitHubIssueProvider,
  parseDependenciesFromBody as _parseDependenciesFromBody,
  runWithConcurrency,
  parseRepo,
} from '../providers/github-issue-provider.js';
import { JiraIssueProvider } from '../providers/jira-issue-provider.js';

// ---------------------------------------------------------------------------
// Re-exports for backward compatibility
// ---------------------------------------------------------------------------
// These functions moved to the provider but are re-exported here so existing
// consumers (tests, services) do not need to update their import paths.
// ---------------------------------------------------------------------------

export { parseDependenciesFromBody } from '../providers/github-issue-provider.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IssueNode {
  number: number;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  url: string;
  boardStatus?: string;
  subIssueSummary?: { total: number; completed: number; percentCompleted: number };
  prReferences?: { number: number; state: string }[];
  children: IssueNode[];
  activeTeam?: { id: number; status: string } | null;
  dependencies?: IssueDependencyInfo;
  /** Universal issue key (e.g. "42" for GitHub, "PROJ-123" for Jira) */
  issueKey?: string;
  /** Provider name (e.g. 'github', 'jira') */
  issueProvider?: string;
}

// ---------------------------------------------------------------------------
// Per-project cache entry
// ---------------------------------------------------------------------------

interface ProjectIssueCache {
  issues: IssueNode[];
  cachedAt: string | null;
}

// ---------------------------------------------------------------------------
// Helper: map a GraphQLIssueNode to our IssueNode format
// ---------------------------------------------------------------------------

/**
 * Map a GraphQL issue node to our IssueNode format.
 * Includes inline dependency info from the `blockedBy` field when present.
 */
function mapGraphQLNodeToIssueNode(node: GraphQLIssueNode): IssueNode {
  const labels = (node.labels?.nodes ?? []).map((l) => l.name);

  // Extract PR references
  const prRefs = (node.closedByPullRequestsReferences?.nodes ?? []).map((pr) => ({
    number: pr.number,
    state: pr.state,
  }));

  const issueNode: IssueNode = {
    number: node.number,
    title: node.title,
    state: node.state.toLowerCase() === 'open' ? 'open' : 'closed',
    labels,
    url: node.url,
    children: [],   // populated later by buildHierarchy in fetchIssueHierarchy
    activeTeam: null,
  };

  if (node.subIssuesSummary) {
    issueNode.subIssueSummary = {
      total: node.subIssuesSummary.total,
      completed: node.subIssuesSummary.completed,
      percentCompleted: node.subIssuesSummary.percentCompleted,
    };
  }

  if (prRefs.length > 0) {
    issueNode.prReferences = prRefs;
  }

  // Map inline blockedBy nodes to DependencyRef[] and populate dependencies.
  // Skip nodes where repository is null/undefined (can happen with cross-repo deps).
  const blockedByNodes = (node.blockedBy?.nodes ?? []).filter((dep) => dep.repository);
  if (blockedByNodes.length > 0) {
    const blockedBy: DependencyRef[] = blockedByNodes.map((dep) => ({
      number: dep.number,
      owner: dep.repository.owner.login,
      repo: dep.repository.name,
      state: dep.state.toLowerCase() === 'open' ? 'open' : 'closed',
      title: dep.title,
    }));
    const openCount = blockedBy.filter((d) => d.state === 'open').length;

    issueNode.dependencies = {
      issueNumber: node.number,
      blockedBy,
      resolved: openCount === 0,
      openCount,
    };
  }

  return issueNode;
}

/**
 * Map a GraphQLIssueNode (from fetchMissingParents) to an IssueNode.
 * Simpler version for parent nodes that lack sub-issue/PR/dependency data.
 */
function mapParentNodeToIssueNode(node: GraphQLIssueNode): IssueNode {
  return {
    number: node.number,
    title: node.title,
    state: node.state.toLowerCase() === 'open' ? 'open' : 'closed',
    labels: (node.labels?.nodes ?? []).map((l) => l.name),
    url: node.url,
    children: [],
    activeTeam: null,
  };
}

// ---------------------------------------------------------------------------
// Helper: map a GenericIssue (from any provider) to our IssueNode format
// ---------------------------------------------------------------------------

/**
 * Map a GenericIssue from a non-GitHub provider to our IssueNode format.
 * For Jira, issue.key is "PROJ-123" and is stored in issueKey.
 * The `number` field uses a hash of the key for compatibility with
 * numeric-only consumers (e.g. activeTeam enrichment).
 */
function mapGenericIssueToIssueNode(issue: GenericIssue): IssueNode {
  // For Jira/Linear, we need a numeric "number" for backward compat.
  // Extract trailing digits from the key (e.g. "PROJ-123" -> 123).
  const numMatch = issue.key.match(/(\d+)$/);
  const number = numMatch ? parseInt(numMatch[1], 10) : 0;

  return {
    number,
    title: issue.title,
    state: issue.status === 'closed' ? 'closed' : 'open',
    labels: issue.labels,
    url: issue.url ?? '',
    children: [],
    activeTeam: null,
    issueKey: issue.key,
    issueProvider: issue.provider,
  };
}

/**
 * Convert a GenericDependencyRef to a DependencyRef (for backward compat).
 * Jira deps use key-based identification; the DependencyRef structure
 * is GitHub-centric (owner/repo), so we set placeholder values.
 */
function genericDepToDepRef(dep: GenericDependencyRef): DependencyRef {
  const numMatch = dep.key.match(/(\d+)$/);
  const number = numMatch ? parseInt(numMatch[1], 10) : 0;

  return {
    number,
    owner: dep.projectKey ?? dep.provider,
    repo: dep.provider,
    state: dep.status === 'closed' ? 'closed' : 'open',
    title: dep.title,
  };
}

// ---------------------------------------------------------------------------
// Issue Fetcher class
// ---------------------------------------------------------------------------

export class IssueFetcher {
  // Per-project cache: projectId -> cache entry
  private cacheByProject: Map<number, ProjectIssueCache> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Full fetch from the configured issue provider for a specific project.
   * Paginates through all open issues. Returns the full hierarchy tree.
   */
  async fetchIssueHierarchy(projectId: number): Promise<IssueNode[]> {
    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) {
      console.error(`[IssueFetcher] Project ${projectId} not found`);
      return [];
    }

    // Get the provider and delegate based on type
    const provider = getIssueProvider(project);

    // Non-GitHub providers use the generic fetch path
    if (!(provider instanceof GitHubIssueProvider)) {
      return this.fetchIssueHierarchyGeneric(projectId, project, provider);
    }

    // GitHub path requires githubRepo
    if (!project.githubRepo) {
      console.error(`[IssueFetcher] Project ${projectId} has no githubRepo configured`);
      return [];
    }

    const [owner, repo] = parseRepo(project.githubRepo);

    const { nodes: allNodes, fetchComplete } = await provider.fetchRawIssueHierarchy(owner, repo);

    // Convert GraphQL nodes to our IssueNode format (flat, no children yet)
    const flatIssues = allNodes.map((node) => mapGraphQLNodeToIssueNode(node));

    // Build parent->children map from parent references
    const issueByNumber = new Map<number, IssueNode>();
    for (const issue of flatIssues) {
      issueByNumber.set(issue.number, issue);
    }

    // Track which issues have a parent (so we can identify roots)
    const childNumbers = new Set<number>();

    // Collect orphan parent numbers -- parent numbers referenced by open
    // children but not present in the fetched (OPEN-only) issue set.
    // These are typically closed parents whose open sub-issues would
    // otherwise be hidden from the tree (the bug this fixes).
    const orphanParentNumbers = new Set<number>();

    for (const node of allNodes) {
      if (node.parent?.number) {
        childNumbers.add(node.number);
        const parentIssue = issueByNumber.get(node.parent.number);
        const childIssue = issueByNumber.get(node.number);
        if (parentIssue && childIssue) {
          parentIssue.children.push(childIssue);
        } else if (!parentIssue && childIssue) {
          // Parent is missing from the OPEN-only query -- likely closed
          orphanParentNumbers.add(node.parent.number);
        }
      }
    }

    // Fetch missing (closed) parents so their open children stay visible
    // in the tree instead of being silently hidden.
    if (orphanParentNumbers.size > 0) {
      const fetchedParentNodes = await provider.fetchMissingParents(
        owner, repo, Array.from(orphanParentNumbers),
      );

      const fetchedParents = fetchedParentNodes.map((n) => mapParentNodeToIssueNode(n));

      for (const parent of fetchedParents) {
        issueByNumber.set(parent.number, parent);
        flatIssues.push(parent);
      }

      // Re-link orphaned children to their now-present parents.
      for (const node of allNodes) {
        if (node.parent?.number && orphanParentNumbers.has(node.parent.number)) {
          const parentIssue = issueByNumber.get(node.parent.number);
          const childIssue = issueByNumber.get(node.number);
          if (parentIssue && childIssue) {
            // Avoid duplicate children (the child was not linked before)
            if (!parentIssue.children.includes(childIssue)) {
              parentIssue.children.push(childIssue);
            }
          }
        }
      }

      // For any orphan parent number that was NOT successfully fetched,
      // promote those children to root level so they are always visible.
      const fetchedParentNumbers = new Set(fetchedParents.map((p) => p.number));
      for (const orphanParentNum of orphanParentNumbers) {
        if (!fetchedParentNumbers.has(orphanParentNum)) {
          // Promote children of this missing parent to root
          for (const node of allNodes) {
            if (node.parent?.number === orphanParentNum) {
              childNumbers.delete(node.number);
            }
          }
        }
      }
    }

    // Root issues are those with no parent
    const rootIssues = flatIssues.filter((issue) => !childNumbers.has(issue.number));

    // -----------------------------------------------------------------------
    // Post-pass: enrich all issues with body-based dependency data
    // -----------------------------------------------------------------------
    // Parse "blocked by #X" / "depends on #X" / "requires #X" / "after #X"
    // patterns from each issue body and merge with any inline blockedBy deps
    // already populated by mapGraphQLNodeToIssueNode from GitHub's native tracking.
    // Body text is stored in a transient map and discarded after enrichment.
    // -----------------------------------------------------------------------
    const bodyByNumber = new Map<number, string>();
    for (const node of allNodes) {
      if (node.body) {
        bodyByNumber.set(node.number, node.body);
      }
    }

    // Build a set of open issue numbers for resolving blocker state locally
    const openIssueNumbers = new Set<number>();
    for (const issue of flatIssues) {
      if (issue.state === 'open') {
        openIssueNumbers.add(issue.number);
      }
    }

    // Build a map of issue number -> title for populating blocker titles
    const titleByNumber = new Map<number, string>();
    for (const issue of flatIssues) {
      titleByNumber.set(issue.number, issue.title);
    }

    for (const issue of flatIssues) {
      const body = bodyByNumber.get(issue.number);
      if (!body) continue;

      const bodyDeps = _parseDependenciesFromBody(body, owner, repo);
      if (bodyDeps.length === 0) continue;

      // Resolve state and title for same-repo body deps from our local data
      for (const dep of bodyDeps) {
        if (dep.owner === owner && dep.repo === repo) {
          // We know the state from our fetched issue set
          if (openIssueNumbers.has(dep.number)) {
            dep.state = 'open';
          } else {
            // Not in open issues -- either closed or external; assume closed
            dep.state = 'closed';
          }
          // Populate title from the tree if available
          const title = titleByNumber.get(dep.number);
          if (title) {
            dep.title = title;
          }
        }
        // Cross-repo deps keep their default state ('open') -- conservative
      }

      if (issue.dependencies) {
        // Merge: add body deps that are not already present from inline
        for (const dep of bodyDeps) {
          const exists = issue.dependencies.blockedBy.some(
            (b) => b.number === dep.number && b.owner === dep.owner && b.repo === dep.repo
          );
          if (!exists) {
            issue.dependencies.blockedBy.push(dep);
          }
        }
        // Recalculate openCount and resolved
        issue.dependencies.openCount = issue.dependencies.blockedBy.filter(
          (d) => d.state === 'open'
        ).length;
        issue.dependencies.resolved = issue.dependencies.openCount === 0;
      } else {
        // No inline deps -- create new dependency info from body deps only
        const openCount = bodyDeps.filter((d) => d.state === 'open').length;
        issue.dependencies = {
          issueNumber: issue.number,
          blockedBy: bodyDeps,
          resolved: openCount === 0,
          openCount,
        };
      }
    }

    // Update the per-project cache
    if (fetchComplete) {
      this.cacheByProject.set(projectId, {
        issues: rootIssues,
        cachedAt: new Date().toISOString(),
      });
    } else if (!this.cacheByProject.has(projectId)) {
      // Partial failure on first fetch: store with null cachedAt so
      // getIssues() will trigger a background refetch next time.
      this.cacheByProject.set(projectId, {
        issues: rootIssues,
        cachedAt: null,
      });
    }
    // else: partial failure with existing cache -- keep previous good data

    return rootIssues;
  }

  /**
   * Fetch issue hierarchies for all active projects.
   * Uses runWithConcurrency to parallelize fetches (limit 3) instead of
   * serial iteration, significantly reducing total wall-clock time.
   */
  async fetchAllProjects(): Promise<void> {
    // Recovery mechanism: tick the GitHub provider's retry countdown so it
    // re-enables blockedBy support after a few poll cycles (circuit-breaker pattern).
    // Only applies to GitHub providers; Jira/Linear do not have this mechanism.
    try {
      const ghProvider = getIssueProvider({ issueProvider: 'github' } as Parameters<typeof getIssueProvider>[0]);
      if (ghProvider instanceof GitHubIssueProvider) {
        ghProvider.tickRetryCountdown();
      }
    } catch {
      // No GitHub provider configured -- that's fine, Jira-only setups skip this
    }

    const db = getDatabase();
    const projects = db.getProjects({ status: 'active' });

    const tasks = projects.map((project) => async () => {
      try {
        await this.fetchIssueHierarchy(project.id);
      } catch (err) {
        console.error(
          `[IssueFetcher] Failed to fetch issues for project ${project.id} (${project.name}):`,
          err instanceof Error ? err.message : err
        );
      }
    });

    await runWithConcurrency(tasks, 3);
  }

  /**
   * Generic fetch path for non-GitHub providers (Jira, Linear, etc.).
   * Calls the standard IssueProvider interface methods (queryIssues,
   * getDependencies) and maps GenericIssue[] to IssueNode[], then
   * builds the parent-child hierarchy tree.
   */
  private async fetchIssueHierarchyGeneric(
    projectId: number,
    project: { id: number; name: string; issueProvider: string | null },
    provider: import('../../shared/issue-provider.js').IssueProvider,
  ): Promise<IssueNode[]> {
    let fetchComplete = true;

    // Fetch all open issues via the provider's queryIssues (paginated)
    let allGenericIssues: GenericIssue[] = [];

    // If the provider is a JiraIssueProvider, use the dedicated fetchAllOpenIssues
    if (provider instanceof JiraIssueProvider) {
      try {
        allGenericIssues = await provider.fetchAllOpenIssues();
      } catch (err) {
        console.error(
          `[IssueFetcher] Generic fetch failed for project ${projectId}:`,
          err instanceof Error ? err.message : err,
        );
        fetchComplete = false;
      }
    } else {
      // Fallback: page through queryIssues for any other provider
      let cursor: string | undefined;
      let hasMore = true;
      try {
        while (hasMore && allGenericIssues.length < 1000) {
          const result = await provider.queryIssues({ cursor, limit: 100 });
          allGenericIssues.push(...result.issues);
          cursor = result.cursor ?? undefined;
          hasMore = result.hasMore;
        }
      } catch (err) {
        console.error(
          `[IssueFetcher] Generic fetch failed for project ${projectId}:`,
          err instanceof Error ? err.message : err,
        );
        fetchComplete = false;
      }
    }

    // Convert GenericIssue to IssueNode (flat, no children yet)
    const flatIssues = allGenericIssues.map((gi) => mapGenericIssueToIssueNode(gi));

    // Build parent-child hierarchy from parentKey references
    const issueByKey = new Map<string, IssueNode>();
    for (const issue of flatIssues) {
      issueByKey.set(issue.issueKey ?? String(issue.number), issue);
    }

    const childKeys = new Set<string>();
    for (const gi of allGenericIssues) {
      if (gi.parentKey) {
        const childKey = gi.key;
        const parentNode = issueByKey.get(gi.parentKey);
        const childNode = issueByKey.get(childKey);
        if (parentNode && childNode) {
          parentNode.children.push(childNode);
          childKeys.add(childKey);
        }
      }
    }

    // Root issues are those with no parent (or parent not in fetched set)
    const rootIssues = flatIssues.filter(
      (issue) => !childKeys.has(issue.issueKey ?? String(issue.number)),
    );

    // Fetch dependencies for each issue
    if (provider.capabilities.dependencies) {
      const depTasks = flatIssues.map((issue) => async () => {
        const key = issue.issueKey ?? String(issue.number);
        try {
          const deps = await provider.getDependencies(key);
          if (deps.length > 0) {
            const openCount = deps.filter((d) => d.status === 'open').length;
            issue.dependencies = {
              issueNumber: issue.number,
              issueKey: key,
              blockedBy: deps.map((d) => genericDepToDepRef(d)),
              resolved: openCount === 0,
              openCount,
            };
          }
        } catch {
          // Non-fatal: skip dependency info for this issue
        }
      });

      await runWithConcurrency(depTasks, 5);
    }

    // Update the per-project cache
    if (fetchComplete) {
      this.cacheByProject.set(projectId, {
        issues: rootIssues,
        cachedAt: new Date().toISOString(),
      });
    } else if (!this.cacheByProject.has(projectId)) {
      this.cacheByProject.set(projectId, {
        issues: rootIssues,
        cachedAt: null,
      });
    }

    return rootIssues;
  }

  /**
   * Returns cached issues for a project. If cache is missing or was only
   * partially populated (cachedAt is null), kicks off a background fetch
   * and returns an empty array immediately (non-blocking).
   * The polling loop or initial fetchAllProjects() will populate the cache.
   * For synchronous access, use getIssuesCached() instead.
   */
  async getIssues(projectId?: number): Promise<IssueNode[]> {
    if (projectId !== undefined) {
      const cached = this.cacheByProject.get(projectId);
      if (!cached || !cached.cachedAt) {
        // Fire-and-forget background fetch; return empty immediately
        console.info(`[IssueFetcher] Cache miss for project ${projectId}, triggering background fetch`);
        this.fetchIssueHierarchy(projectId).catch((err) => {
          console.error(
            `[IssueFetcher] Background fetch for project ${projectId} failed:`,
            err instanceof Error ? err.message : err,
          );
        });
        return [];
      }
      return cached.issues;
    }

    // Legacy: return all cached issues across all projects
    const allIssues: IssueNode[] = [];
    for (const cache of this.cacheByProject.values()) {
      allIssues.push(...cache.issues);
    }
    return allIssues;
  }

  /**
   * Returns cached issues synchronously (no fetch on miss).
   * Returns whatever is in the cache -- may be empty if not yet populated.
   * Used by callers that cannot await (e.g. getAvailableIssues, getNextIssue).
   */
  getIssuesCached(projectId?: number): IssueNode[] {
    if (projectId !== undefined) {
      const cached = this.cacheByProject.get(projectId);
      return cached?.issues ?? [];
    }

    const allIssues: IssueNode[] = [];
    for (const cache of this.cacheByProject.values()) {
      allIssues.push(...cache.issues);
    }
    return allIssues;
  }

  /**
   * Returns issues grouped by project, preserving the project association.
   * Each entry contains the projectId plus its cached issue tree.
   * Used by the "All Projects" view to render collapsible project sections.
   */
  getIssuesByProject(): Array<{ projectId: number; tree: IssueNode[]; cachedAt: string | null }> {
    const result: Array<{ projectId: number; tree: IssueNode[]; cachedAt: string | null }> = [];
    for (const [projectId, cache] of this.cacheByProject.entries()) {
      result.push({
        projectId,
        tree: cache.issues,
        cachedAt: cache.cachedAt,
      });
    }
    return result;
  }

  /**
   * Get a single issue by number from the cache (searches recursively).
   * Searches across all project caches if projectId is not specified.
   */
  getIssue(number: number, projectId?: number): IssueNode | undefined {
    if (projectId !== undefined) {
      const cached = this.cacheByProject.get(projectId);
      if (!cached) return undefined;
      return this.findInTree(cached.issues, number);
    }

    // Search all project caches
    for (const cache of this.cacheByProject.values()) {
      const found = this.findInTree(cache.issues, number);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * Suggest the next issue to work on for a specific project.
   * Criteria: Ready status, no active team, not in activeTeamIssues list.
   * Returns the highest priority issue (P0 > P1 > P2 > unlabeled).
   */
  getNextIssue(activeTeamIssues: number[], projectId?: number): IssueNode | null {
    const available = this.getAvailableIssues(activeTeamIssues, projectId);

    if (available.length === 0) return null;

    // Sort by priority labels (P0 first, then P1, P2, then unlabeled)
    available.sort((a, b) => {
      const priorityA = this.getPriorityScore(a);
      const priorityB = this.getPriorityScore(b);
      return priorityA - priorityB;
    });

    return available[0] ?? null;
  }

  /**
   * Get all issues that have no active team assigned.
   * Filters by Ready board status and excludes issues in activeTeamIssues.
   * Uses cached issues synchronously -- does not trigger a fetch.
   */
  getAvailableIssues(activeTeamIssues: number[], projectId?: number): IssueNode[] {
    const activeSet = new Set(activeTeamIssues);
    const issues = this.getIssuesCached(projectId);
    const allIssues = this.flattenTree(issues);

    return allIssues.filter((issue) => {
      // Must be open
      if (issue.state !== 'open') return false;

      // Must not already have an active team
      if (activeSet.has(issue.number)) return false;

      // Prefer "Ready" board status, but include issues without board status
      // (they might not be on the project board yet)
      if (issue.boardStatus && issue.boardStatus !== 'Ready') return false;

      // Exclude issues that have sub-issues (they are parent/epic-level)
      if (issue.children.length > 0) return false;

      // Exclude issues with unresolved dependencies (permissive: issues
      // without dependency data are NOT excluded)
      if (issue.dependencies?.resolved === false) return false;

      return true;
    });
  }

  /**
   * Clear cached issues for a specific project.
   * Called when a project is deleted to prevent stale data.
   */
  clearProject(projectId: number): void {
    this.cacheByProject.delete(projectId);
  }

  /**
   * Clear ALL cached issues (used by factory reset).
   */
  clearAll(): void {
    this.cacheByProject.clear();
  }

  /**
   * Full reset: stop the polling timer, clear all cached data, and reset providers.
   * Used by factory reset -- does NOT restart since there are no projects.
   */
  reset(): void {
    this.stop();
    this.clearAll();
    resetProviders();
  }

  /**
   * Force a re-fetch from the issue provider for a specific project.
   */
  async refresh(projectId?: number): Promise<IssueNode[]> {
    if (projectId !== undefined) {
      return this.fetchIssueHierarchy(projectId);
    }

    // Refresh all projects
    await this.fetchAllProjects();
    return this.getIssuesCached();
  }

  /**
   * Get the time the cache was last refreshed for a project.
   */
  getCachedAt(projectId?: number): string | null {
    if (projectId !== undefined) {
      return this.cacheByProject.get(projectId)?.cachedAt ?? null;
    }

    // Return the most recent cachedAt across all projects
    let latest: string | null = null;
    for (const cache of this.cacheByProject.values()) {
      if (cache.cachedAt && (!latest || cache.cachedAt > latest)) {
        latest = cache.cachedAt;
      }
    }
    return latest;
  }

  /**
   * Start the auto-refresh polling timer.
   * Fetches issues for all active projects on each cycle.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Initial fetch for all active projects (async, fire-and-forget)
    this.fetchAllProjects().catch((err) => {
      console.error('[IssueFetcher] Initial fetch failed:', err instanceof Error ? err.message : err);
    });

    // Set up polling -- fetches for all active projects each cycle
    this.pollTimer = setInterval(() => {
      this.fetchAllProjects().catch((err) => {
        console.error('[IssueFetcher] Polling fetch failed:', err instanceof Error ? err.message : err);
      });
    }, config.issuePollIntervalMs);
    if (this.pollTimer.unref) this.pollTimer.unref();
  }

  /**
   * Stop the auto-refresh polling timer.
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isRunning = false;
  }

  /**
   * Enrich issue nodes with active team info from the database.
   * Returns a NEW tree of shallow-copied nodes -- the original cached tree
   * is not mutated, eliminating the need for structuredClone at call sites.
   * When projectId is specified, only teams for that project are matched.
   */
  enrichWithTeamInfo(issues: IssueNode[], projectId?: number): IssueNode[] {
    try {
      const db = getDatabase();
      const activeTeams = projectId !== undefined
        ? db.getActiveTeamsByProject(projectId)
        : db.getActiveTeams();

      // Build a map of issue number -> active team
      const teamByIssue = new Map<number, { id: number; status: string }>();
      for (const team of activeTeams) {
        teamByIssue.set(team.issueNumber, {
          id: team.id,
          status: team.status,
        });
      }

      // Recursively create shallow copies with team info set
      const enrichNode = (node: IssueNode): IssueNode => {
        const team = teamByIssue.get(node.number);
        return {
          ...node,
          labels: [...node.labels],
          activeTeam: team ?? null,
          children: node.children.map((child) => enrichNode(child)),
        };
      };

      return issues.map((issue) => enrichNode(issue));
    } catch (err) {
      console.error('[IssueFetcher] Failed to enrich with team info:', err instanceof Error ? err.message : err);
      // On error, return shallow copies without enrichment to avoid mutating cache
      return issues.map((node) => ({ ...node, labels: [...node.labels], children: [...node.children] }));
    }
  }

  // -------------------------------------------------------------------------
  // Single-issue dependency fetching (used by launch check, github-poller,
  // and per-issue dependency endpoints)
  // -------------------------------------------------------------------------

  /**
   * Fetch dependency information for a specific issue using the configured
   * issue provider. Falls back gracefully if the API is unavailable.
   *
   * Returns null if the API call fails (e.g. gh CLI too old).
   */
  async fetchDependencies(owner: string, repo: string, issueNumber: number): Promise<IssueDependencyInfo | null> {
    return this.fetchDependenciesFromProvider(owner, repo, issueNumber);
  }

  /**
   * Fetch dependencies for a specific project + issue number (or issue key).
   * For GitHub: resolves owner/repo and delegates to fetchDependenciesFromProvider.
   * For non-GitHub providers: calls the provider's getDependencies directly.
   */
  async fetchDependenciesForIssue(projectId: number, issueNumber: number, issueKey?: string): Promise<IssueDependencyInfo | null> {
    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) return null;

    const provider = getIssueProvider(project);

    // Non-GitHub providers: use the generic getDependencies interface
    if (!(provider instanceof GitHubIssueProvider)) {
      const key = issueKey ?? String(issueNumber);
      try {
        const deps = await provider.getDependencies(key);
        if (deps.length === 0) {
          return { issueNumber, issueKey: key, blockedBy: [], resolved: true, openCount: 0 };
        }
        const openCount = deps.filter((d) => d.status === 'open').length;
        return {
          issueNumber,
          issueKey: key,
          blockedBy: deps.map((d) => genericDepToDepRef(d)),
          resolved: openCount === 0,
          openCount,
        };
      } catch {
        return null;
      }
    }

    // GitHub path requires githubRepo
    if (!project.githubRepo) return null;

    const [owner, repo] = parseRepo(project.githubRepo);
    return this.fetchDependencies(owner, repo, issueNumber);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Fetch dependencies from the issue provider (body + trackedInIssues + blockedBy).
   * Used for single-issue dependency fetching (e.g. launch-time check).
   *
   * Delegates GraphQL execution to the GitHubIssueProvider.
   */
  private async fetchDependenciesFromProvider(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<IssueDependencyInfo | null> {
    try {
      // Look up the project to get the provider
      const db = getDatabase();
      const projects = db.getProjects({ status: 'active' });
      const project = projects.find((p) => p.githubRepo === `${owner}/${repo}`);
      if (!project) {
        console.error(`[IssueFetcher] No project found for ${owner}/${repo}`);
        return this.buildEmptyDependencyInfo(issueNumber);
      }

      const provider = getIssueProvider(project);
      if (!(provider instanceof GitHubIssueProvider)) {
        console.error(`[IssueFetcher] Provider for ${owner}/${repo} is not a GitHubIssueProvider`);
        return this.buildEmptyDependencyInfo(issueNumber);
      }

      const issue = await provider.fetchSingleIssueDeps(owner, repo, issueNumber);
      if (!issue) {
        return this.buildEmptyDependencyInfo(issueNumber);
      }

      const blockedBy: DependencyRef[] = [];

      // 1. Process blockedBy nodes FIRST (GitHub's native issue dependencies).
      //    Skip nodes where repository is null/undefined (cross-repo edge case).
      const blockedByNodes = (issue.blockedBy?.nodes ?? []).filter((n) => n.repository);
      for (const node of blockedByNodes) {
        blockedBy.push({
          number: node.number,
          owner: node.repository.owner.login,
          repo: node.repository.name,
          state: node.state.toLowerCase() === 'open' ? 'open' : 'closed',
          title: node.title,
        });
      }

      // 2. Process trackedInIssues, deduplicating against blockedBy.
      //    Skip nodes where repository is null/undefined.
      const trackedNodes = (issue.trackedInIssues?.nodes ?? []).filter((n) => n.repository);
      for (const node of trackedNodes) {
        const exists = blockedBy.some(
          (b) => b.number === node.number &&
                 b.owner === node.repository.owner.login &&
                 b.repo === node.repository.name
        );
        if (!exists) {
          blockedBy.push({
            number: node.number,
            owner: node.repository.owner.login,
            repo: node.repository.name,
            state: node.state.toLowerCase() === 'open' ? 'open' : 'closed',
            title: node.title,
          });
        }
      }

      // 3. Parse body for "blocked by" or "depends on" patterns, deduplicating
      if (issue.body) {
        const bodyDeps = _parseDependenciesFromBody(issue.body, owner, repo);
        // Resolve the actual state for body-parsed deps (they default to 'open')
        const resolvedBodyDeps = await provider.resolveIssueStates(bodyDeps);
        for (const dep of resolvedBodyDeps) {
          const exists = blockedBy.some(
            (b) => b.number === dep.number && b.owner === dep.owner && b.repo === dep.repo
          );
          if (!exists) {
            blockedBy.push(dep);
          }
        }
      }

      const openCount = blockedBy.filter((d) => d.state === 'open').length;

      return {
        issueNumber,
        blockedBy,
        resolved: openCount === 0,
        openCount,
      };
    } catch (err) {
      console.error(
        `[IssueFetcher] Failed to fetch dependencies for ${owner}/${repo}#${issueNumber}:`,
        err instanceof Error ? err.message : err
      );
      return null;
    }
  }

  /**
   * Build an empty dependency info object (no blockers).
   */
  private buildEmptyDependencyInfo(issueNumber: number): IssueDependencyInfo {
    return {
      issueNumber,
      blockedBy: [],
      resolved: true,
      openCount: 0,
    };
  }

  /**
   * Recursively search for an issue by number in the tree.
   */
  private findInTree(nodes: IssueNode[], number: number): IssueNode | undefined {
    for (const node of nodes) {
      if (node.number === number) return node;
      const found = this.findInTree(node.children, number);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * Flatten the tree into a single array of all issues.
   */
  private flattenTree(nodes: IssueNode[]): IssueNode[] {
    const result: IssueNode[] = [];
    const walk = (list: IssueNode[]): void => {
      for (const node of list) {
        result.push(node);
        walk(node.children);
      }
    };
    walk(nodes);
    return result;
  }

  /**
   * Get a numeric priority score from labels. Lower = higher priority.
   * P0 = 0, P1 = 1, P2 = 2, no priority label = 99.
   */
  private getPriorityScore(issue: IssueNode): number {
    for (const label of issue.labels) {
      const lower = label.toLowerCase();
      if (lower === 'p0' || lower === 'priority:p0' || lower === 'priority: p0') return 0;
      if (lower === 'p1' || lower === 'priority:p1' || lower === 'priority: p1') return 1;
      if (lower === 'p2' || lower === 'priority:p2' || lower === 'priority: p2') return 2;
      if (lower === 'p3' || lower === 'priority:p3' || lower === 'priority: p3') return 3;
    }
    return 99;
  }
}

// ---------------------------------------------------------------------------
// Circular dependency detection
// ---------------------------------------------------------------------------

/**
 * Detect circular dependencies in a dependency graph using DFS cycle detection.
 *
 * @param issueNumber - The starting issue number to check
 * @param deps - Map of issue number -> array of blocking issue numbers
 * @returns The cycle path (array of issue numbers) if a cycle is found, null otherwise
 *
 * Example: if issue 1 depends on 2, 2 depends on 3, and 3 depends on 1,
 * calling detectCircularDependencies(1, {1->[2], 2->[3], 3->[1]}) returns [1, 2, 3, 1].
 */
export function detectCircularDependencies(
  issueNumber: number,
  deps: Map<number, number[]>,
): number[] | null {
  const visited = new Set<number>();
  const path: number[] = [];
  const inPath = new Set<number>();

  function dfs(node: number): number[] | null {
    if (inPath.has(node)) {
      // Found a cycle -- extract the cycle from path
      const cycleStart = path.indexOf(node);
      return [...path.slice(cycleStart), node];
    }
    if (visited.has(node)) {
      return null; // Already fully explored, no cycle through this node
    }

    visited.add(node);
    inPath.add(node);
    path.push(node);

    const neighbors = deps.get(node) ?? [];
    for (const neighbor of neighbors) {
      const cycle = dfs(neighbor);
      if (cycle) return cycle;
    }

    inPath.delete(node);
    path.pop();
    return null;
  }

  return dfs(issueNumber);
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: IssueFetcher | null = null;

/**
 * Get or create the singleton IssueFetcher instance.
 */
export function getIssueFetcher(): IssueFetcher {
  if (!_instance) {
    _instance = new IssueFetcher();
  }
  return _instance;
}

export default IssueFetcher;
