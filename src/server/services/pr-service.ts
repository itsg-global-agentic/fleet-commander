// =============================================================================
// Fleet Commander — PR Service
// =============================================================================
// Manages pull request operations: auto-merge enable/disable, branch updates.
// All GitHub operations use the `gh` CLI (never Octokit) per project conventions.
// =============================================================================

import { getDatabase } from '../db.js';
import { sseBroker } from './sse-broker.js';
import { githubPoller } from './github-poller.js';
import { execGHResult, isValidGithubRepo } from '../utils/exec-gh.js';
import { ServiceError, notFoundError, validationError, externalError } from './service-error.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the github_repo for a PR by looking up the team's project.
 * Throws ServiceError if the PR, team, or project cannot be found.
 */
function resolveGithubRepoForPR(prNumber: number): { githubRepo: string; teamId: number } {
  const db = getDatabase();
  const pr = db.getPullRequest(prNumber);
  if (!pr || !pr.teamId) {
    throw notFoundError(
      `Cannot resolve GitHub repo for PR #${prNumber} — team or project not found`,
    );
  }

  const team = db.getTeam(pr.teamId);
  if (!team || !team.projectId) {
    throw notFoundError(
      `Cannot resolve GitHub repo for PR #${prNumber} — team or project not found`,
    );
  }

  const project = db.getProject(team.projectId);
  if (!project?.githubRepo) {
    throw notFoundError(
      `Cannot resolve GitHub repo for PR #${prNumber} — team or project not found`,
    );
  }

  if (!isValidGithubRepo(project.githubRepo)) {
    throw validationError(`Invalid GitHub repo slug: ${project.githubRepo}`);
  }

  return { githubRepo: project.githubRepo, teamId: pr.teamId };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class PRService {
  /**
   * Enable auto-merge (squash) for a pull request via gh CLI.
   * Updates the DB record and broadcasts an SSE event.
   *
   * @param prNumber - The PR number to enable auto-merge on
   * @returns Success result with output from gh CLI
   * @throws ServiceError if PR/repo not found or gh CLI fails
   */
  async enableAutoMerge(prNumber: number): Promise<{ ok: boolean; message: string; output: string }> {
    const { githubRepo, teamId } = resolveGithubRepoForPR(prNumber);

    const result = await execGHResult(
      `gh pr merge ${prNumber} --auto --squash --repo "${githubRepo}"`,
    );

    if (!result.ok) {
      throw externalError(
        `Failed to enable auto-merge for PR #${prNumber}`,
        result.error,
      );
    }

    // Update the database record
    const db = getDatabase();
    const pr = db.getPullRequest(prNumber);
    if (pr) {
      db.updatePullRequest(prNumber, { autoMerge: true });
    }

    // Broadcast SSE event
    sseBroker.broadcast(
      'pr_updated',
      {
        pr_number: prNumber,
        team_id: pr?.teamId ?? 0,
        action: 'auto_merge_enabled',
        auto_merge: true,
      },
      pr?.teamId ?? undefined,
    );

    return {
      ok: true,
      message: `Auto-merge enabled for PR #${prNumber}`,
      output: result.stdout?.trim() ?? '',
    };
  }

  /**
   * Disable auto-merge for a pull request via gh CLI.
   * Updates the DB record and broadcasts an SSE event.
   *
   * @param prNumber - The PR number to disable auto-merge on
   * @returns Success result with output from gh CLI
   * @throws ServiceError if PR/repo not found or gh CLI fails
   */
  async disableAutoMerge(prNumber: number): Promise<{ ok: boolean; message: string; output: string }> {
    const { githubRepo, teamId } = resolveGithubRepoForPR(prNumber);

    const result = await execGHResult(
      `gh pr merge ${prNumber} --disable-auto --repo "${githubRepo}"`,
    );

    if (!result.ok) {
      throw externalError(
        `Failed to disable auto-merge for PR #${prNumber}`,
        result.error,
      );
    }

    // Update the database record
    const db = getDatabase();
    const pr = db.getPullRequest(prNumber);
    if (pr) {
      db.updatePullRequest(prNumber, { autoMerge: false });
    }

    // Broadcast SSE event
    sseBroker.broadcast(
      'pr_updated',
      {
        pr_number: prNumber,
        team_id: pr?.teamId ?? 0,
        action: 'auto_merge_disabled',
        auto_merge: false,
      },
      pr?.teamId ?? undefined,
    );

    return {
      ok: true,
      message: `Auto-merge disabled for PR #${prNumber}`,
      output: result.stdout?.trim() ?? '',
    };
  }

  /**
   * Update a PR's branch to be current with the base branch via GitHub API.
   * Broadcasts an SSE event on success.
   *
   * @param prNumber - The PR number whose branch to update
   * @returns Success result with output from gh CLI
   * @throws ServiceError if PR/repo not found or gh CLI fails
   */
  async updateBranch(prNumber: number): Promise<{ ok: boolean; message: string; output: string }> {
    const { githubRepo, teamId } = resolveGithubRepoForPR(prNumber);

    const result = await execGHResult(
      `gh api "repos/${githubRepo}/pulls/${prNumber}/update-branch" -X PUT`,
    );

    if (!result.ok) {
      throw externalError(
        `Failed to update branch for PR #${prNumber}`,
        result.error,
      );
    }

    // Broadcast SSE event
    const db = getDatabase();
    const pr = db.getPullRequest(prNumber);

    sseBroker.broadcast(
      'pr_updated',
      {
        pr_number: prNumber,
        team_id: pr?.teamId ?? 0,
        action: 'branch_updated',
      },
      pr?.teamId ?? undefined,
    );

    return {
      ok: true,
      message: `Branch updated for PR #${prNumber}`,
      output: result.stdout?.trim() ?? '',
    };
  }

  /**
   * List all tracked pull requests.
   *
   * @returns Array of all PR records
   */
  listPRs(): unknown[] {
    const db = getDatabase();
    return db.getAllPullRequests();
  }

  /**
   * Get a single PR detail with checks_json parsed into a proper array.
   *
   * @param prNumber - The PR number
   * @returns PR record with parsed checks array
   * @throws ServiceError with code VALIDATION if prNumber is invalid
   * @throws ServiceError with code NOT_FOUND if PR doesn't exist
   */
  getPRDetail(prNumber: number): unknown {
    if (isNaN(prNumber) || prNumber < 1) {
      throw validationError('Invalid PR number');
    }

    const db = getDatabase();
    const pr = db.getPullRequest(prNumber);
    if (!pr) {
      throw notFoundError(`PR #${prNumber} not found`);
    }

    let checks: unknown[] = [];
    if (pr.checksJson) {
      try {
        checks = JSON.parse(pr.checksJson);
      } catch {
        checks = [];
      }
    }

    return {
      ...pr,
      checks,
    };
  }

  /**
   * Trigger an immediate GitHub poller poll.
   * The poll runs asynchronously; this returns immediately.
   *
   * @returns Success acknowledgment
   */
  triggerRefresh(): { ok: boolean; message: string } {
    githubPoller.poll().catch((err) => {
      console.error('[PRService] Poll failed:', err instanceof Error ? err.message : err);
    });

    return {
      ok: true,
      message: 'GitHub poller poll triggered',
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: PRService | null = null;

/**
 * Get the singleton PRService instance.
 *
 * @returns PRService singleton
 */
export function getPRService(): PRService {
  if (!_instance) {
    _instance = new PRService();
  }
  return _instance;
}
