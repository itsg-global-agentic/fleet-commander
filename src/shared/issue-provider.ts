// =============================================================================
// Fleet Commander — Issue Provider Abstraction Types
// =============================================================================
// Provider-agnostic types for issue tracking integration. These types define
// the contract that any issue provider (GitHub, Jira, Linear, etc.) must
// implement. No runtime logic — types and type guards only.
// =============================================================================

// ---------------------------------------------------------------------------
// Normalized Status
// ---------------------------------------------------------------------------

/** Cross-provider issue status, normalized for queue gating decisions. */
export type NormalizedStatus = 'open' | 'in_progress' | 'closed' | 'unknown';

const NORMALIZED_STATUSES: ReadonlySet<string> = new Set([
  'open',
  'in_progress',
  'closed',
  'unknown',
]);

// ---------------------------------------------------------------------------
// Generic Issue
// ---------------------------------------------------------------------------

/** Provider-agnostic issue representation. */
export interface GenericIssue {
  /** Universal issue identifier (e.g. "123" for GitHub, "PROJ-456" for Jira, "ENG-789" for Linear) */
  key: string;
  /** Issue title / summary */
  title: string;
  /** Normalized status for cross-provider logic */
  status: NormalizedStatus;
  /** Raw status string from the provider (e.g. "In Review", "Todo") */
  rawStatus: string;
  /** URL to the issue in the provider's UI, or null if unavailable */
  url: string | null;
  /** Labels / tags attached to the issue */
  labels: string[];
  /** Assignee username or display name, or null if unassigned */
  assignee: string | null;
  /** Priority level (provider-specific numeric scale), or null if unsupported */
  priority: number | null;
  /** Key of the parent issue, or null if top-level */
  parentKey: string | null;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 last-updated timestamp, or null if not tracked */
  updatedAt: string | null;
  /** Provider name (e.g. 'github', 'jira', 'linear') */
  provider: string;
}

// ---------------------------------------------------------------------------
// Dependency Reference
// ---------------------------------------------------------------------------

/** A reference to a blocking/dependent issue in a provider-agnostic format. */
export interface GenericDependencyRef {
  /** Universal issue key of the dependency */
  key: string;
  /** Issue title */
  title: string;
  /** Normalized status of the dependency */
  status: NormalizedStatus;
  /** Provider name */
  provider: string;
  /** Provider-specific project key, or null */
  projectKey: string | null;
}

// ---------------------------------------------------------------------------
// Linked Pull Request
// ---------------------------------------------------------------------------

/** A pull request linked to an issue. */
export interface LinkedPR {
  /** PR number */
  number: number;
  /** PR state (e.g. "open", "merged", "closed") */
  state: string;
  /** URL to the PR, or null if unavailable */
  url: string | null;
}

// ---------------------------------------------------------------------------
// Query Types
// ---------------------------------------------------------------------------

/** Query parameters for fetching issues from a provider. */
export interface IssueQuery {
  /** Provider-specific project key to scope the query */
  projectKey?: string;
  /** Filter by normalized status (single or array) */
  status?: NormalizedStatus | NormalizedStatus[];
  /** Filter by labels */
  labels?: string[];
  /** Filter by assignee */
  assignee?: string;
  /** Cursor for pagination */
  cursor?: string;
  /** Maximum number of results to return */
  limit?: number;
}

/** Result of an issue query with pagination support. */
export interface IssueQueryResult {
  /** Issues matching the query */
  issues: GenericIssue[];
  /** Cursor for the next page, or null if no more results */
  cursor: string | null;
  /** Whether there are more results beyond this page */
  hasMore: boolean;
  /** Total count of matching issues, if available from the provider */
  total?: number;
}

// ---------------------------------------------------------------------------
// Provider Capabilities
// ---------------------------------------------------------------------------

/** Feature flags indicating what a provider supports. */
export interface ProviderCapabilities {
  /** Whether the provider supports issue dependencies / blockers */
  dependencies: boolean;
  /** Whether the provider supports sub-issues / child issues */
  subIssues: boolean;
  /** Whether the provider supports labels / tags */
  labels: boolean;
  /** Whether the provider supports board statuses (e.g. Kanban columns) */
  boardStatuses: boolean;
  /** Whether the provider supports priority levels */
  priorities: boolean;
  /** Whether the provider supports assignees */
  assignees: boolean;
  /** Whether the provider supports linked pull requests */
  linkedPRs: boolean;
}

// ---------------------------------------------------------------------------
// Issue Provider Interface
// ---------------------------------------------------------------------------

/** Contract for issue tracking providers (GitHub, Jira, Linear, etc.). */
export interface IssueProvider {
  /** Provider identifier (e.g. 'github', 'jira', 'linear') */
  readonly name: string;
  /** Feature flags for this provider */
  readonly capabilities: ProviderCapabilities;
  /** Fetch a single issue by key. Returns null if not found. */
  getIssue(key: string): Promise<GenericIssue | null>;
  /** Query issues with filtering and pagination. */
  queryIssues(query: IssueQuery): Promise<IssueQueryResult>;
  /** Get dependency references (blocking issues) for a given issue. */
  getDependencies(key: string): Promise<GenericDependencyRef[]>;
  /** Get pull requests linked to a given issue. */
  getLinkedPRs(key: string): Promise<LinkedPR[]>;
}

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Display & Path Utilities
// ---------------------------------------------------------------------------

/**
 * Format an issue key for display based on the provider.
 * GitHub (or null/default): "#42"
 * Other providers (jira, linear): "PROJ-123" unchanged
 */
export function formatIssueKey(issueKey: string, issueProvider: string | null): string {
  if (!issueProvider || issueProvider === 'github') {
    return `#${issueKey}`;
  }
  return issueKey;
}

/**
 * Sanitize an issue key for use in filesystem paths (worktree names, branches).
 * Lowercases and replaces non-alphanumeric characters (except hyphens) with "-",
 * then trims leading/trailing hyphens.
 *
 * Examples:
 *   "PROJ-123" -> "proj-123"
 *   "42"       -> "42"
 *   "ENG_456"  -> "eng-456"
 */
export function sanitizeIssueKeyForPath(issueKey: string): string {
  return issueKey
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/** Check if a value is a valid NormalizedStatus. */
export function isNormalizedStatus(value: unknown): value is NormalizedStatus {
  return typeof value === 'string' && NORMALIZED_STATUSES.has(value);
}

/** Check if a value conforms to the GenericIssue interface. */
export function isGenericIssue(value: unknown): value is GenericIssue {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.key === 'string' &&
    typeof obj.title === 'string' &&
    isNormalizedStatus(obj.status) &&
    typeof obj.rawStatus === 'string' &&
    (obj.url === null || typeof obj.url === 'string') &&
    Array.isArray(obj.labels) &&
    typeof obj.createdAt === 'string' &&
    typeof obj.provider === 'string'
  );
}
