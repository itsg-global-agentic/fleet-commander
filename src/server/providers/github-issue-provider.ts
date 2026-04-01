// =============================================================================
// Fleet Commander -- GitHub Issue Provider
// =============================================================================
// Implements the IssueProvider interface for GitHub issues using `gh api graphql`
// via child_process. Handles GraphQL query execution, issue mapping to
// GenericIssue, and dependency fetching.
//
// This provider encapsulates all GitHub-specific GraphQL queries, response types,
// and parsing logic that was previously in IssueFetcher.
// =============================================================================

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import type {
  IssueProvider,
  GenericIssue,
  GenericDependencyRef,
  LinkedPR,
  IssueQuery,
  IssueQueryResult,
  ProviderCapabilities,
  NormalizedStatus,
  IssueRelations,
  IssueRelationRef,
} from '../../shared/issue-provider.js';
import type { DependencyRef } from '../../shared/types.js';
import type {
  IssueContextData,
  IssueContextComment,
  IssueContextChild,
  IssueContextDependency,
  IssueContextPR,
} from '../../shared/issue-context.js';

/** Promisified exec for async child_process calls */
const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// GitHub-specific GraphQL response types
// ---------------------------------------------------------------------------

export interface GraphQLIssueNode {
  number: number;
  title: string;
  state: string;
  url: string;
  createdAt?: string;
  body?: string | null;
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

/** Shape returned by the single-issue dependency GraphQL query. */
export interface SingleIssueDepsResult {
  body: string | null;
  trackedInIssues?: {
    nodes?: Array<{
      number: number;
      title: string;
      state: string;
      repository: { owner: { login: string }; name: string };
    }>;
  };
  blockedBy?: {
    nodes?: Array<{
      number: number;
      title: string;
      state: string;
      repository: { owner: { login: string }; name: string };
    }>;
  };
  subIssuesSummary?: {
    total: number;
    completed: number;
    percentCompleted: number;
  };
  subIssues?: {
    nodes?: Array<{
      number: number;
      state: string;
    }>;
  };
}

// ---------------------------------------------------------------------------
// GitHub status -> NormalizedStatus mapping
// ---------------------------------------------------------------------------

export const GITHUB_STATUS_MAP: Record<string, NormalizedStatus> = {
  OPEN: 'open',
  CLOSED: 'closed',
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum concurrent `gh api` calls for resolving issue states */
export const MAX_CONCURRENT_RESOLVE = 5;

// ---------------------------------------------------------------------------
// GraphQL queries -- flat list of all open issues with parent reference
// ---------------------------------------------------------------------------
// Fetches ~100 issues per page with ~10 sub-fields each = ~1,000 nodes/page.
// The tree is built client-side from parent references instead of nested
// subIssues, avoiding GitHub's 500,000 node limit.
//
// Includes blockedBy/issueDependenciesSummary fields (GitHub Sub-issues /
// Issue Dependencies API).
// ---------------------------------------------------------------------------

export const ISSUES_QUERY_FULL = `
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
        body
        createdAt
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

// ---------------------------------------------------------------------------
// Single-issue dependency queries (used by fetchDependenciesFromTimeline)
// ---------------------------------------------------------------------------

export const SINGLE_ISSUE_DEPS_QUERY_FULL = `
query($owner: String!, $repo: String!, $issueNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $issueNumber) {
      body
      trackedInIssues(first: 50) {
        nodes { number title state repository { owner { login } name } }
      }
      blockedBy(first: 20) {
        nodes { number title state repository { owner { login } name } }
      }
      subIssuesSummary { total completed percentCompleted }
      subIssues(first: 50) {
        nodes { number state }
      }
    }
  }
}
`;

// ---------------------------------------------------------------------------
// Issue context queries -- single issue with full metadata for context file
// ---------------------------------------------------------------------------
// Fetches all fields needed for the issue context file in a single round-trip:
// metadata, body, comments, labels, assignees, milestone, parent, sub-issues,
// dependencies, and linked PRs.
// ---------------------------------------------------------------------------

export const ISSUE_CONTEXT_QUERY_WITH_DEPS = `
query($owner: String!, $repo: String!, $issueNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $issueNumber) {
      number
      title
      state
      body
      createdAt
      updatedAt
      author { login }
      labels(first: 20) { nodes { name } }
      assignees(first: 10) { nodes { login } }
      milestone { title }
      comments(last: 100) {
        totalCount
        nodes {
          author { login }
          createdAt
          body
          isMinimized
        }
      }
      parent { number title }
      subIssues(first: 50) { nodes { number title state } }
      blockedBy(first: 20) {
        nodes { number title state repository { owner { login } name } }
      }
      blocking(first: 20) {
        nodes { number title state repository { owner { login } name } }
      }
      closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {
        nodes { number state url }
      }
    }
  }
}
`;

// ---------------------------------------------------------------------------
// Issue context GraphQL response type
// ---------------------------------------------------------------------------

export interface IssueContextGraphQLNode {
  number: number;
  title: string;
  state: string;
  body: string | null;
  createdAt: string;
  updatedAt: string;
  author: { login: string } | null;
  labels?: { nodes?: Array<{ name: string }> };
  assignees?: { nodes?: Array<{ login: string }> };
  milestone?: { title: string } | null;
  comments?: {
    totalCount: number;
    nodes?: Array<{
      author: { login: string } | null;
      createdAt: string;
      body: string;
      isMinimized: boolean;
    }>;
  };
  parent?: { number: number; title: string } | null;
  subIssues?: { nodes?: Array<{ number: number; title: string; state: string }> };
  blockedBy?: {
    nodes?: Array<{
      number: number;
      title: string;
      state: string;
      repository: { owner: { login: string }; name: string };
    }>;
  };
  blocking?: {
    nodes?: Array<{
      number: number;
      title: string;
      state: string;
      repository: { owner: { login: string }; name: string };
    }>;
  };
  closedByPullRequestsReferences?: {
    nodes?: Array<{ number: number; state: string; url?: string }>;
  };
}

interface IssueContextGraphQLResponse {
  data?: {
    repository?: {
      issue?: IssueContextGraphQLNode;
    };
  };
  errors?: Array<{ message: string }>;
}

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
  // Match "blocked by", "depends on", "requires", "after" followed by issue references
  const patterns = [
    // "blocked by #123" or "depends on #456" or "after #789"
    /(?:blocked\s+by|depends\s+on|requires|after)\s+#(\d+)/gi,
    // "blocked by owner/repo#123" or "after owner/repo#123"
    /(?:blocked\s+by|depends\s+on|requires|after)\s+([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)#(\d+)/gi,
    // "blocked by https://github.com/owner/repo/issues/123" or "after https://github.com/..."
    /(?:blocked\s+by|depends\s+on|requires|after)\s+https?:\/\/github\.com\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)\/issues\/(\d+)/gi,
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
export async function runWithConcurrency<T>(
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
// Helper: parse a github_repo string
// ---------------------------------------------------------------------------

/**
 * Parse a github_repo string (e.g. "owner/repo") into [owner, repo].
 */
export function parseRepo(githubRepo: string): [string, string] {
  const parts = githubRepo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    console.error(`[GitHubIssueProvider] Invalid githubRepo: "${githubRepo}"`);
    return ['unknown', 'unknown'];
  }
  return [parts[0], parts[1]];
}

// ---------------------------------------------------------------------------
// GitHubIssueProvider class
// ---------------------------------------------------------------------------

export class GitHubIssueProvider implements IssueProvider {
  readonly name = 'github';
  readonly capabilities: ProviderCapabilities = {
    dependencies: true,
    subIssues: true,
    labels: true,
    boardStatuses: false,
    priorities: false,
    assignees: true,
    linkedPRs: true,
  };

  // -------------------------------------------------------------------------
  // IssueProvider interface methods
  // -------------------------------------------------------------------------

  /**
   * Fetch a single issue by key (issue number as string).
   *
   * @throws Error - always throws because this method requires owner/repo
   * context that is not available from the issue key alone. Use
   * fetchFullIssueContext() or fetchRawIssueHierarchy() instead.
   */
  async getIssue(_key: string): Promise<GenericIssue | null> {
    throw new Error(
      'GitHubIssueProvider.getIssue() requires owner/repo context that is not available ' +
      'from the issue key alone. Use fetchFullIssueContext() or fetchRawIssueHierarchy() instead.'
    );
  }

  /**
   * Query issues with filtering and pagination.
   * Delegates to fetchRawIssueHierarchy for the full batch and then
   * converts + filters. The IssueFetcher calls fetchRawIssueHierarchy
   * directly for efficiency.
   */
  async queryIssues(_query: IssueQuery): Promise<IssueQueryResult> {
    // The IssueFetcher uses fetchRawIssueHierarchy directly for efficiency.
    // This method is provided for interface compliance.
    return { issues: [], cursor: null, hasMore: false };
  }

  /**
   * Get dependency references (blocking issues) for a given issue.
   * Requires owner/repo context -- the IssueFetcher calls
   * fetchSingleIssueDependencies directly.
   */
  async getDependencies(_key: string): Promise<GenericDependencyRef[]> {
    return [];
  }

  /**
   * Get pull requests linked to a given issue.
   * Requires owner/repo context -- not available from key alone.
   */
  async getLinkedPRs(_key: string): Promise<LinkedPR[]> {
    return [];
  }

  // -------------------------------------------------------------------------
  // GitHub-specific methods (used by IssueFetcher for efficient delegation)
  // -------------------------------------------------------------------------

  /**
   * Fetch the full raw issue hierarchy from GitHub via paginated GraphQL.
   * Returns the raw GraphQLIssueNode[] array so IssueFetcher can access
   * all rich GitHub data for tree building and enrichment.
   *
   * Returns { nodes, fetchComplete } where fetchComplete indicates whether
   * all pages were successfully fetched.
   */
  async fetchRawIssueHierarchy(
    owner: string,
    repo: string,
  ): Promise<{ nodes: GraphQLIssueNode[]; fetchComplete: boolean }> {
    let allNodes: GraphQLIssueNode[] = [];
    let cursor: string | null = null;
    let hasNextPage = true;
    let fetchComplete = true;

    while (hasNextPage) {
      const result = await this.executeGraphQL(owner, repo, cursor);
      if (!result) {
        fetchComplete = false;
        break;
      }

      const issues = result.data?.repository?.issues;
      if (!issues?.nodes) {
        fetchComplete = false;
        break;
      }

      allNodes = allNodes.concat(issues.nodes);
      hasNextPage = issues.pageInfo?.hasNextPage ?? false;
      cursor = issues.pageInfo?.endCursor ?? null;
    }

    return { nodes: allNodes, fetchComplete };
  }

  /**
   * Map a GraphQL issue node to a GenericIssue.
   */
  mapToGenericIssue(node: GraphQLIssueNode): GenericIssue {
    const labels = (node.labels?.nodes ?? []).map((l) => l.name);
    const rawStatus = node.state;
    const status: NormalizedStatus = GITHUB_STATUS_MAP[rawStatus] ?? 'unknown';

    return {
      key: String(node.number),
      title: node.title,
      status,
      rawStatus,
      url: node.url,
      labels,
      assignee: null,
      priority: null,
      parentKey: node.parent?.number ? String(node.parent.number) : null,
      createdAt: node.createdAt ?? new Date().toISOString(), // Fallback for cached responses without createdAt
      updatedAt: null,
      provider: 'github',
    };
  }

  /**
   * Execute the single-issue dependency GraphQL query.
   * Always uses the full query with blockedBy fields.
   */
  async fetchSingleIssueDeps(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<SingleIssueDepsResult | null> {
    return this.runSingleIssueDepsQuery(SINGLE_ISSUE_DEPS_QUERY_FULL, owner, repo, issueNumber);
  }

  /**
   * Fetch full issue context data for generating a context file.
   *
   * Uses a dedicated GraphQL query that fetches all fields in a single round-trip:
   * metadata, body, comments, labels, assignees, milestone, parent, sub-issues,
   * dependencies, and linked PRs.
   *
   * Bot comments (author login ending with `[bot]` or equal to `github-actions`)
   * and minimized comments are filtered out. Only the 10 most recent non-bot
   * comments are included.
   *
   * Returns IssueContextData on success, or null on failure.
   */
  async fetchFullIssueContext(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<IssueContextData | null> {
    const result = await this.runIssueContextQuery(
      ISSUE_CONTEXT_QUERY_WITH_DEPS, owner, repo, issueNumber,
    );
    if (!result) return null;

    return this.mapContextNodeToData(result, owner, repo);
  }

  /**
   * Resolve the actual open/closed state for a list of dependency refs.
   * Queries GitHub via `gh api` for each unique owner/repo + issue number.
   * Uses capped concurrency (MAX_CONCURRENT_RESOLVE) to avoid flooding.
   * Falls back to 'open' if the query fails (conservative: assume still blocking).
   * Mutates the deps in place and returns the same array.
   */
  async resolveIssueStates(deps: DependencyRef[]): Promise<DependencyRef[]> {
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
   * Fetch missing parent issues via a single batched GraphQL query.
   * These are typically closed parents whose open sub-issues reference them.
   * Since the main GraphQL query only fetches OPEN issues, closed parents
   * are absent, causing their open children to become invisible in the tree.
   *
   * Uses GraphQL aliases (`p42: issue(number: 42) { ... }`) to fetch up to
   * 20 parents in a single API call instead of N individual REST calls.
   *
   * Cap: at most 20 parent fetches to avoid excessive API calls.
   * On failure: falls back to empty array; orphaned children will be
   * promoted to root level by the caller.
   */
  async fetchMissingParents(
    owner: string,
    repo: string,
    parentNumbers: number[],
  ): Promise<GraphQLIssueNode[]> {
    // Cap the number of parent fetches to avoid excessive API calls
    const capped = parentNumbers.slice(0, 20);
    if (capped.length < parentNumbers.length) {
      console.warn(
        `[GitHubIssueProvider] Capping orphan parent fetches to 20 (${parentNumbers.length} requested)`
      );
    }

    if (capped.length === 0) return [];

    try {
      // Build aliased GraphQL query fields for each parent number
      const aliasedFields = capped.map((num) =>
        `p${num}: issue(number: ${num}) { number title state url labels(first: 5) { nodes { name } } }`
      ).join('\n        ');

      const query = `query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          ${aliasedFields}
        }
      }`;

      const compactQuery = query.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      const requestBody = JSON.stringify({
        query: compactQuery,
        variables: { owner, repo },
      });

      const stdout = await this.runGHGraphQL(requestBody, 30_000);
      const result = JSON.parse(stdout) as {
        data?: {
          repository?: Record<string, {
            number: number;
            title: string;
            state: string;
            url: string;
            labels?: { nodes?: Array<{ name: string }> };
          } | null>;
        };
        errors?: Array<{ message: string }>;
      };

      if (result.errors?.length) {
        console.warn(
          `[GitHubIssueProvider] GraphQL errors fetching orphan parents: ${result.errors.map((e) => e.message).join('; ')}`
        );
      }

      const repoData = result.data?.repository;
      if (!repoData) return [];

      const results: GraphQLIssueNode[] = [];
      for (const key of Object.keys(repoData)) {
        if (!/^p\d+$/.test(key)) continue;
        const issueData = repoData[key];
        if (!issueData) continue; // null = non-existent issue, skip

        const parentNode: GraphQLIssueNode = {
          number: issueData.number,
          title: issueData.title,
          state: issueData.state,
          url: issueData.url,
          labels: issueData.labels,
        };

        results.push(parentNode);
      }

      return results;
    } catch (err) {
      console.warn(
        `[GitHubIssueProvider] Failed to fetch missing parents via GraphQL: ${err instanceof Error ? err.message : err}`
      );
      // Fallback: return empty -- caller will promote orphaned children to root
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Relations CRUD — GitHub-specific (require owner/repo context)
  // -------------------------------------------------------------------------

  /**
   * Get the GitHub GraphQL node ID for an issue.
   * Runs `gh issue view N --repo owner/repo --json id --jq '.id'`.
   */
  async getNodeId(owner: string, repo: string, issueNumber: number): Promise<string> {
    const { stdout } = await execAsync(
      `gh issue view ${issueNumber} --repo ${owner}/${repo} --json id --jq ".id"`,
      { encoding: 'utf-8', timeout: 15_000 },
    );
    const nodeId = stdout.trim();
    if (!nodeId) {
      throw new Error(`Could not resolve node ID for ${owner}/${repo}#${issueNumber}`);
    }
    return nodeId;
  }

  /**
   * Fetch all relations (parent, children, blockedBy, blocking) for an issue.
   */
  async getRelationsGH(
    owner: string,
    repo: string,
    issueKey: string,
  ): Promise<IssueRelations> {
    const issueNumber = parseInt(issueKey, 10);
    if (isNaN(issueNumber) || issueNumber < 1) {
      throw new Error(`Invalid GitHub issue key: "${issueKey}"`);
    }

    const query = `
      query($owner: String!, $repo: String!, $issueNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $issueNumber) {
            parent { number title state }
            subIssues(first: 50) { nodes { number title state } }
            blockedBy(first: 20) {
              nodes { number title state repository { owner { login } name } }
            }
            blocking(first: 20) {
              nodes { number title state repository { owner { login } name } }
            }
          }
        }
      }
    `;

    const compactQuery = query.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    const requestBody = JSON.stringify({
      query: compactQuery,
      variables: { owner, repo, issueNumber },
    });

    const stdout = await this.runGHGraphQL(requestBody, 15_000);
    const parsed = JSON.parse(stdout) as {
      data?: {
        repository?: {
          issue?: {
            parent?: { number: number; title: string; state: string } | null;
            subIssues?: { nodes?: Array<{ number: number; title: string; state: string }> };
            blockedBy?: {
              nodes?: Array<{
                number: number; title: string; state: string;
                repository: { owner: { login: string }; name: string };
              }>;
            };
            blocking?: {
              nodes?: Array<{
                number: number; title: string; state: string;
                repository: { owner: { login: string }; name: string };
              }>;
            };
          };
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (parsed.errors?.length) {
      // Check for field-not-found errors (blockedBy/blocking not available)
      const hasFieldError = parsed.errors.some(
        (e) => /field\b.*\bdoesn't exist/i.test(e.message),
      );
      if (hasFieldError) {
        console.warn(
          `[GitHubIssueProvider] getRelationsGH field errors: ${parsed.errors.map((e) => e.message).join('; ')}`,
        );
      }
    }

    const issue = parsed.data?.repository?.issue;
    if (!issue) {
      throw new Error(`Issue ${owner}/${repo}#${issueKey} not found`);
    }

    const mapState = (state: string): NormalizedStatus =>
      GITHUB_STATUS_MAP[state] ?? 'unknown';

    const parent: IssueRelationRef | null = issue.parent
      ? { key: String(issue.parent.number), title: issue.parent.title, state: mapState(issue.parent.state) }
      : null;

    const children: IssueRelationRef[] = (issue.subIssues?.nodes ?? []).map((c) => ({
      key: String(c.number),
      title: c.title,
      state: mapState(c.state),
    }));

    const blockedBy: IssueRelationRef[] = (issue.blockedBy?.nodes ?? []).map((d) => ({
      key: String(d.number),
      title: d.title,
      state: mapState(d.state),
    }));

    const blocking: IssueRelationRef[] = (issue.blocking?.nodes ?? []).map((d) => ({
      key: String(d.number),
      title: d.title,
      state: mapState(d.state),
    }));

    return { parent, children, blockedBy, blocking };
  }

  /**
   * Add a blockedBy relation between two issues.
   * issueKey is blocked by blockerKey.
   */
  async addBlockedByGH(
    owner: string,
    repo: string,
    issueKey: string,
    blockerKey: string,
  ): Promise<void> {
    const issueNumber = parseInt(issueKey, 10);
    const blockerNumber = parseInt(blockerKey, 10);
    if (isNaN(issueNumber) || isNaN(blockerNumber)) {
      throw new Error(`Invalid issue keys: issueKey="${issueKey}", blockerKey="${blockerKey}"`);
    }

    const [issueNodeId, blockerNodeId] = await Promise.all([
      this.getNodeId(owner, repo, issueNumber),
      this.getNodeId(owner, repo, blockerNumber),
    ]);

    const mutation = `mutation { addBlockedBy(input: { issueId: "${issueNodeId}", blockingIssueId: "${blockerNodeId}" }) { clientMutationId } }`;
    const requestBody = JSON.stringify({ query: mutation });
    const stdout = await this.runGHGraphQL(requestBody, 15_000);
    this.checkMutationErrors(stdout, 'addBlockedBy');
  }

  /**
   * Remove a blockedBy relation between two issues.
   */
  async removeBlockedByGH(
    owner: string,
    repo: string,
    issueKey: string,
    blockerKey: string,
  ): Promise<void> {
    const issueNumber = parseInt(issueKey, 10);
    const blockerNumber = parseInt(blockerKey, 10);
    if (isNaN(issueNumber) || isNaN(blockerNumber)) {
      throw new Error(`Invalid issue keys: issueKey="${issueKey}", blockerKey="${blockerKey}"`);
    }

    const [issueNodeId, blockerNodeId] = await Promise.all([
      this.getNodeId(owner, repo, issueNumber),
      this.getNodeId(owner, repo, blockerNumber),
    ]);

    const mutation = `mutation { removeBlockedBy(input: { issueId: "${issueNodeId}", blockingIssueId: "${blockerNodeId}" }) { clientMutationId } }`;
    const requestBody = JSON.stringify({ query: mutation });
    const stdout = await this.runGHGraphQL(requestBody, 15_000);
    this.checkMutationErrors(stdout, 'removeBlockedBy');
  }

  /**
   * Add a child (sub-issue) to a parent issue.
   */
  async addChildGH(
    owner: string,
    repo: string,
    parentKey: string,
    childKey: string,
  ): Promise<void> {
    const parentNumber = parseInt(parentKey, 10);
    const childNumber = parseInt(childKey, 10);
    if (isNaN(parentNumber) || isNaN(childNumber)) {
      throw new Error(`Invalid issue keys: parentKey="${parentKey}", childKey="${childKey}"`);
    }

    const [parentNodeId, childNodeId] = await Promise.all([
      this.getNodeId(owner, repo, parentNumber),
      this.getNodeId(owner, repo, childNumber),
    ]);

    const mutation = `mutation { addSubIssue(input: { issueId: "${parentNodeId}", subIssueId: "${childNodeId}" }) { clientMutationId } }`;
    const requestBody = JSON.stringify({ query: mutation });
    const stdout = await this.runGHGraphQL(requestBody, 15_000);
    this.checkMutationErrors(stdout, 'addSubIssue');
  }

  /**
   * Remove a child (sub-issue) from a parent issue.
   */
  async removeChildGH(
    owner: string,
    repo: string,
    parentKey: string,
    childKey: string,
  ): Promise<void> {
    const parentNumber = parseInt(parentKey, 10);
    const childNumber = parseInt(childKey, 10);
    if (isNaN(parentNumber) || isNaN(childNumber)) {
      throw new Error(`Invalid issue keys: parentKey="${parentKey}", childKey="${childKey}"`);
    }

    const [parentNodeId, childNodeId] = await Promise.all([
      this.getNodeId(owner, repo, parentNumber),
      this.getNodeId(owner, repo, childNumber),
    ]);

    const mutation = `mutation { removeSubIssue(input: { issueId: "${parentNodeId}", subIssueId: "${childNodeId}" }) { clientMutationId } }`;
    const requestBody = JSON.stringify({ query: mutation });
    const stdout = await this.runGHGraphQL(requestBody, 15_000);
    this.checkMutationErrors(stdout, 'removeSubIssue');
  }

  /**
   * Set a parent for an issue (replaces any existing parent).
   */
  async setParentGH(
    owner: string,
    repo: string,
    issueKey: string,
    parentKey: string,
  ): Promise<void> {
    const issueNumber = parseInt(issueKey, 10);
    const parentNumber = parseInt(parentKey, 10);
    if (isNaN(issueNumber) || isNaN(parentNumber)) {
      throw new Error(`Invalid issue keys: issueKey="${issueKey}", parentKey="${parentKey}"`);
    }

    const [parentNodeId, childNodeId] = await Promise.all([
      this.getNodeId(owner, repo, parentNumber),
      this.getNodeId(owner, repo, issueNumber),
    ]);

    const mutation = `mutation { addSubIssue(input: { issueId: "${parentNodeId}", subIssueId: "${childNodeId}", replaceParent: true }) { clientMutationId } }`;
    const requestBody = JSON.stringify({ query: mutation });
    const stdout = await this.runGHGraphQL(requestBody, 15_000);
    this.checkMutationErrors(stdout, 'addSubIssue (setParent)');
  }

  /**
   * Remove the parent from an issue.
   * First fetches the current parent via getRelationsGH, then calls removeSubIssue.
   */
  async removeParentGH(
    owner: string,
    repo: string,
    issueKey: string,
  ): Promise<void> {
    const relations = await this.getRelationsGH(owner, repo, issueKey);
    if (!relations.parent) {
      // No parent — nothing to do
      return;
    }

    const parentKey = relations.parent.key;
    await this.removeChildGH(owner, repo, parentKey, issueKey);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Check a GraphQL mutation response for errors and throw if found.
   */
  private checkMutationErrors(stdout: string, mutationName: string): void {
    const parsed = JSON.parse(stdout) as { errors?: Array<{ message: string }> };
    if (parsed.errors?.length) {
      const messages = parsed.errors.map((e) => e.message).join('; ');
      throw new Error(`GraphQL mutation ${mutationName} failed: ${messages}`);
    }
  }

  /**
   * Execute a GraphQL query via `gh api graphql`.
   * Returns parsed JSON or null on error.
   * Always uses the full query with blockedBy/issueDependenciesSummary fields.
   */
  private async executeGraphQL(
    owner: string,
    repo: string,
    cursor: string | null,
  ): Promise<GraphQLResponse | null> {
    return this.runGraphQLQuery(ISSUES_QUERY_FULL, owner, repo, cursor);
  }

  /**
   * Execute `gh api graphql --input -` by spawning a child process and piping
   * the request body to stdin.  Returns the raw stdout string on success.
   *
   * `child_process.exec` does NOT support the `input` option (only `execSync`
   * does), so we use `spawn` with explicit stdin piping wrapped in a Promise.
   */
  private runGHGraphQL(requestBody: string, timeoutMs = 30_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('gh', ['api', 'graphql', '--input', '-'], {
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d: Buffer) => { stdout += d; });
      child.stderr.on('data', (d: Buffer) => { stderr += d; });

      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`gh api graphql timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`gh api graphql failed (code ${code}): ${stderr}`));
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.stdin.write(requestBody);
      child.stdin.end();
    });
  }

  /**
   * Run a single GraphQL query via `gh api graphql --input -`.
   * Returns parsed JSON or null on error.
   */
  private async runGraphQLQuery(
    query: string,
    owner: string,
    repo: string,
    cursor: string | null,
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
      // spawn + stdin pipe is used because exec does NOT support the `input` option.
      const stdout = await this.runGHGraphQL(requestBody, 30_000);

      const parsed = JSON.parse(stdout) as GraphQLResponse;

      // Check for GraphQL-level errors indicating unsupported fields.
      // Only match field-not-found errors; non-field errors (rate limits,
      // deprecation warnings) should not discard valid data.
      if (parsed.errors?.length) {
        const hasFieldError = parsed.errors.some(
          (e) => /field\b.*\bdoesn't exist/i.test(e.message) ||
                 /field\b.*\bblockedBy\b.*\bdoesn't exist/i.test(e.message) ||
                 /field\b.*\bissueDependenciesSummary\b.*\bdoesn't exist/i.test(e.message)
        );
        if (hasFieldError) {
          console.error(
            `[GitHubIssueProvider] GraphQL schema error: ${parsed.errors.map((e) => e.message).join('; ')}`
          );
          return null;
        }
        // Non-field errors: log but still return the data
        console.warn(
          `[GitHubIssueProvider] GraphQL non-field errors (data still used): ${parsed.errors.map((e) => e.message).join('; ')}`
        );
      }

      return parsed;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[GitHubIssueProvider] gh api graphql failed: ${message}`);
      return null;
    }
  }

  /**
   * Run a single-issue dependency GraphQL query and return the parsed issue data.
   * Returns null on error (gh CLI failure, missing data, or GraphQL errors).
   */
  private async runSingleIssueDepsQuery(
    query: string,
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<SingleIssueDepsResult | null> {
    try {
      const compactQuery = query.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      const requestBody = JSON.stringify({
        query: compactQuery,
        variables: { owner, repo, issueNumber },
      });

      // spawn + stdin pipe is used because exec does NOT support the `input` option.
      const stdout = await this.runGHGraphQL(requestBody, 15_000);

      const parsed = JSON.parse(stdout) as {
        data?: {
          repository?: {
            issue?: SingleIssueDepsResult;
          };
        };
        errors?: Array<{ message: string }>;
      };

      if (parsed.errors?.length) {
        const hasFieldError = parsed.errors.some(
          (e) => /field\b.*\bdoesn't exist/i.test(e.message) ||
                 /field\b.*\bblockedBy\b.*\bdoesn't exist/i.test(e.message) ||
                 /field\b.*\bissueDependenciesSummary\b.*\bdoesn't exist/i.test(e.message)
        );
        if (hasFieldError) {
          console.error(
            `[GitHubIssueProvider] Single-issue deps GraphQL field errors: ${parsed.errors.map((e) => e.message).join('; ')}`
          );
          return null;
        }
        // Non-field errors (rate limits, deprecation warnings, etc.): log but still use data
        console.warn(
          `[GitHubIssueProvider] Single-issue deps GraphQL non-field errors (data still used): ${parsed.errors.map((e) => e.message).join('; ')}`
        );
      }

      return parsed.data?.repository?.issue ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[GitHubIssueProvider] Single-issue deps query failed: ${message}`);
      return null;
    }
  }

  /**
   * Run the issue context GraphQL query and return the parsed issue node.
   * Returns null on error (gh CLI failure, missing data, or GraphQL field errors).
   */
  private async runIssueContextQuery(
    query: string,
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<IssueContextGraphQLNode | null> {
    try {
      const compactQuery = query.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      const requestBody = JSON.stringify({
        query: compactQuery,
        variables: { owner, repo, issueNumber },
      });

      const stdout = await this.runGHGraphQL(requestBody, 30_000);
      const parsed = JSON.parse(stdout) as IssueContextGraphQLResponse;

      if (parsed.errors?.length) {
        const hasFieldError = parsed.errors.some(
          (e) => /field\b.*\bdoesn't exist/i.test(e.message) ||
                 /field\b.*\bblockedBy\b.*\bdoesn't exist/i.test(e.message) ||
                 /field\b.*\bblocking\b.*\bdoesn't exist/i.test(e.message) ||
                 /field\b.*\bsubIssues\b.*\bdoesn't exist/i.test(e.message)
        );
        if (hasFieldError) {
          console.error(
            `[GitHubIssueProvider] Issue context GraphQL field errors: ${parsed.errors.map((e) => e.message).join('; ')}`
          );
          return null;
        }
        // Non-field errors: log but still use data
        console.warn(
          `[GitHubIssueProvider] Issue context GraphQL non-field errors (data still used): ${parsed.errors.map((e) => e.message).join('; ')}`
        );
      }

      return parsed.data?.repository?.issue ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[GitHubIssueProvider] Issue context query failed: ${message}`);
      return null;
    }
  }

  /**
   * Map a GraphQL issue context node to an IssueContextData object.
   * Filters out bot and minimized comments, selects 10 most recent.
   */
  private mapContextNodeToData(
    node: IssueContextGraphQLNode,
    owner: string,
    repo: string,
  ): IssueContextData {
    // Labels
    const labels = (node.labels?.nodes ?? []).map((l) => l.name);

    // Assignees
    const assignees = (node.assignees?.nodes ?? []).map((a) => a.login);

    // Milestone
    const milestone = node.milestone?.title ?? null;

    // Parent
    const parent = node.parent
      ? { number: node.parent.number, title: node.parent.title }
      : null;

    // Children (sub-issues)
    const children: IssueContextChild[] = (node.subIssues?.nodes ?? []).map(
      (c) => ({ number: c.number, title: c.title, state: c.state }),
    );

    // Dependencies
    const blockedBy: IssueContextDependency[] = (node.blockedBy?.nodes ?? []).map(
      (d) => ({
        number: d.number,
        title: d.title,
        state: d.state,
        url: `https://github.com/${d.repository.owner.login}/${d.repository.name}/issues/${d.number}`,
      }),
    );

    const blocking: IssueContextDependency[] = (node.blocking?.nodes ?? []).map(
      (d) => ({
        number: d.number,
        title: d.title,
        state: d.state,
        url: `https://github.com/${d.repository.owner.login}/${d.repository.name}/issues/${d.number}`,
      }),
    );

    // Linked PRs
    const linkedPRs: IssueContextPR[] = (
      node.closedByPullRequestsReferences?.nodes ?? []
    ).map((pr) => ({
      number: pr.number,
      state: pr.state,
      url: pr.url,
    }));

    // Comments: filter bots and minimized, take 10 most recent
    const totalComments = node.comments?.totalCount ?? 0;
    const rawComments = node.comments?.nodes ?? [];

    const filteredComments = rawComments.filter((c) => {
      // Filter minimized comments
      if (c.isMinimized) return false;
      // Filter bot accounts
      const login = c.author?.login ?? '';
      if (login.endsWith('[bot]')) return false;
      if (login === 'github-actions') return false;
      return true;
    });

    // Take the 10 most recent (they come in chronological order from `last: 100`)
    const selectedComments: IssueContextComment[] = filteredComments
      .slice(-10)
      .map((c) => ({
        author: c.author?.login ?? 'unknown',
        date: c.createdAt,
        body: c.body,
      }));

    const commentsTruncated = filteredComments.length > 10;

    return {
      number: node.number,
      title: node.title,
      state: node.state,
      repo: `${owner}/${repo}`,
      author: node.author?.login ?? 'unknown',
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      labels,
      assignees,
      milestone,
      parent,
      children,
      blockedBy,
      blocking,
      linkedPRs,
      body: node.body ?? '',
      comments: selectedComments,
      truncation: {
        bodyTruncated: false,
        commentsTruncated,
        totalComments,
        includedComments: selectedComments.length,
      },
    };
  }
}
