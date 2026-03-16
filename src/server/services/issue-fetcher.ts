// =============================================================================
// Fleet Commander -- Issue Hierarchy Service (GraphQL + REST via gh CLI)
// =============================================================================
// Fetches issue hierarchy from GitHub using `gh api graphql` via child_process.
// Caches results in memory with periodic auto-refresh.
// Enriches issues with active team info from the database.
// =============================================================================

import { execSync } from 'child_process';
import config from '../config.js';
import { getDatabase } from '../db.js';

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
}

interface GraphQLIssueNode {
  number: number;
  title: string;
  state: string;
  url: string;
  labels?: { nodes?: Array<{ name: string }> };
  projectItems?: { nodes?: Array<{ fieldValueByName?: { name?: string } | null }> };
  subIssuesSummary?: { total: number; completed: number; percentCompleted: number };
  closedByPullRequestsReferences?: {
    nodes?: Array<{ number: number; state: string }>;
  };
  subIssues?: {
    nodes?: Array<GraphQLIssueNode>;
  };
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
// GraphQL query — 3-level hierarchy with PR references and board status
// ---------------------------------------------------------------------------

const HIERARCHY_QUERY = `
query GetHierarchy($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    issues(first: 50, after: $cursor, states: [OPEN]) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        state
        url
        labels(first: 10) { nodes { name } }
        projectItems(first: 5) {
          nodes {
            fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue { name }
            }
          }
        }
        subIssuesSummary { total completed percentCompleted }
        subIssues(first: 50) {
          nodes {
            number
            title
            state
            url
            labels(first: 10) { nodes { name } }
            projectItems(first: 5) {
              nodes {
                fieldValueByName(name: "Status") {
                  ... on ProjectV2ItemFieldSingleSelectValue { name }
                }
              }
            }
            subIssuesSummary { total completed percentCompleted }
            subIssues(first: 50) {
              nodes {
                number
                title
                state
                url
                labels(first: 10) { nodes { name } }
                projectItems(first: 5) {
                  nodes {
                    fieldValueByName(name: "Status") {
                      ... on ProjectV2ItemFieldSingleSelectValue { name }
                    }
                  }
                }
                subIssuesSummary { total completed percentCompleted }
              }
            }
            closedByPullRequestsReferences(first: 3, includeClosedPrs: true) {
              nodes { number state }
            }
          }
        }
        closedByPullRequestsReferences(first: 3, includeClosedPrs: true) {
          nodes { number state }
        }
      }
    }
  }
}
`;

// ---------------------------------------------------------------------------
// Issue Fetcher class
// ---------------------------------------------------------------------------

export class IssueFetcher {
  private cache: IssueNode[] = [];
  private cachedAt: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Full fetch from GitHub. Paginates through all open issues.
   * Returns the full hierarchy tree.
   */
  fetchIssueHierarchy(): IssueNode[] {
    const [owner, repo] = this.parseRepo();
    let allNodes: GraphQLIssueNode[] = [];
    let cursor: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const result = this.executeGraphQL(owner, repo, cursor);
      if (!result) {
        // gh CLI error — return whatever we have so far (or empty)
        break;
      }

      const issues = result.data?.repository?.issues;
      if (!issues?.nodes) break;

      allNodes = allNodes.concat(issues.nodes);
      hasNextPage = issues.pageInfo?.hasNextPage ?? false;
      cursor = issues.pageInfo?.endCursor ?? null;
    }

    // Convert GraphQL nodes to our IssueNode format
    const issueTree = allNodes.map((node) => this.mapGraphQLNode(node));

    // Filter to only root-level issues (those not appearing as children of other issues)
    const childNumbers = new Set<number>();
    const collectChildNumbers = (nodes: IssueNode[]): void => {
      for (const node of nodes) {
        for (const child of node.children) {
          childNumbers.add(child.number);
          collectChildNumbers([child]);
        }
      }
    };
    collectChildNumbers(issueTree);

    this.cache = issueTree.filter((issue) => !childNumbers.has(issue.number));
    this.cachedAt = new Date().toISOString();

    return this.cache;
  }

  /**
   * Returns cached issues. If cache is empty, fetches first.
   */
  getIssues(): IssueNode[] {
    if (this.cache.length === 0 && !this.cachedAt) {
      this.fetchIssueHierarchy();
    }
    return this.cache;
  }

  /**
   * Get a single issue by number from the cache (searches recursively).
   */
  getIssue(number: number): IssueNode | undefined {
    return this.findInTree(this.cache, number);
  }

  /**
   * Suggest the next issue to work on.
   * Criteria: Ready status, no active team, not in activeTeamIssues list.
   * Returns the highest priority issue (P0 > P1 > P2 > unlabeled).
   */
  getNextIssue(activeTeamIssues: number[]): IssueNode | null {
    const available = this.getAvailableIssues(activeTeamIssues);

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
   */
  getAvailableIssues(activeTeamIssues: number[]): IssueNode[] {
    const activeSet = new Set(activeTeamIssues);
    const allIssues = this.flattenTree(this.cache);

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
   * Force a re-fetch from GitHub.
   */
  refresh(): IssueNode[] {
    return this.fetchIssueHierarchy();
  }

  /**
   * Get the time the cache was last refreshed.
   */
  getCachedAt(): string | null {
    return this.cachedAt;
  }

  /**
   * Start the auto-refresh polling timer.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Initial fetch
    try {
      this.fetchIssueHierarchy();
    } catch (err) {
      console.error('[IssueFetcher] Initial fetch failed:', err instanceof Error ? err.message : err);
    }

    // Set up polling
    this.pollTimer = setInterval(() => {
      try {
        this.fetchIssueHierarchy();
      } catch (err) {
        console.error('[IssueFetcher] Polling fetch failed:', err instanceof Error ? err.message : err);
      }
    }, config.issuePollIntervalMs);
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
   */
  enrichWithTeamInfo(issues: IssueNode[]): IssueNode[] {
    try {
      const db = getDatabase();
      const activeTeams = db.getActiveTeams();

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
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Parse the configured repo into owner and name.
   */
  private parseRepo(): [string, string] {
    const parts = config.githubRepo.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      console.error(`[IssueFetcher] Invalid githubRepo config: "${config.githubRepo}"`);
      return ['unknown', 'unknown'];
    }
    return [parts[0], parts[1]];
  }

  /**
   * Execute a GraphQL query via `gh api graphql`.
   * Returns parsed JSON or null on error.
   */
  private executeGraphQL(
    owner: string,
    repo: string,
    cursor: string | null
  ): GraphQLResponse | null {
    try {
      // Collapse whitespace for a compact query string
      const compactQuery = HIERARCHY_QUERY.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

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
      // The `input` option automatically pipes to stdin.
      const output = execSync('gh api graphql --input -', {
        encoding: 'utf-8',
        input: requestBody,
        timeout: 30_000,
      });

      return JSON.parse(output) as GraphQLResponse;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[IssueFetcher] gh api graphql failed: ${message}`);
      return null;
    }
  }

  /**
   * Map a GraphQL issue node to our IssueNode format.
   */
  private mapGraphQLNode(node: GraphQLIssueNode): IssueNode {
    const labels = (node.labels?.nodes ?? []).map((l) => l.name);

    // Extract board status from project items
    let boardStatus: string | undefined;
    const projectItems = node.projectItems?.nodes ?? [];
    for (const item of projectItems) {
      const fieldValue = item.fieldValueByName;
      if (fieldValue && 'name' in fieldValue && fieldValue.name) {
        boardStatus = fieldValue.name;
        break;
      }
    }

    // Extract PR references
    const prRefs = (node.closedByPullRequestsReferences?.nodes ?? []).map((pr) => ({
      number: pr.number,
      state: pr.state,
    }));

    // Recursively map sub-issues (children)
    const children = (node.subIssues?.nodes ?? []).map((child) =>
      this.mapGraphQLNode(child)
    );

    const issueNode: IssueNode = {
      number: node.number,
      title: node.title,
      state: node.state.toLowerCase() === 'open' ? 'open' : 'closed',
      labels,
      url: node.url,
      children,
      activeTeam: null,
    };

    if (boardStatus) {
      issueNode.boardStatus = boardStatus;
    }

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
