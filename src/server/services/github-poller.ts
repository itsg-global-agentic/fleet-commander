// =============================================================================
// Fleet Commander — GitHub Poller Service (PR/CI Status via gh CLI)
// =============================================================================
// Polls GitHub every 30s (configurable) for PR state, CI status, and merge
// readiness. Detects new PRs by branch name. Updates the database and
// broadcasts changes via SSE.
//
// Per-project: each team's github_repo is resolved from its project record.
// Teams in paused/archived projects are skipped during polling.
//
// Uses `gh` CLI exclusively (never Octokit) as per project conventions.
// All gh CLI errors are handled gracefully — a single failed poll never
// crashes the service.
// =============================================================================

import { execSync } from 'child_process';
import { getDatabase } from '../db.js';
import config from '../config.js';
import { sseBroker } from './sse-broker.js';
import { resolveMessage } from '../utils/resolve-message.js';

// ---------------------------------------------------------------------------
// Types for gh CLI JSON output
// ---------------------------------------------------------------------------

interface GHCheckRun {
  name?: string;
  context?: string;
  conclusion?: string | null;
  status?: string;
  __typename?: string;
}

interface GHPRViewResult {
  number: number;
  title: string;
  state: string;
  mergeStateStatus?: string;
  statusCheckRollup?: GHCheckRun[] | null;
  mergedAt?: string | null;
  autoMergeRequest?: { enabledAt?: string } | null;
  headRefName?: string;
}

interface GHPRListItem {
  number: number;
}

// ---------------------------------------------------------------------------
// GitHub Poller
// ---------------------------------------------------------------------------

class GitHubPoller {
  private interval: NodeJS.Timeout | null = null;

  /**
   * Start the polling loop. Polls immediately after a short delay,
   * then every `config.githubPollIntervalMs` (default 30 000 ms).
   */
  start(): void {
    if (this.interval) {
      return; // already running
    }

    this.interval = setInterval(() => this.poll(), config.githubPollIntervalMs);
    // Allow Node.js to exit even if the interval is still active
    if (this.interval.unref) {
      this.interval.unref();
    }

    // Initial poll after a short delay so the server has time to finish setup
    const initialTimer = setTimeout(() => this.poll(), 5000);
    if (initialTimer.unref) {
      initialTimer.unref();
    }

    console.log(
      `[GitHubPoller] Started — polling every ${config.githubPollIntervalMs}ms across all active projects`
    );
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log('[GitHubPoller] Stopped');
    }
  }

  /**
   * Execute a single poll cycle. Iterates over all active projects,
   * then checks teams within each project.
   */
  async poll(): Promise<void> {
    const db = getDatabase();

    // Get all active projects — skip paused/archived
    const projects = db.getProjects({ status: 'active' });

    if (projects.length === 0) {
      // No projects configured — nothing to poll
      return;
    }

    // Build a map of projectId -> githubRepo for quick lookup
    const projectRepoMap = new Map<number, string>();
    for (const project of projects) {
      if (project.githubRepo) {
        projectRepoMap.set(project.id, project.githubRepo);
      }
    }

    const teams = db.getActiveTeams();

    for (const team of teams) {
      try {
        // Resolve the github repo for this team's project
        const githubRepo = team.projectId ? projectRepoMap.get(team.projectId) : undefined;
        if (!githubRepo) {
          // Team has no project or project is not active — skip
          continue;
        }

        if (team.prNumber) {
          await this.pollPR(team.prNumber, team.id, githubRepo);
        } else if (team.branchName) {
          this.detectPR(team.branchName, team.id, githubRepo);
        }
      } catch (err) {
        // Log and continue — never let one team's failure stop the others
        console.error(
          `[GitHubPoller] Error polling team ${team.id} (issue #${team.issueNumber}, project ${team.projectId}):`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private: poll an existing PR
  // -------------------------------------------------------------------------

  private async pollPR(prNumber: number, teamId: number, githubRepo: string): Promise<void> {
    // Use gh pr view to get PR status, CI checks, merge state, and auto-merge
    const result = this.execGH(
      `gh pr view ${prNumber} --repo ${githubRepo} ` +
        `--json number,title,state,mergeStateStatus,statusCheckRollup,autoMergeRequest,headRefName,mergedAt`
    );
    if (!result) return; // gh CLI failed — skip this cycle

    let data: GHPRViewResult;
    try {
      data = JSON.parse(result);
    } catch {
      console.error(`[GitHubPoller] Failed to parse gh output for PR #${prNumber}`);
      return;
    }

    const db = getDatabase();
    const existing = db.getPullRequest(prNumber);

    // Map GitHub state to our state — detect merged via mergedAt field
    const isMerged = !!data.mergedAt;
    const state = isMerged ? 'merged' : (data.state?.toLowerCase() ?? 'open');
    const mergeState = data.mergeStateStatus?.toLowerCase() ?? 'unknown';

    // Derive CI status from statusCheckRollup
    const checks: GHCheckRun[] = data.statusCheckRollup ?? [];
    const ciStatus = this.deriveCIStatus(checks);

    const autoMerge = !!data.autoMergeRequest;
    const checksJson = JSON.stringify(checks);
    const title = data.title ?? `PR #${prNumber}`;

    // Count unique CI failures — cumulative (only goes up or resets to 0 on green)
    let ciFailCount = existing?.ciFailCount ?? 0;
    if (ciStatus === 'passing') {
      // Reset failure count when CI is green
      ciFailCount = 0;
    } else if (ciStatus === 'failing') {
      const currentUniqueFailures = new Set(
        checks
          .filter((c) => c.conclusion === 'FAILURE' || c.conclusion === 'CANCELLED')
          .map((c) => c.name || c.context || 'unknown')
      ).size;
      ciFailCount = Math.max(existing?.ciFailCount ?? 0, currentUniqueFailures);
    }

    const prData = {
      state,
      ciStatus,
      mergeStatus: mergeState,
      autoMerge,
      ciFailCount,
      checksJson,
    };

    if (existing) {
      // Only update + broadcast if something actually changed
      const changed =
        existing.state !== state ||
        existing.ciStatus !== ciStatus ||
        existing.mergeStatus !== mergeState ||
        existing.autoMerge !== autoMerge ||
        existing.ciFailCount !== ciFailCount;

      if (changed) {
        db.updatePullRequest(prNumber, prData);
        sseBroker.broadcast(
          'pr_updated',
          {
            pr_number: prNumber,
            team_id: teamId,
            state,
            ci_status: ciStatus,
            merge_status: mergeState,
            auto_merge: autoMerge,
            ci_fail_count: ciFailCount,
          },
          teamId
        );
        console.log(
          `[GitHubPoller] PR #${prNumber} updated — state=${state} ci=${ciStatus} merge=${mergeState} (repo: ${githubRepo})`
        );

        // Notify the team via stdin when CI status changes
        if (existing.ciStatus !== ciStatus) {
          try {
            const { getTeamManager } = await import('./team-manager.js');
            const manager = getTeamManager();

            let msg: string | null = null;
            if (ciStatus === 'passing') {
              msg = resolveMessage('ci_green', {
                PR_NUMBER: String(prNumber),
                AUTO_MERGE_STATUS: autoMerge ? 'enabled' : 'not enabled',
              });
            } else if (ciStatus === 'failing') {
              const failedCheckNames = checks
                .filter((c) => c.conclusion === 'FAILURE')
                .map((c) => c.name || c.context || 'unknown')
                .join(', ');
              msg = resolveMessage('ci_red', {
                PR_NUMBER: String(prNumber),
                FAILED_CHECKS: failedCheckNames,
                FAIL_COUNT: String(ciFailCount),
                MAX_FAILURES: String(config.maxUniqueCiFailures),
              });
            }
            if (msg) manager.sendMessage(teamId, msg);
          } catch (err) {
            console.error(`[GitHubPoller] Failed to send CI notification to team ${teamId}:`, err);
          }
        }

        // Notify team when PR is merged
        if (isMerged && existing.state !== 'merged') {
          try {
            const { getTeamManager } = await import('./team-manager.js');
            const manager = getTeamManager();
            const msg = resolveMessage('pr_merged', {
              PR_NUMBER: String(prNumber),
            });
            if (msg) manager.sendMessage(teamId, msg);
          } catch (err) {
            console.error(`[GitHubPoller] Failed to send merge notification to team ${teamId}:`, err);
          }
        }
      }
    } else {
      // First time we see this PR — insert it
      db.insertPullRequest({
        prNumber,
        teamId,
        title,
        ...prData,
      });
      sseBroker.broadcast(
        'pr_updated',
        {
          pr_number: prNumber,
          team_id: teamId,
          state,
          ci_status: ciStatus,
          merge_status: mergeState,
          auto_merge: autoMerge,
          ci_fail_count: ciFailCount,
        },
        teamId
      );
      console.log(
        `[GitHubPoller] PR #${prNumber} discovered — state=${state} ci=${ciStatus} (repo: ${githubRepo})`
      );
    }

    // If the PR was merged, update the team status to 'done'
    if (state === 'merged') {
      const team = db.getTeam(teamId);
      if (team && team.status !== 'done') {
        const previousStatus = team.status;
        db.updateTeam(teamId, { status: 'done', phase: 'done' });
        sseBroker.broadcast(
          'team_status_changed',
          {
            team_id: teamId,
            status: 'done',
            previous_status: previousStatus,
          },
          teamId
        );
        console.log(
          `[GitHubPoller] Team ${teamId} marked done — PR #${prNumber} merged`
        );
      }

      // Record merged_at timestamp on the PR
      db.updatePullRequest(prNumber, {
        mergedAt: new Date().toISOString(),
      });

      // Graceful close is handled by team-manager, not here
    }

    // If CI has exceeded the maximum unique failure threshold, mark team as blocked + stuck
    if (
      ciFailCount >= config.maxUniqueCiFailures &&
      ciStatus === 'failing'
    ) {
      const team = db.getTeam(teamId);
      if (team && team.phase !== 'blocked') {
        const previousStatus = team.status;
        db.updateTeam(teamId, { phase: 'blocked', status: 'stuck' });

        sseBroker.broadcast(
          'team_status_changed',
          {
            team_id: teamId,
            status: 'stuck',
            previous_status: previousStatus,
            phase: 'blocked',
            reason: `${ciFailCount} unique CI failures`,
          },
          teamId,
        );

        console.log(
          `[GitHubPoller] Team ${teamId} marked blocked+stuck — ${ciFailCount} unique CI failures`
        );

        // Tell the team they are blocked
        try {
          const { getTeamManager } = await import('./team-manager.js');
          const manager = getTeamManager();
          const msg = resolveMessage('ci_blocked', {
            PR_NUMBER: String(prNumber),
            FAIL_COUNT: String(ciFailCount),
          });
          if (msg) manager.sendMessage(teamId, msg);
        } catch (err) {
          console.error(`[GitHubPoller] Failed to send blocked notification to team ${teamId}:`, err);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private: detect a PR for a branch that doesn't have one yet
  // -------------------------------------------------------------------------

  private detectPR(branchName: string, teamId: number, githubRepo: string): void {
    const result = this.execGH(
      `gh pr list --head ${branchName} --repo ${githubRepo} --json number --limit 1`
    );
    if (!result) return; // gh CLI failed — skip

    let prs: GHPRListItem[];
    try {
      prs = JSON.parse(result);
    } catch {
      return;
    }

    if (prs.length > 0 && prs[0]!.number) {
      const db = getDatabase();
      db.updateTeam(teamId, { prNumber: prs[0]!.number });
      console.log(
        `[GitHubPoller] Detected PR #${prs[0]!.number} for branch "${branchName}" (team ${teamId}, repo: ${githubRepo})`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private: derive CI status from check runs
  // -------------------------------------------------------------------------

  private deriveCIStatus(checks: GHCheckRun[]): string {
    if (checks.length === 0) return 'none';

    const allPassed = checks.every(
      (c) =>
        c.conclusion === 'SUCCESS' ||
        c.conclusion === 'NEUTRAL' ||
        c.conclusion === 'SKIPPED'
    );
    const anyFailed = checks.some(
      (c) => c.conclusion === 'FAILURE' || c.conclusion === 'CANCELLED'
    );
    const anyPending = checks.some(
      (c) => !c.conclusion || c.conclusion === 'PENDING' || c.status === 'IN_PROGRESS'
    );

    if (allPassed) return 'passing';
    if (anyFailed) return 'failing';
    if (anyPending) return 'pending';

    // Fallback for edge cases (e.g. all NEUTRAL / SKIPPED but also STALE)
    return 'pending';
  }

  // -------------------------------------------------------------------------
  // Private: execute a gh CLI command safely
  // -------------------------------------------------------------------------

  /**
   * Execute a `gh` CLI command and return stdout, or `null` on error.
   * Errors are logged but never thrown — the caller decides how to proceed.
   */
  private execGH(command: string): string | null {
    try {
      return execSync(command, {
        encoding: 'utf-8',
        timeout: 15_000, // 15 seconds — generous timeout for slow connections
        stdio: ['pipe', 'pipe', 'pipe'], // capture stderr too
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Only log if it's not a "no PRs found" type error
      if (!message.includes('no pull requests match')) {
        console.error(`[GitHubPoller] gh CLI error: ${message.slice(0, 200)}`);
      }
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const githubPoller = new GitHubPoller();
