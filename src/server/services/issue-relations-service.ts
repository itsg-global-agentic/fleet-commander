// =============================================================================
// Fleet Commander -- Issue Relations Service
// =============================================================================
// Business logic for issue relations CRUD (parent/child, blockedBy/blocking).
// Implements the write-through pattern: call provider mutation -> on success
// update cache surgically -> broadcast SSE event. On failure the cache is NOT
// touched and the error propagates to the caller.
// =============================================================================

import type { IssueRelations } from '../../shared/issue-provider.js';
import { getDatabase } from '../db.js';
import { getIssueProvider } from '../providers/index.js';
import { GitHubIssueProvider } from '../providers/github-issue-provider.js';
import { JiraIssueProvider } from '../providers/jira-issue-provider.js';
import { getIssueFetcher } from './issue-fetcher.js';
import { sseBroker } from './sse-broker.js';
import { validationError, notFoundError, externalError } from './service-error.js';

// ---------------------------------------------------------------------------
// Helper: resolve GitHub owner/repo from project's issue sources
// ---------------------------------------------------------------------------

interface GitHubContext {
  owner: string;
  repo: string;
}

function resolveGitHubContext(projectId: number): GitHubContext {
  const db = getDatabase();
  const project = db.getProject(projectId);
  if (!project) {
    throw notFoundError(`Project ${projectId} not found`);
  }

  // Check issue sources first
  const sources = db.getIssueSources(projectId, true);
  for (const source of sources) {
    if (source.provider === 'github') {
      try {
        const config = JSON.parse(source.configJson) as { owner?: string; repo?: string };
        if (config.owner && config.repo) {
          return { owner: config.owner, repo: config.repo };
        }
      } catch {
        // malformed config — skip
      }
    }
  }

  // Fallback to project.githubRepo
  if (project.githubRepo) {
    const parts = project.githubRepo.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { owner: parts[0], repo: parts[1] };
    }
  }

  throw validationError(`No GitHub owner/repo configured for project ${projectId}`);
}

// ---------------------------------------------------------------------------
// Issue Relations Service
// ---------------------------------------------------------------------------

class IssueRelationsService {

  /**
   * Get all relations for an issue.
   */
  async getRelations(projectId: number, issueKey: string): Promise<IssueRelations> {
    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) throw notFoundError(`Project ${projectId} not found`);
    if (!issueKey) throw validationError('issueKey is required');

    const provider = getIssueProvider(project);

    try {
      if (provider instanceof GitHubIssueProvider) {
        const { owner, repo } = resolveGitHubContext(projectId);
        return await provider.getRelationsGH(owner, repo, issueKey);
      }

      if (provider instanceof JiraIssueProvider) {
        return await provider.getRelationsJira(issueKey);
      }

      throw validationError(`Provider "${provider.name}" does not support relations`);
    } catch (err) {
      if (err instanceof Error && err.name === 'ServiceError') throw err;
      throw externalError(
        `Failed to get relations for ${issueKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Add a blockedBy relation. Write-through: mutation -> cache update -> SSE.
   */
  async addBlockedBy(projectId: number, issueKey: string, blockerKey: string): Promise<void> {
    this.validateKeys(issueKey, blockerKey, 'blockerKey');

    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) throw notFoundError(`Project ${projectId} not found`);

    const provider = getIssueProvider(project);

    try {
      if (provider instanceof GitHubIssueProvider) {
        const { owner, repo } = resolveGitHubContext(projectId);
        await provider.addBlockedByGH(owner, repo, issueKey, blockerKey);
      } else if (provider instanceof JiraIssueProvider) {
        await provider.addBlockedByJira(issueKey, blockerKey);
      } else {
        throw validationError(`Provider "${provider.name}" does not support addBlockedBy`);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'ServiceError') throw err;
      throw externalError(
        `Failed to add blockedBy relation: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Write-through: update cache and broadcast
    await this.refreshAndBroadcast(projectId, issueKey);
  }

  /**
   * Remove a blockedBy relation. Write-through.
   */
  async removeBlockedBy(projectId: number, issueKey: string, blockerKey: string): Promise<void> {
    this.validateKeys(issueKey, blockerKey, 'blockerKey');

    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) throw notFoundError(`Project ${projectId} not found`);

    const provider = getIssueProvider(project);

    try {
      if (provider instanceof GitHubIssueProvider) {
        const { owner, repo } = resolveGitHubContext(projectId);
        await provider.removeBlockedByGH(owner, repo, issueKey, blockerKey);
      } else if (provider instanceof JiraIssueProvider) {
        await provider.removeBlockedByJira(issueKey, blockerKey);
      } else {
        throw validationError(`Provider "${provider.name}" does not support removeBlockedBy`);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'ServiceError') throw err;
      throw externalError(
        `Failed to remove blockedBy relation: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await this.refreshAndBroadcast(projectId, issueKey);
  }

  /**
   * Set the parent of an issue. Write-through.
   */
  async setParent(projectId: number, issueKey: string, parentKey: string): Promise<void> {
    this.validateKeys(issueKey, parentKey, 'parentKey');

    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) throw notFoundError(`Project ${projectId} not found`);

    const provider = getIssueProvider(project);

    try {
      if (provider instanceof GitHubIssueProvider) {
        const { owner, repo } = resolveGitHubContext(projectId);
        await provider.setParentGH(owner, repo, issueKey, parentKey);
      } else if (provider instanceof JiraIssueProvider) {
        await provider.setParentJira(issueKey, parentKey);
      } else {
        throw validationError(`Provider "${provider.name}" does not support setParent`);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'ServiceError') throw err;
      throw externalError(
        `Failed to set parent: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await this.refreshAndBroadcast(projectId, issueKey);
  }

  /**
   * Remove the parent from an issue. Write-through.
   */
  async removeParent(projectId: number, issueKey: string): Promise<void> {
    if (!issueKey) throw validationError('issueKey is required');

    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) throw notFoundError(`Project ${projectId} not found`);

    const provider = getIssueProvider(project);

    try {
      if (provider instanceof GitHubIssueProvider) {
        const { owner, repo } = resolveGitHubContext(projectId);
        await provider.removeParentGH(owner, repo, issueKey);
      } else if (provider instanceof JiraIssueProvider) {
        await provider.removeParentJira(issueKey);
      } else {
        throw validationError(`Provider "${provider.name}" does not support removeParent`);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'ServiceError') throw err;
      throw externalError(
        `Failed to remove parent: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await this.refreshAndBroadcast(projectId, issueKey);
  }

  /**
   * Add a child to a parent issue. Write-through.
   */
  async addChild(projectId: number, parentKey: string, childKey: string): Promise<void> {
    this.validateKeys(parentKey, childKey, 'childKey');

    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) throw notFoundError(`Project ${projectId} not found`);

    const provider = getIssueProvider(project);

    try {
      if (provider instanceof GitHubIssueProvider) {
        const { owner, repo } = resolveGitHubContext(projectId);
        await provider.addChildGH(owner, repo, parentKey, childKey);
      } else if (provider instanceof JiraIssueProvider) {
        await provider.addChildJira(parentKey, childKey);
      } else {
        throw validationError(`Provider "${provider.name}" does not support addChild`);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'ServiceError') throw err;
      throw externalError(
        `Failed to add child: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await this.refreshAndBroadcast(projectId, parentKey);
  }

  /**
   * Remove a child from a parent issue. Write-through.
   */
  async removeChild(projectId: number, parentKey: string, childKey: string): Promise<void> {
    this.validateKeys(parentKey, childKey, 'childKey');

    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) throw notFoundError(`Project ${projectId} not found`);

    const provider = getIssueProvider(project);

    try {
      if (provider instanceof GitHubIssueProvider) {
        const { owner, repo } = resolveGitHubContext(projectId);
        await provider.removeChildGH(owner, repo, parentKey, childKey);
      } else if (provider instanceof JiraIssueProvider) {
        await provider.removeChildJira(parentKey, childKey);
      } else {
        throw validationError(`Provider "${provider.name}" does not support removeChild`);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'ServiceError') throw err;
      throw externalError(
        `Failed to remove child: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await this.refreshAndBroadcast(projectId, parentKey);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Validate that required keys are non-empty strings.
   */
  private validateKeys(primaryKey: string, secondaryKey: string, secondaryName: string): void {
    if (!primaryKey) throw validationError('issueKey is required');
    if (!secondaryKey) throw validationError(`${secondaryName} is required`);
  }

  /**
   * After a successful mutation: fetch updated relations, update the cache
   * surgically, and broadcast via SSE.
   */
  private async refreshAndBroadcast(projectId: number, issueKey: string): Promise<void> {
    try {
      const relations = await this.getRelations(projectId, issueKey);

      // Surgical cache update (synchronous, no network)
      getIssueFetcher().updateIssueDependencies(projectId, issueKey, relations);

      // Broadcast SSE
      sseBroker.broadcast('relations_updated', {
        project_id: projectId,
        issue_key: issueKey,
        relations,
      });
    } catch (err) {
      // Non-fatal: the mutation succeeded, just the cache update or SSE broadcast failed
      console.warn(
        `[IssueRelationsService] Post-mutation refresh failed for ${issueKey}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: IssueRelationsService | null = null;

export function getIssueRelationsService(): IssueRelationsService {
  if (!_instance) {
    _instance = new IssueRelationsService();
  }
  return _instance;
}

export default IssueRelationsService;
