// =============================================================================
// Fleet Commander -- Issue Hierarchy Service (GraphQL + REST via gh CLI)
// =============================================================================
// Fetches issue hierarchy from GitHub using `gh api graphql` via child_process.
// Caches results in memory with periodic auto-refresh.
// Enriches issues with active team info from the database.
//
// Per-project: issue cache is keyed by projectId. Each project fetches from
// its own github_repo. The polling loop iterates over all active projects.
//
// All GitHub API calls (gh CLI) are async to avoid blocking the event loop.
// Dependencies are fetched inline via the blockedBy field in the main issue query.
// =============================================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import config from '../config.js';
import { getDatabase } from '../db.js';
import type { DependencyRef, IssueDependencyInfo } from '../../shared/types.js';

/** Promisified exec for async child_process calls */
const execAsync = promisify(exec);

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
}

interface GraphQLIssueNode {
  number: number;
  title: string;
  state: string;
  url: string;
  labels?: { nodes?: Array<{ name: string }> };
  parent?: { number: number; title: string } | null;
  subIssuesSummary?: { total: number; completed: number; percentCompleted: number };
  closedByPullRequestsReferences?: {
    nodes?: Array<{ number: number; state: string }>;
  };
  blockedBy?: {
    nodes?: Array<{
      number: number;
      title: string;
      state: string;
      repository: { owner: { login: string }; name: string };
    }>;
  };
  issueDependenciesSummary?: { totalBlockedBy: number; totalBlocking: number };
}

interface GraphQLResponse {
  data?: {
    repository?: {
      issues?: {
        pageInfo?: { hasNextPage: boolean; endCursor: string | null };
        nodes?: GraphQLIssueNode[];
      };
    };
  };
  errors?: Array<{ message: string }>;
}

// ---------------------------------------------------------------------------
// Per-project cache entry
// ---------------------------------------------------------------------------

interface ProjectIssueCache {
  issues: IssueNode[];
  cachedAt: string | null;
}

/** Maximum concurrent `gh api` calls for resolving issue states */
const MAX_CONCURRENT_RESOLVE = 5;

// ---------------------------------------------------------------------------
// GraphQL queries -- flat list of all open issues with parent reference
// ---------------------------------------------------------------------------
// Fetches ~100 issues per page with ~10 sub-fields each = ~1,000 nodes/page.
// The tree is built client-side from parent references instead of nested
// subIssues, avoiding GitHub's 500,000 node limit.
//
// Two variants: FULL includes blockedBy/issueDependenciesSummary fields
// (GitHub Sub-issues / Issue Dependencies API). BASIC omits them for
// environments where those fields are not available in the GraphQL schema.
// ---------------------------------------------------------------------------

const ISSUES_QUERY_FULL = `
query GetIssues($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    issues(first: 100, after: $cursor, states: [OPEN]) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        state
        url
        labels(first: 5) { nodes { name } }
        parent { number title }
        subIssuesSummary { total completed percentCompleted }
        closedByPullRequestsReferences(first: 3, includeClosedPrs: true) {
          nodes { number state }
        }
        blockedBy(first: 20) {
          nodes { number title state repository { owner { login } name } }
        }
        issueDependenciesSummary { totalBlockedBy totalBlocking }
      }
    }
  }
}
`;

const ISSUES_QUERY_BASIC = `
query GetIssues($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    issues(first: 100, after: $cursor, states: [OPEN]) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        state
        url
        labels(first: 5) { nodes { name } }
        parent { number title }
        subIssuesSummary { total completed percentCompleted }
        closedByPullRequestsReferences(first: 3, includeClosedPrs: true) {
          nodes { number state }
        }
      }
    }
  }
}
`;

// ---------------------------------------------------------------------------
// Exported utility: parse dependency patterns from issue body text
// ---------------------------------------------------------------------------

/**
 * Parse issue body text for dependency patterns like:
 *   - "Blocked by #123"
 *   - "Depends on owner/repo#456"
 *   - "blocked by https://github.com/owner/repo/issues/789"
 *   - "requires #42"
 *
 * Returns DependencyRef[] with state defaulting to 'open'.
 * Callers should resolve actual state via GitHub API afterward.
 */
export function parseDependenciesFromBody(body: string, defaultOwner: string, defaultRepo: string): DependencyRef[] {
  const deps: DependencyRef[] = [];
  // Match "blocked by", "depends on", "requires" followed by issue references
  const patterns = [
    // "blocked by #123" or "depends on #456"
    /(?:blocked\s+by|depends\s+on|requires)\s+#(\d+)/gi,
    // "blocked by owner/repo#123"
    /(?:blocked\s+by|depends\s+on|requires)\s+([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)#(\d+)/gi,
    // "blocked by https://github.com/owner/repo/issues/123"
    /(?:blocked\s+by|depends\s+on|requires)\s+https?:\/\/github\.com\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)\/issues\/(\d+)/gi,
  ];

  // Simple #N references
  for (const match of body.matchAll(patterns[0])) {
    const num = parseInt(match[1], 10);
    if (!isNaN(num) && num > 0) {
      deps.push({
        number: num,
        owner: defaultOwner,
        repo: defaultRepo,
        state: 'open',
        title: '',
      });
    }
  }

  // owner/repo#N references
  for (const match of body.matchAll(patterns[1])) {
    const num = parseInt(match[3], 10);
    if (!isNaN(num) && num > 0) {
      deps.push({
        number: num,
        owner: match[1],
        repo: match[2],
        state: 'open',
        title: '',
      });
    }
  }

  // Full URL references
  for (const match of body.matchAll(patterns[2])) {
    const num = parseInt(match[3], 10);
    if (!isNaN(num) && num > 0) {
      deps.push({
        number: num,
        owner: match[1],
        repo: match[2],
        state: 'open',
        title: '',
      });
    }
  }

  return deps;
}

// ---------------------------------------------------------------------------
// Concurrency limiter (simple semaphore -- no external deps)
// ---------------------------------------------------------------------------

/**
 * Run an array of async tasks with a concurrency cap.
 * Returns results in the same order as the input tasks.
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++;
      results[idx] = await tasks[idx]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Issue Fetcher class
// ---------------------------------------------------------------------------

export class IssueFetcher {
  // Per-project cache: projectId -> cache entry
  private cacheByProject: Map<number, ProjectIssueCache> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  // Whether the GitHub GraphQL schema supports blockedBy/issueDependenciesSummary.
  // Starts true; set to false on first query failure caused by unsupported fields,
  // after which all subsequent queries use the basic query without those fields.
  private blockedBySupported = true;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Full fetch from GitHub for a specific project.
   * Paginates through all open issues. Returns the full hierarchy tree.
   */
  async fetchIssueHierarchy(projectId: number): Promise<IssueNode[]> {
    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) {
      console.error(`[IssueFetcher] Project ${projectId} not found`);
      return [];
    }

    if (!project.githubRepo) {
      console.error(`[IssueFetcher] Project ${projectId} has no githubRepo configured`);
      return [];
    }

    const [owner, repo] = this.parseRepo(project.githubRepo);
    let allNodes: GraphQLIssueNode[] = [];
    let cursor: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const result = await this.executeGraphQL(owner, repo, cursor);
      if (!result) {
        // gh CLI error -- return whatever we have so far (or empty)
        break;
      }

      const issues = result.data?.repository?.issues;
      if (!issues?.nodes) break;

      allNodes = allNodes.concat(issues.nodes);
      hasNextPage = issues.pageInfo?.hasNextPage ?? false;
      cursor = issues.pageInfo?.endCursor ?? null;
    }

    // Convert GraphQL nodes to our IssueNode format (flat, no children yet)
    const flatIssues = allNodes.map((node) => this.mapGraphQLNode(node));

    // Build parent->children map from parent references
    const issueByNumber = new Map<number, IssueNode>();
    for (const issue of flatIssues) {
      issueByNumber.set(issue.number, issue);
    }

    // Track which issues have a parent (so we can identify roots)
    const childNumbers = new Set<number>();

    for (const node of allNodes) {
      if (node.parent?.number) {
        childNumbers.add(node.number);
        const parentIssue = issueByNumber.get(node.parent.number);
        const childIssue = issueByNumber.get(node.number);
        if (parentIssue && childIssue) {
          parentIssue.children.push(childIssue);
        }
      }
    }

    // Root issues are those with no parent
    const rootIssues = flatIssues.filter((issue) => !childNumbers.has(issue.number));

    // Update the per-project cache
    this.cacheByProject.set(projectId, {
      issues: rootIssues,
      cachedAt: new Date().toISOString(),
    });

    return rootIssues;
  }

  /**
   * Fetch issue hierarchies for all active projects.
   */
  async fetchAllProjects(): Promise<void> {
    const db = getDatabase();
    const projects = db.getProjects({ status: 'active' });

    for (const project of projects) {
      try {
        await this.fetchIssueHierarchy(project.id);
      } catch (err) {
        console.error(
          `[IssueFetcher] Failed to fetch issues for project ${project.id} (${project.name}):`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  /**
   * Returns cached issues for a project. If cache is empty, triggers an async
   * fetch in the background and returns empty until cache is populated.
   * For synchronous access, use getIssuesCached() instead.
   */
  async getIssues(projectId?: number): Promise<IssueNode[]> {
    if (projectId !== undefined) {
      const cached = this.cacheByProject.get(projectId);
      if (!cached || (cached.issues.length === 0 && !cached.cachedAt)) {
        return this.fetchIssueHierarchy(projectId);
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
   * Full reset: stop the polling timer and clear all cached data.
   * Used by factory reset -- does NOT restart since there are no projects.
   * Also resets the blockedBySupported flag so the full query is re-tested.
   */
  reset(): void {
    this.stop();
    this.clearAll();
    this.blockedBySupported = true;
  }

  /**
   * Force a re-fetch from GitHub for a specific project.
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
   * Modifies nodes in place and returns the same array.
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

      // Recursively enrich
      const enrichNode = (node: IssueNode): void => {
        const team = teamByIssue.get(node.number);
        node.activeTeam = team ?? null;
        for (const child of node.children) {
          enrichNode(child);
        }
      };

      for (const issue of issues) {
        enrichNode(issue);
      }
    } catch (err) {
      console.error('[IssueFetcher] Failed to enrich with team info:', err instanceof Error ? err.message : err);
    }

    return issues;
  }

  // -------------------------------------------------------------------------
  // Single-issue dependency fetching (used by launch check, github-poller,
  // and per-issue dependency endpoints)
  // -------------------------------------------------------------------------

  /**
   * Fetch dependency information for a specific issue using the GitHub
   * GraphQL API (issue body + trackedInIssues). Falls back gracefully
   * if the API is unavailable.
   *
   * Returns null if the API call fails (e.g. gh CLI too old).
   */
  async fetchDependencies(owner: string, repo: string, issueNumber: number): Promise<IssueDependencyInfo | null> {
    return this.fetchDependenciesFromTimeline(owner, repo, issueNumber);
  }

  /**
   * Fetch dependencies from the issue body + trackedInIssues via GraphQL.
   * Used for single-issue dependency fetching (e.g. launch-time check).
   */
  private async fetchDependenciesFromTimeline(
    owner: string,
    repo: string,
    issueNumber: number
  ): Promise<IssueDependencyInfo | null> {
    try {
      // Use the GraphQL API to get the issue body + tracked-in issues for dependency parsing
      const query = `query($owner: String!, $repo: String!, $issueNumber: Int!) { repository(owner: $owner, name: $repo) { issue(number: $issueNumber) { body trackedInIssues(first: 50) { nodes { number title state repository { owner { login } name } } } } } }`;

      const compactQuery = query.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      const requestBody = JSON.stringify({
        query: compactQuery,
        variables: { owner, repo, issueNumber },
      });

      const { stdout } = await execAsync('gh api graphql --input -', {
        encoding: 'utf-8',
        timeout: 15_000,
        env: { ...process.env },
        ...({ input: requestBody } as Record<string, unknown>),
      });

      const result = JSON.parse(stdout) as {
        data?: {
          repository?: {
            issue?: {
              body: string | null;
              trackedInIssues?: {
                nodes?: Array<{
                  number: number;
                  title: string;
                  state: string;
                  repository: { owner: { login: string }; name: string };
                }>;
              };
            };
          };
        };
        errors?: Array<{ message: string }>;
      };

      const issue = result.data?.repository?.issue;
      if (!issue) {
        return this.buildEmptyDependencyInfo(issueNumber);
      }

      const blockedBy: DependencyRef[] = [];

      // Parse tracked issues (GitHub's native tracking)
      const trackedNodes = issue.trackedInIssues?.nodes ?? [];
      for (const node of trackedNodes) {
        blockedBy.push({
          number: node.number,
          owner: node.repository.owner.login,
          repo: node.repository.name,
          state: node.state.toLowerCase() === 'open' ? 'open' : 'closed',
          title: node.title,
        });
      }

      // Parse body for "blocked by" or "depends on" patterns
      if (issue.body) {
        const bodyDeps = parseDependenciesFromBody(issue.body, owner, repo);
        // Resolve the actual state for body-parsed deps (they default to 'open')
        const resolvedBodyDeps = await this.resolveIssueStates(bodyDeps);
        for (const dep of resolvedBodyDeps) {
          // Avoid duplicates from tracked issues
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
   * Resolve the actual open/closed state for a list of dependency refs.
   * Queries GitHub via `gh api` for each unique owner/repo + issue number.
   * Uses capped concurrency (MAX_CONCURRENT_RESOLVE) to avoid flooding.
   * Falls back to 'open' if the query fails (conservative: assume still blocking).
   * Mutates the deps in place and returns the same array.
   */
  private async resolveIssueStates(deps: DependencyRef[]): Promise<DependencyRef[]> {
    if (deps.length === 0) return deps;

    const tasks = deps.map((dep) => async () => {
      try {
        const { stdout } = await execAsync(
          `gh api "/repos/${dep.owner}/${dep.repo}/issues/${dep.number}" --jq ".state,.title"`,
          {
            encoding: 'utf-8',
            timeout: 10_000,
          }
        );
        const lines = stdout.trim().split('\n');
        if (lines.length >= 1) {
          const state = lines[0].trim().toLowerCase();
          dep.state = state === 'closed' ? 'closed' : 'open';
        }
        if (lines.length >= 2 && lines[1]) {
          dep.title = lines[1].trim();
        }
      } catch {
        // gh CLI error -- leave state as default 'open' (conservative)
      }
    });

    await runWithConcurrency(tasks, MAX_CONCURRENT_RESOLVE);
    return deps;
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
   * Fetch dependencies for a specific project + issue number.
   * Convenience wrapper that resolves owner/repo from projectId.
   */
  async fetchDependenciesForIssue(projectId: number, issueNumber: number): Promise<IssueDependencyInfo | null> {
    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project?.githubRepo) return null;

    const [owner, repo] = this.parseRepo(project.githubRepo);
    return this.fetchDependencies(owner, repo, issueNumber);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Parse a github_repo string (e.g. "owner/repo") into [owner, repo].
   */
  private parseRepo(githubRepo: string): [string, string] {
    const parts = githubRepo.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      console.error(`[IssueFetcher] Invalid githubRepo: "${githubRepo}"`);
      return ['unknown', 'unknown'];
    }
    return [parts[0], parts[1]];
  }

  /**
   * Execute a GraphQL query via `gh api graphql`.
   * Returns parsed JSON or null on error.
   *
   * Selects between the full query (with blockedBy/issueDependenciesSummary)
   * and the basic query based on `this.blockedBySupported`. If the full query
   * fails due to unsupported fields, automatically downgrades to the basic
   * query and retries.
   */
  private async executeGraphQL(
    owner: string,
    repo: string,
    cursor: string | null
  ): Promise<GraphQLResponse | null> {
    const query = this.blockedBySupported ? ISSUES_QUERY_FULL : ISSUES_QUERY_BASIC;
    const result = await this.runGraphQLQuery(query, owner, repo, cursor);

    if (result !== null) {
      return result;
    }

    // If the full query failed and blockedBy was enabled, downgrade and retry
    if (this.blockedBySupported) {
      this.blockedBySupported = false;
      console.warn(
        '[IssueFetcher] Full query with blockedBy fields failed; ' +
        'falling back to basic query without dependency fields'
      );
      return this.runGraphQLQuery(ISSUES_QUERY_BASIC, owner, repo, cursor);
    }

    return null;
  }

  /**
   * Run a single GraphQL query via `gh api graphql --input -`.
   * Returns parsed JSON or null on error.
   */
  private async runGraphQLQuery(
    query: string,
    owner: string,
    repo: string,
    cursor: string | null
  ): Promise<GraphQLResponse | null> {
    try {
      // Collapse whitespace for a compact query string
      const compactQuery = query.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

      // Build the full GraphQL request body as JSON.
      // Passing via stdin avoids all shell escaping issues on Windows/Git Bash.
      const variables: Record<string, string> = { owner, repo };
      if (cursor) {
        variables.cursor = cursor;
      }

      const requestBody = JSON.stringify({
        query: compactQuery,
        variables,
      });

      // Use `gh api graphql` with --input - to read the JSON body from stdin.
      const { stdout } = await execAsync('gh api graphql --input -', {
        encoding: 'utf-8',
        timeout: 30_000,
        env: { ...process.env },
        ...({ input: requestBody } as Record<string, unknown>),
      });

      const parsed = JSON.parse(stdout) as GraphQLResponse;

      // Check for GraphQL-level errors indicating unsupported fields
      if (parsed.errors?.length) {
        const hasFieldError = parsed.errors.some(
          (e) => /field\b.*\bdoesn't exist/i.test(e.message) ||
                 /blockedBy/i.test(e.message) ||
                 /issueDependenciesSummary/i.test(e.message)
        );
        if (hasFieldError) {
          console.error(
            `[IssueFetcher] GraphQL schema error: ${parsed.errors.map((e) => e.message).join('; ')}`
          );
          return null;
        }
      }

      return parsed;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[IssueFetcher] gh api graphql failed: ${message}`);
      return null;
    }
  }

  /**
   * Map a GraphQL issue node to our IssueNode format.
   * Includes inline dependency info from the `blockedBy` field when present.
   */
  private mapGraphQLNode(node: GraphQLIssueNode): IssueNode {
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

    // Map inline blockedBy nodes to DependencyRef[] and populate dependencies
    const blockedByNodes = node.blockedBy?.nodes ?? [];
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
