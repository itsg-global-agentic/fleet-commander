// =============================================================================
// Fleet Commander — Issue Service
// =============================================================================
// Wraps the IssueFetcher for route consumption. Provides business-level methods
// for issue hierarchy queries, single issue lookup, dependencies, and refresh.
// =============================================================================

import { getIssueFetcher } from './issue-fetcher.js';
import type { IssueNode } from './issue-fetcher.js';
import { getDatabase } from '../db.js';
import { validationError, notFoundError } from './service-error.js';
import { computeWaves, type WaveIssue, type ExecutionPlan } from '../../shared/wave-computation.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count total issues in a tree (recursive).
 */
function countIssues(tree: Array<{ children?: Array<unknown> }>): number {
  let count = 0;
  const walk = (nodes: Array<{ children?: Array<unknown> }>): void => {
    for (const node of nodes) {
      count++;
      if (node.children && Array.isArray(node.children)) {
        walk(node.children as Array<{ children?: Array<unknown> }>);
      }
    }
  };
  walk(tree);
  return count;
}

/**
 * Collect distinct issueProvider values from a tree (recursive).
 * Defaults to 'github' for nodes without an explicit issueProvider.
 */
function collectProviders(nodes: Array<{ issueProvider?: string; children?: Array<unknown> }>): string[] {
  const providers: string[] = [];
  const walk = (list: Array<{ issueProvider?: string; children?: Array<unknown> }>): void => {
    for (const node of list) {
      providers.push(node.issueProvider ?? 'github');
      if (node.children && Array.isArray(node.children)) {
        walk(node.children as Array<{ issueProvider?: string; children?: Array<unknown> }>);
      }
    }
  };
  walk(nodes);
  return providers;
}

/**
 * Flatten an issue tree into a single-level array of all issues.
 */
function flattenIssueTree(nodes: Array<{ number: number; children: Array<unknown> }>): Array<{ number: number }> {
  const result: Array<{ number: number }> = [];
  const walk = (list: Array<{ number: number; children?: Array<unknown> }>): void => {
    for (const node of list) {
      result.push(node);
      if (node.children && Array.isArray(node.children)) {
        walk(node.children as Array<{ number: number; children?: Array<unknown> }>);
      }
    }
  };
  walk(nodes);
  return result;
}

/**
 * Get issue numbers for all active teams from the database.
 */
function getActiveTeamIssueNumbers(projectId?: number): number[] {
  try {
    const db = getDatabase();
    const activeTeams = projectId !== undefined
      ? db.getActiveTeamsByProject(projectId)
      : db.getActiveTeams();
    return activeTeams.map((t) => t.issueNumber);
  } catch {
    return [];
  }
}

/**
 * Get issue keys (strings) for all active teams from the database.
 * Filters out null keys (old teams that predate issueKey tracking).
 */
function getActiveTeamIssueKeys(projectId?: number): string[] {
  try {
    const db = getDatabase();
    const activeTeams = projectId !== undefined
      ? db.getActiveTeamsByProject(projectId)
      : db.getActiveTeams();
    return activeTeams
      .map((t) => t.issueKey)
      .filter((k): k is string => k !== null);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class IssueService {
  /**
   * Get the full issue hierarchy across all projects, enriched with team info.
   * Returns both a flat merged tree and per-project groups.
   *
   * @returns Issue tree with groups, cached timestamp, and count
   */
  async getAllIssues(): Promise<{
    tree: IssueNode[];
    groups: Array<{
      projectId: number;
      projectName: string;
      groupId: number | null;
      groupName: string | null;
      tree: IssueNode[];
      cachedAt: string | null;
      count: number;
      providers: string[];
    }>;
    cachedAt: string | null;
    count: number;
  }> {
    const fetcher = getIssueFetcher();
    const db = getDatabase();

    const projectCaches = fetcher.getIssuesByProject();
    const groups = await Promise.all(projectCaches.map(async (entry) => {
      const project = db.getProject(entry.projectId);
      const enriched = fetcher.enrichWithTeamInfo(entry.tree, entry.projectId);
      const groupId = project?.groupId ?? null;
      const group = groupId != null ? db.getProjectGroup(groupId) : undefined;
      const providers = [...new Set(collectProviders(enriched))];
      return {
        projectId: entry.projectId,
        projectName: project?.name ?? `Project #${entry.projectId}`,
        groupId,
        groupName: group?.name ?? null,
        tree: enriched,
        cachedAt: entry.cachedAt,
        count: countIssues(enriched),
        providers,
      };
    }));

    const allIssues = groups.flatMap((g) => g.tree);

    return {
      tree: allIssues,
      groups,
      cachedAt: fetcher.getCachedAt(),
      count: countIssues(allIssues),
    };
  }

  /**
   * Get the issue hierarchy for a specific project, enriched with team info.
   *
   * @param projectId - The project ID
   * @returns Per-project issue tree with metadata
   * @throws ServiceError with code VALIDATION if projectId is invalid
   * @throws ServiceError with code NOT_FOUND if project doesn't exist
   */
  async getProjectIssues(projectId: number): Promise<{
    projectId: number;
    projectName: string;
    tree: IssueNode[];
    cachedAt: string | null;
    count: number;
  }> {
    if (isNaN(projectId) || projectId < 1) {
      throw validationError('projectId must be a positive integer');
    }

    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) {
      throw notFoundError(`Project ${projectId} not found`);
    }

    const fetcher = getIssueFetcher();
    const issues = await fetcher.getIssues(projectId);

    const enriched = fetcher.enrichWithTeamInfo(issues, projectId);

    return {
      projectId,
      projectName: project.name,
      tree: enriched,
      cachedAt: fetcher.getCachedAt(projectId),
      count: countIssues(enriched),
    };
  }

  /**
   * Suggest the next issue to work on (highest-priority Ready issue with no active team).
   *
   * @returns The suggested issue, or null if none available
   */
  getNextIssue(): { issue: IssueNode | null; reason: string } {
    const fetcher = getIssueFetcher();
    const activeIssues = getActiveTeamIssueNumbers();
    const activeKeys = getActiveTeamIssueKeys();
    const nextIssue = fetcher.getNextIssue(activeIssues, undefined, activeKeys);

    if (!nextIssue) {
      return {
        issue: null,
        reason: 'No available Ready issues found without an active team',
      };
    }

    const [enriched] = fetcher.enrichWithTeamInfo([nextIssue]);

    return {
      issue: enriched,
      reason: 'Highest priority Ready issue with no active team',
    };
  }

  /**
   * Get all open leaf issues that have no team currently working on them.
   *
   * @returns Available issues with count
   */
  getAvailableIssues(): { issues: IssueNode[]; count: number } {
    const fetcher = getIssueFetcher();
    const activeIssues = getActiveTeamIssueNumbers();
    const activeKeys = getActiveTeamIssueKeys();
    const available = fetcher.getAvailableIssues(activeIssues, undefined, activeKeys);

    const enriched = fetcher.enrichWithTeamInfo(available);

    return {
      issues: enriched,
      count: enriched.length,
    };
  }

  /**
   * Get a single issue from the cache, enriched with team info.
   *
   * @param issueNumber - The issue number
   * @returns The enriched issue
   * @throws ServiceError with code VALIDATION if issue number is invalid
   * @throws ServiceError with code NOT_FOUND if issue not in cache
   */
  getIssue(issueNumber: number): IssueNode {
    if (isNaN(issueNumber) || issueNumber <= 0) {
      throw validationError('Issue number must be a positive integer');
    }

    const fetcher = getIssueFetcher();
    const issue = fetcher.getIssue(issueNumber);

    if (!issue) {
      throw notFoundError(
        `Issue #${issueNumber} not found in cache. Try POST /api/issues/refresh first.`,
      );
    }

    const [enriched] = fetcher.enrichWithTeamInfo([issue]);

    return enriched;
  }

  /**
   * Get a single issue by its string key (e.g. "42" for GitHub, "PROJ-123" for Jira).
   * Falls back to numeric lookup if the key is a purely numeric string.
   *
   * @param key - The issue key string
   * @returns The enriched issue
   * @throws ServiceError with code VALIDATION if key is empty
   * @throws ServiceError with code NOT_FOUND if issue not in cache
   */
  getIssueByKey(key: string): IssueNode {
    if (!key || typeof key !== 'string' || !key.trim()) {
      throw validationError('Issue key must be a non-empty string');
    }

    const fetcher = getIssueFetcher();
    const issue = fetcher.getIssueByKey(key.trim());

    if (!issue) {
      throw notFoundError(
        `Issue "${key}" not found in cache. Try POST /api/issues/refresh first.`,
      );
    }

    const [enriched] = fetcher.enrichWithTeamInfo([issue]);

    return enriched;
  }

  /**
   * Get dependencies for all issues in a project.
   *
   * @param projectId - The project ID
   * @returns Dependency info keyed by issue number
   * @throws ServiceError with code VALIDATION if projectId is invalid or project has no GitHub repo
   * @throws ServiceError with code NOT_FOUND if project doesn't exist
   */
  async getProjectDependencies(projectId: number): Promise<{
    projectId: number;
    dependencies: Record<number, unknown>;
  }> {
    if (isNaN(projectId) || projectId < 1) {
      throw validationError('projectId must be a positive integer');
    }

    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) {
      throw notFoundError(`Project ${projectId} not found`);
    }

    if (!project.githubRepo) {
      throw validationError(`Project ${projectId} has no GitHub repo configured`);
    }

    const fetcher = getIssueFetcher();
    const issues = await fetcher.getIssues(projectId);

    const allIssues = flattenIssueTree(issues as Array<{ number: number; children: Array<unknown> }>);
    const dependencies: Record<number, unknown> = {};

    for (const issue of allIssues) {
      const deps = await fetcher.fetchDependenciesForIssue(projectId, issue.number);
      if (deps) {
        dependencies[issue.number] = deps;
      }
    }

    return { projectId, dependencies };
  }

  /**
   * Get dependencies for a single issue.
   *
   * @param issueNumber - The issue number
   * @param projectId - The project ID
   * @returns Dependency info for the issue
   * @throws ServiceError with code VALIDATION for invalid input
   * @throws ServiceError with code NOT_FOUND if project doesn't exist
   */
  async getIssueDependencies(issueNumber: number, projectId: number): Promise<unknown> {
    if (isNaN(issueNumber) || issueNumber <= 0) {
      throw validationError('Issue number must be a positive integer');
    }

    if (isNaN(projectId) || projectId < 1) {
      throw validationError('projectId must be a positive integer');
    }

    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) {
      throw notFoundError(`Project ${projectId} not found`);
    }

    const fetcher = getIssueFetcher();
    const deps = await fetcher.fetchDependenciesForIssue(projectId, issueNumber);

    if (!deps) {
      return {
        issueNumber,
        blockedBy: [],
        resolved: true,
        openCount: 0,
      };
    }

    return deps;
  }

  /**
   * Force re-fetch from GitHub. Clears the cache and re-fetches the full hierarchy.
   *
   * @returns Refreshed issue tree with metadata
   */
  async refresh(): Promise<{
    refreshedAt: string | null;
    issueCount: number;
    tree: IssueNode[];
  }> {
    const fetcher = getIssueFetcher();
    const issues = await fetcher.refresh();

    const enriched = fetcher.enrichWithTeamInfo(issues);

    return {
      refreshedAt: fetcher.getCachedAt(),
      issueCount: countIssues(enriched),
      tree: enriched,
    };
  }

  /**
   * Compute the dependency-resolved execution plan for a project.
   * Shows issues grouped into waves based on dependency order and
   * maxActiveTeams slot limits.
   *
   * @param projectId - The project ID
   * @returns ExecutionPlan with wave assignments and circular dep warnings
   * @throws ServiceError with code VALIDATION if projectId is invalid
   * @throws ServiceError with code NOT_FOUND if project doesn't exist
   */
  async getExecutionPlan(projectId: number): Promise<ExecutionPlan> {
    if (isNaN(projectId) || projectId < 1) {
      throw validationError('projectId must be a positive integer');
    }

    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) {
      throw notFoundError(`Project ${projectId} not found`);
    }

    const fetcher = getIssueFetcher();
    const issues = await fetcher.getIssues(projectId);
    const enriched = fetcher.enrichWithTeamInfo(issues, projectId);

    // Flatten the tree to get all issues
    const allIssues = flattenIssueTree(
      enriched as Array<{ number: number; children: Array<unknown> }>,
    ) as IssueNode[];

    // Get active and queued teams from DB
    const activeTeams = db.getActiveTeamsByProject(projectId);
    const activeTeamMap = new Map(
      activeTeams.map((t) => [t.issueNumber, t]),
    );

    // Count non-queued active teams for slot calculation
    const activeCount = db.getActiveTeamCountByProject(projectId);

    // Build WaveIssue array from open issues that have a team or are potential work items
    const waveIssues: WaveIssue[] = [];

    for (const issue of allIssues) {
      // Only include open issues (closed issues are resolved)
      if (issue.state !== 'open') continue;

      // Skip parent issues (those with open children) — only leaf issues get teams
      const hasOpenChildren = issue.children.some((c) => c.state === 'open');
      if (hasOpenChildren) continue;

      const team = activeTeamMap.get(issue.number);

      // Compute open blockers: only include blockers that are still open (direct + inherited)
      const openBlockerSet = new Set<number>();
      if (issue.dependencies) {
        for (const dep of issue.dependencies.blockedBy) {
          if (dep.state === 'open') {
            openBlockerSet.add(dep.number);
          }
        }
        if (issue.dependencies.inheritedBlockedBy) {
          for (const dep of issue.dependencies.inheritedBlockedBy) {
            if (dep.state === 'open') {
              openBlockerSet.add(dep.number);
            }
          }
        }
      }
      const openBlockers = [...openBlockerSet];

      waveIssues.push({
        issueNumber: issue.number,
        issueKey: issue.issueKey,
        title: issue.title,
        state: issue.state,
        teamId: team?.id,
        teamStatus: team?.status,
        blockedBy: openBlockers,
        url: issue.url,
      });
    }

    // Compute waves
    const { waves, circularDeps } = computeWaves(
      waveIssues,
      project.maxActiveTeams,
      activeCount,
    );

    const totalQueued = waveIssues.filter((i) => !i.teamStatus || i.teamStatus === 'queued').length;

    return {
      waves,
      totalQueued,
      maxActiveTeams: project.maxActiveTeams,
      circularDeps,
      projectId,
      projectName: project.name,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: IssueService | null = null;

/**
 * Get the singleton IssueService instance.
 *
 * @returns IssueService singleton
 */
export function getIssueService(): IssueService {
  if (!_instance) {
    _instance = new IssueService();
  }
  return _instance;
}
