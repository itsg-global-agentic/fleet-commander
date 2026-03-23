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
      tree: IssueNode[];
      cachedAt: string | null;
      count: number;
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
      return {
        projectId: entry.projectId,
        projectName: project?.name ?? `Project #${entry.projectId}`,
        tree: enriched,
        cachedAt: entry.cachedAt,
        count: countIssues(enriched),
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
    const nextIssue = fetcher.getNextIssue(activeIssues);

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
    const available = fetcher.getAvailableIssues(activeIssues);

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
