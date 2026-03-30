// =============================================================================
// Fleet Commander -- Jira Issue Provider
// =============================================================================
// Implements the IssueProvider interface for Jira Cloud issues using the
// Jira REST API v3 via native fetch. Handles issue fetching, status mapping,
// dependency extraction from issue links, and linked PR detection.
//
// Authentication: HTTP Basic Auth (email + API token), the standard approach
// for Jira Cloud. Jira Server/Data Center is not supported.
// =============================================================================

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

// ---------------------------------------------------------------------------
// Jira configuration
// ---------------------------------------------------------------------------

export interface JiraConfig {
  /** Jira Cloud base URL (e.g. "https://mycompany.atlassian.net") */
  baseUrl: string;
  /** Jira account email */
  email: string;
  /** Jira API token */
  apiToken: string;
  /** Jira project key (e.g. "PROJ") */
  projectKey: string;
  /** Custom status mapping overrides (lowercase Jira status -> NormalizedStatus) */
  statusMapping?: Record<string, NormalizedStatus>;
}

// ---------------------------------------------------------------------------
// Jira REST API response types (internal)
// ---------------------------------------------------------------------------

interface JiraUser {
  displayName?: string;
  accountId?: string;
  emailAddress?: string;
}

interface JiraStatus {
  name: string;
  statusCategory?: {
    key: string;
    name: string;
  };
}

interface JiraPriority {
  id: string;
  name: string;
}

interface JiraIssueType {
  name: string;
  subtask: boolean;
}

interface JiraIssueLink {
  id: string;
  type: {
    name: string;
    inward: string;
    outward: string;
  };
  inwardIssue?: JiraIssueFields;
  outwardIssue?: JiraIssueFields;
}

interface JiraIssueFields {
  key?: string;
  id?: string;
  fields?: {
    summary?: string;
    status?: JiraStatus;
    issuetype?: JiraIssueType;
    priority?: JiraPriority;
    assignee?: JiraUser;
    labels?: string[];
    parent?: { key: string; fields?: { summary?: string } };
    issuelinks?: JiraIssueLink[];
    created?: string;
    updated?: string;
  };
  self?: string;
}

interface JiraIssue {
  key: string;
  id: string;
  fields: {
    summary: string;
    status: JiraStatus;
    issuetype: JiraIssueType;
    priority?: JiraPriority;
    assignee?: JiraUser | null;
    labels?: string[];
    parent?: { key: string; fields?: { summary?: string } };
    issuelinks?: JiraIssueLink[];
    created: string;
    updated?: string;
  };
  self: string;
}

interface JiraSearchResponse {
  issues: JiraIssue[];
  startAt: number;
  maxResults: number;
  total: number;
}

interface JiraRemoteLink {
  id: number;
  self: string;
  object: {
    url: string;
    title: string;
    icon?: { url16x16?: string };
    status?: { resolved?: boolean; icon?: { url16x16?: string } };
  };
}

// ---------------------------------------------------------------------------
// Default status mapping
// ---------------------------------------------------------------------------

/**
 * Default mapping from lowercase Jira status names to NormalizedStatus.
 * Users can override this via the statusMapping field in JiraConfig.
 * The mapping also falls back to Jira's statusCategory for unmapped statuses.
 */
export const DEFAULT_JIRA_STATUS_MAP: Record<string, NormalizedStatus> = {
  'to do': 'open',
  'backlog': 'open',
  'open': 'open',
  'reopened': 'open',
  'new': 'open',
  'in progress': 'in_progress',
  'in review': 'in_progress',
  'in development': 'in_progress',
  'code review': 'in_progress',
  'testing': 'in_progress',
  'done': 'closed',
  'closed': 'closed',
  'resolved': 'closed',
  'cancelled': 'closed',
  'won\'t do': 'closed',
  'won\'t fix': 'closed',
};

/**
 * Fallback mapping from Jira statusCategory keys to NormalizedStatus.
 * Used when the exact status name is not found in the custom or default map.
 */
const STATUS_CATEGORY_MAP: Record<string, NormalizedStatus> = {
  'new': 'open',
  'indeterminate': 'in_progress',
  'done': 'closed',
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum issues per search page (Jira Cloud caps at 100) */
const MAX_RESULTS_PER_PAGE = 100;

/** Maximum total issues to fetch across all pages */
const MAX_TOTAL_ISSUES = 1000;

/** Request timeout in milliseconds */
const REQUEST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// JiraIssueProvider class
// ---------------------------------------------------------------------------

export class JiraIssueProvider implements IssueProvider {
  readonly name = 'jira';
  readonly capabilities: ProviderCapabilities = {
    dependencies: true,
    subIssues: true,
    labels: true,
    boardStatuses: true,
    priorities: true,
    assignees: true,
    linkedPRs: true,
  };

  private readonly config: JiraConfig;
  private readonly authHeader: string;
  private readonly effectiveStatusMap: Record<string, NormalizedStatus>;

  constructor(config: JiraConfig) {
    this.config = config;

    // Pre-compute the Base64-encoded auth header
    const credentials = `${config.email}:${config.apiToken}`;
    this.authHeader = `Basic ${Buffer.from(credentials).toString('base64')}`;

    // Merge custom status mapping on top of defaults (custom wins)
    this.effectiveStatusMap = {
      ...DEFAULT_JIRA_STATUS_MAP,
      ...(config.statusMapping ?? {}),
    };
  }

  /** Returns the Jira Cloud base URL (e.g. "https://mycompany.atlassian.net") */
  get baseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, '');
  }

  // -------------------------------------------------------------------------
  // IssueProvider interface methods
  // -------------------------------------------------------------------------

  /**
   * Fetch a single issue by key (e.g. "PROJ-123").
   */
  async getIssue(key: string): Promise<GenericIssue | null> {
    try {
      const fields = 'summary,status,issuetype,priority,assignee,labels,parent,issuelinks,created,updated';
      const issue = await this.jiraFetch<JiraIssue>(
        `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`,
      );
      return this.mapToGenericIssue(issue);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('404') || message.includes('not found')) {
        return null;
      }
      console.warn(`[JiraIssueProvider] Failed to fetch issue ${key}: ${message}`);
      return null;
    }
  }

  /**
   * Query issues with filtering and pagination via JQL.
   */
  async queryIssues(query: IssueQuery): Promise<IssueQueryResult> {
    try {
      const projectKey = query.projectKey ?? this.config.projectKey;
      const jqlParts: string[] = [`project = "${projectKey}"`];

      // Status filter
      if (query.status) {
        const statuses = Array.isArray(query.status) ? query.status : [query.status];
        const jiraStatuses = this.normalizedToJiraStatuses(statuses);
        if (jiraStatuses.length > 0) {
          jqlParts.push(`status IN (${jiraStatuses.map((s) => `"${s}"`).join(', ')})`);
        }
      } else {
        // Default: fetch open issues (exclude Done/Closed category)
        jqlParts.push('statusCategory != Done');
      }

      // Label filter
      if (query.labels && query.labels.length > 0) {
        const labelConditions = query.labels.map((l) => `labels = "${l}"`);
        jqlParts.push(`(${labelConditions.join(' OR ')})`);
      }

      // Assignee filter
      if (query.assignee) {
        jqlParts.push(`assignee = "${query.assignee}"`);
      }

      const jql = jqlParts.join(' AND ');
      const limit = Math.min(query.limit ?? MAX_RESULTS_PER_PAGE, MAX_RESULTS_PER_PAGE);
      const startAt = query.cursor ? parseInt(query.cursor, 10) : 0;

      const result = await this.jiraFetch<JiraSearchResponse>('/rest/api/3/search', {
        method: 'POST',
        body: JSON.stringify({
          jql,
          startAt,
          maxResults: limit,
          fields: ['summary', 'status', 'issuetype', 'priority', 'assignee', 'labels', 'parent', 'issuelinks', 'created', 'updated'],
        }),
      });

      const issues = result.issues.map((issue) => this.mapToGenericIssue(issue));
      const nextStart = result.startAt + result.issues.length;
      const hasMore = nextStart < result.total && nextStart < MAX_TOTAL_ISSUES;

      return {
        issues,
        cursor: hasMore ? String(nextStart) : null,
        hasMore,
        total: result.total,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[JiraIssueProvider] Failed to query issues: ${message}`);
      return { issues: [], cursor: null, hasMore: false };
    }
  }

  /**
   * Get dependency references (blocking issues) for a given issue.
   * Extracts "is blocked by" links from the issue's issuelinks field.
   */
  async getDependencies(key: string): Promise<GenericDependencyRef[]> {
    try {
      const fields = 'issuelinks,status';
      const issue = await this.jiraFetch<JiraIssue>(
        `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`,
      );

      return this.extractBlockingDependencies(issue);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[JiraIssueProvider] Failed to fetch dependencies for ${key}: ${message}`);
      return [];
    }
  }

  /**
   * Get pull requests linked to a given issue via remote links.
   * Jira stores PR links as "remote issue links" with URLs pointing to
   * GitHub/GitLab/Bitbucket pull request pages.
   */
  async getLinkedPRs(key: string): Promise<LinkedPR[]> {
    try {
      const remoteLinks = await this.jiraFetch<JiraRemoteLink[]>(
        `/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`,
      );

      const prs: LinkedPR[] = [];
      for (const link of remoteLinks) {
        const prInfo = this.parsePRFromRemoteLink(link);
        if (prInfo) {
          prs.push(prInfo);
        }
      }
      return prs;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[JiraIssueProvider] Failed to fetch linked PRs for ${key}: ${message}`);
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Relations CRUD — Jira-specific
  // -------------------------------------------------------------------------

  /**
   * Get all relations for a Jira issue (parent, children, blockedBy, blocking).
   */
  async getRelationsJira(key: string): Promise<IssueRelations> {
    const fields = 'issuelinks,parent,subtasks,status,summary';
    const issue = await this.jiraFetch<JiraIssue>(
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`,
    );

    const parent: IssueRelationRef | null = issue.fields.parent
      ? {
          key: issue.fields.parent.key,
          title: issue.fields.parent.fields?.summary ?? '',
          state: 'unknown' as NormalizedStatus,
        }
      : null;

    // Subtasks are the children in Jira's hierarchy
    const subtasks = (issue.fields as Record<string, unknown>).subtasks as
      Array<{ key: string; fields?: { summary?: string; status?: { name: string; statusCategory?: { key: string; name: string } } } }> | undefined;
    const children: IssueRelationRef[] = (subtasks ?? []).map((st) => ({
      key: st.key,
      title: st.fields?.summary ?? '',
      state: st.fields?.status ? this.mapStatus(st.fields.status as JiraStatus) : 'unknown' as NormalizedStatus,
    }));

    const blockedBy: IssueRelationRef[] = [];
    const blocking: IssueRelationRef[] = [];
    const links = issue.fields.issuelinks ?? [];

    for (const link of links) {
      const linkTypeName = link.type.name.toLowerCase();
      const isBlockingType = linkTypeName.includes('block');
      if (!isBlockingType) continue;

      const inwardDesc = link.type.inward.toLowerCase();
      const isBlockedByDirection = inwardDesc.includes('blocked by');

      if (isBlockedByDirection && link.inwardIssue) {
        const blockerKey = link.inwardIssue.key ?? '';
        if (blockerKey) {
          const blockerStatus = link.inwardIssue.fields?.status
            ? this.mapStatus(link.inwardIssue.fields.status)
            : 'unknown' as NormalizedStatus;
          blockedBy.push({
            key: blockerKey,
            title: link.inwardIssue.fields?.summary ?? '',
            state: blockerStatus,
          });
        }
      }

      if (!isBlockedByDirection && link.outwardIssue) {
        const blockedKey = link.outwardIssue.key ?? '';
        if (blockedKey) {
          const blockedStatus = link.outwardIssue.fields?.status
            ? this.mapStatus(link.outwardIssue.fields.status)
            : 'unknown' as NormalizedStatus;
          blocking.push({
            key: blockedKey,
            title: link.outwardIssue.fields?.summary ?? '',
            state: blockedStatus,
          });
        }
      } else if (isBlockedByDirection && link.outwardIssue) {
        // Outward on a "blocked by" type = this issue blocks the outward issue
        const blockedKey = link.outwardIssue.key ?? '';
        if (blockedKey) {
          const blockedStatus = link.outwardIssue.fields?.status
            ? this.mapStatus(link.outwardIssue.fields.status)
            : 'unknown' as NormalizedStatus;
          blocking.push({
            key: blockedKey,
            title: link.outwardIssue.fields?.summary ?? '',
            state: blockedStatus,
          });
        }
      }
    }

    return { parent, children, blockedBy, blocking };
  }

  /**
   * Add a blockedBy relation. Creates an issue link of type "Blocks".
   * inwardIssue = the blocker (blocks the other), outwardIssue = the blocked issue.
   *
   * Jira link semantics: inwardIssue "blocks" outwardIssue, so
   * outwardIssue "is blocked by" inwardIssue.
   */
  async addBlockedByJira(issueKey: string, blockerKey: string): Promise<void> {
    await this.jiraFetch<unknown>('/rest/api/3/issueLink', {
      method: 'POST',
      body: JSON.stringify({
        type: { name: 'Blocks' },
        inwardIssue: { key: blockerKey },
        outwardIssue: { key: issueKey },
      }),
    });
  }

  /**
   * Remove a blockedBy relation. Finds the link ID and deletes it.
   */
  async removeBlockedByJira(issueKey: string, blockerKey: string): Promise<void> {
    const fields = 'issuelinks';
    const issue = await this.jiraFetch<JiraIssue>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${fields}`,
    );

    const links = issue.fields.issuelinks ?? [];
    let linkId: string | null = null;

    for (const link of links) {
      const linkTypeName = link.type.name.toLowerCase();
      if (!linkTypeName.includes('block')) continue;

      const inwardDesc = link.type.inward.toLowerCase();
      if (inwardDesc.includes('blocked by') && link.inwardIssue) {
        const inKey = link.inwardIssue.key ?? '';
        if (inKey === blockerKey) {
          linkId = link.id;
          break;
        }
      }
    }

    if (!linkId) {
      throw new Error(`No "blocked by" link found between ${issueKey} and ${blockerKey}`);
    }

    await this.jiraFetch<unknown>(`/rest/api/3/issueLink/${linkId}`, {
      method: 'DELETE',
    });
  }

  /**
   * Set the parent of an issue (via the parent field).
   */
  async setParentJira(issueKey: string, parentKey: string): Promise<void> {
    await this.jiraFetch<unknown>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      method: 'PUT',
      body: JSON.stringify({
        fields: { parent: { key: parentKey } },
      }),
    });
  }

  /**
   * Remove the parent of an issue (clear the parent field).
   */
  async removeParentJira(issueKey: string): Promise<void> {
    await this.jiraFetch<unknown>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      method: 'PUT',
      body: JSON.stringify({
        fields: { parent: null },
      }),
    });
  }

  /**
   * Add a child issue (set the child's parent to parentKey).
   */
  async addChildJira(parentKey: string, childKey: string): Promise<void> {
    await this.setParentJira(childKey, parentKey);
  }

  /**
   * Remove a child issue (clear the child's parent field).
   */
  async removeChildJira(_parentKey: string, childKey: string): Promise<void> {
    await this.removeParentJira(childKey);
  }

  /**
   * Fetch all open issues with pagination for the full hierarchy.
   * Used by IssueFetcher's generic fetch path to build the issue tree.
   * Pages through all results up to MAX_TOTAL_ISSUES.
   */
  async fetchAllOpenIssues(): Promise<GenericIssue[]> {
    const allIssues: GenericIssue[] = [];
    let cursor: string | null = null;
    let hasMore = true;

    while (hasMore && allIssues.length < MAX_TOTAL_ISSUES) {
      const result = await this.queryIssues({
        projectKey: this.config.projectKey,
        cursor: cursor ?? undefined,
        limit: MAX_RESULTS_PER_PAGE,
      });

      allIssues.push(...result.issues);
      cursor = result.cursor;
      hasMore = result.hasMore;
    }

    return allIssues;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Make an authenticated request to the Jira REST API.
   */
  private async jiraFetch<T>(path: string, options?: { method?: string; body?: string }): Promise<T> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}${path}`;
    const method = options?.method ?? 'GET';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Authorization': this.authHeader,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: options?.body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Jira API ${method} ${path} failed (${response.status}): ${text.slice(0, 200)}`);
      }

      // Some responses (204 No Content, some PUT/DELETE) have no body
      if (response.status === 204) {
        return undefined as T;
      }

      return await response.json() as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Map a Jira issue to a GenericIssue.
   */
  private mapToGenericIssue(issue: JiraIssue): GenericIssue {
    const status = this.mapStatus(issue.fields.status);
    const rawStatus = issue.fields.status.name;

    // Extract priority as a numeric value (Jira priorities have string IDs)
    const priorityId = issue.fields.priority?.id;
    const priority = priorityId ? parseInt(priorityId, 10) : null;

    // Build the issue URL from the base URL and key
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/browse/${issue.key}`;

    return {
      key: issue.key,
      title: issue.fields.summary,
      status,
      rawStatus,
      url,
      labels: issue.fields.labels ?? [],
      assignee: issue.fields.assignee?.displayName ?? null,
      priority: isNaN(priority ?? NaN) ? null : priority,
      parentKey: issue.fields.parent?.key ?? null,
      createdAt: issue.fields.created,
      updatedAt: issue.fields.updated ?? null,
      provider: 'jira',
    };
  }

  /**
   * Map a Jira status to a NormalizedStatus.
   * Checks custom mapping first, then default mapping, then status category.
   */
  private mapStatus(jiraStatus: JiraStatus): NormalizedStatus {
    const statusName = jiraStatus.name.toLowerCase();

    // Check the effective (merged custom + default) map
    const mapped = this.effectiveStatusMap[statusName];
    if (mapped) return mapped;

    // Fallback to status category
    const categoryKey = jiraStatus.statusCategory?.key?.toLowerCase();
    if (categoryKey) {
      const categoryMapped = STATUS_CATEGORY_MAP[categoryKey];
      if (categoryMapped) return categoryMapped;
    }

    return 'unknown';
  }

  /**
   * Reverse-map NormalizedStatus values to Jira status names for JQL queries.
   * Returns status names from the effective map that correspond to the given normalized statuses.
   */
  private normalizedToJiraStatuses(statuses: NormalizedStatus[]): string[] {
    const result: string[] = [];
    const statusSet = new Set(statuses);

    for (const [jiraStatus, normalized] of Object.entries(this.effectiveStatusMap)) {
      if (statusSet.has(normalized)) {
        result.push(jiraStatus);
      }
    }

    return result;
  }

  /**
   * Extract blocking dependencies from a Jira issue's issuelinks.
   * Looks for link types containing "block" (case-insensitive) where
   * the current issue is blocked by the linked issue (inward direction).
   */
  private extractBlockingDependencies(issue: JiraIssue): GenericDependencyRef[] {
    const links = issue.fields.issuelinks ?? [];
    const deps: GenericDependencyRef[] = [];

    for (const link of links) {
      // Check if this is a "blocks" type link
      const linkTypeName = link.type.name.toLowerCase();
      const isBlockingType = linkTypeName.includes('block');

      if (!isBlockingType) continue;

      // The inward description typically says "is blocked by"
      // If we have an inwardIssue, it means THAT issue blocks THIS issue
      // (this issue "is blocked by" the inward issue)
      const inwardDesc = link.type.inward.toLowerCase();
      const isBlockedByDirection = inwardDesc.includes('blocked by');

      if (isBlockedByDirection && link.inwardIssue) {
        const blockerKey = link.inwardIssue.key ?? '';
        const blockerFields = link.inwardIssue.fields;
        const blockerStatus = blockerFields?.status
          ? this.mapStatus(blockerFields.status)
          : 'unknown';

        if (blockerKey) {
          deps.push({
            key: blockerKey,
            title: blockerFields?.summary ?? '',
            status: blockerStatus,
            provider: 'jira',
            projectKey: blockerKey.split('-')[0] ?? null,
          });
        }
      }

    }

    return deps;
  }

  /**
   * Parse a PR URL from a Jira remote link.
   * Detects GitHub, GitLab, and Bitbucket PR URLs.
   */
  private parsePRFromRemoteLink(link: JiraRemoteLink): LinkedPR | null {
    const url = link.object.url;
    if (!url) return null;

    // GitHub PR: https://github.com/owner/repo/pull/123
    const githubMatch = url.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
    if (githubMatch) {
      const prNumber = parseInt(githubMatch[1], 10);
      const resolved = link.object.status?.resolved;
      return {
        number: prNumber,
        state: resolved ? 'merged' : 'open',
        url,
      };
    }

    // GitLab MR: https://gitlab.com/owner/repo/-/merge_requests/123
    const gitlabMatch = url.match(/gitlab\.[^/]+\/[^/]+\/[^/]+\/-\/merge_requests\/(\d+)/);
    if (gitlabMatch) {
      const prNumber = parseInt(gitlabMatch[1], 10);
      const resolved = link.object.status?.resolved;
      return {
        number: prNumber,
        state: resolved ? 'merged' : 'open',
        url,
      };
    }

    // Bitbucket PR: https://bitbucket.org/owner/repo/pull-requests/123
    const bitbucketMatch = url.match(/bitbucket\.[^/]+\/[^/]+\/[^/]+\/pull-requests\/(\d+)/);
    if (bitbucketMatch) {
      const prNumber = parseInt(bitbucketMatch[1], 10);
      const resolved = link.object.status?.resolved;
      return {
        number: prNumber,
        state: resolved ? 'merged' : 'open',
        url,
      };
    }

    return null;
  }
}
