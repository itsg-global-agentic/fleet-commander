// =============================================================================
// Fleet Commander — GitHub Poller Service (PR/CI Status via gh CLI)
// =============================================================================
// Polls GitHub every 30s (configurable) for PR state, CI status, and merge
// readiness. Detects new PRs by branch name. Updates the database and
// broadcasts changes via SSE.
//
// Per-project: each team's github_repo is resolved from its project record.
// Teams in archived projects are skipped during polling.
//
// Uses `gh` CLI exclusively (never Octokit) as per project conventions.
// All gh CLI errors are handled gracefully — a single failed poll never
// crashes the service.
// =============================================================================

import path from 'path';
import { getDatabase } from '../db.js';
import config from '../config.js';
import { sseBroker } from './sse-broker.js';
import { resolveMessage } from '../utils/resolve-message.js';
import { execGHAsync, execGitAsync, isValidGithubRepo, isValidBranchName } from '../utils/exec-gh.js';
import type { PRState, CIStatus, MergeStatus } from '../../shared/types.js';

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
// Shared CI failure predicate — used by deriveCIStatus, ciFailCount, and
// failedCheckNames so that all three agree on what counts as a "failure".
// ---------------------------------------------------------------------------

function isFailureConclusion(conclusion: string | null | undefined): boolean {
  return conclusion === 'FAILURE' || conclusion === 'CANCELLED';
}

// ---------------------------------------------------------------------------
// GitHub Poller
// ---------------------------------------------------------------------------

class GitHubPoller {
  private interval: NodeJS.Timeout | null = null;

  /** Whether any team needs fast polling (pending CI or awaiting PR detection) */
  private needsFastPoll = false;

  /** Guard against concurrent poll() invocations */
  private isPolling = false;

  /**
   * In-memory tracking of previously-blocked issues.
   * Maps "projectId:issueNumber" -> array of blocking issue numbers.
   * Used to detect when all blockers close so we can broadcast dependency_resolved.
   * Lost on restart, which is acceptable since we do NOT auto-launch.
   */
  private previouslyBlocked = new Map<string, { projectId: number; issueNumber: number; blockerNumbers: number[] }>();

  /**
   * Start the polling loop. Uses adaptive intervals:
   * - Normal: config.githubPollIntervalMs (default 30s)
   * - Fast: 10s when teams are awaiting PR detection or have pending CI
   */
  start(): void {
    if (this.interval) {
      return; // already running
    }

    // Reseed blocked issues from DB so dependency resolution detection
    // survives server restarts
    this.reseedBlockedFromDb();

    this.scheduleNextPoll();

    // Initial poll after a short delay so the server has time to finish setup
    const initialTimer = setTimeout(() => this.poll(), 5000);
    if (initialTimer.unref) {
      initialTimer.unref();
    }

    console.log(
      `[GitHubPoller] Started — base interval ${config.githubPollIntervalMs}ms, fast 10s when PRs pending`
    );
  }

  /** Schedule the next poll with adaptive interval */
  private scheduleNextPoll(): void {
    if (this.interval) {
      clearTimeout(this.interval);
    }
    const delay = this.needsFastPoll
      ? Math.min(10_000, config.githubPollIntervalMs)
      : config.githubPollIntervalMs;
    this.interval = setTimeout(() => {
      this.poll().finally(() => this.scheduleNextPoll());
    }, delay);
    if (this.interval.unref) {
      this.interval.unref();
    }
  }

  /** Trigger an immediate extra poll (e.g. after a PR is detected) */
  triggerPoll(): void {
    // Run poll in background, don't wait
    this.poll().catch((err) => {
      console.error('[GitHubPoller] triggerPoll error:', err instanceof Error ? err.message : err);
    });
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    if (this.interval) {
      clearTimeout(this.interval);
      this.interval = null;
      console.log('[GitHubPoller] Stopped');
    }
  }

  /**
   * Execute a single poll cycle. Iterates over all active projects,
   * then checks teams within each project.
   */
  async poll(): Promise<void> {
    if (this.isPolling) {
      console.log('[GitHubPoller] Skipping poll — previous cycle still running');
      return;
    }
    this.isPolling = true;

    try {
      const db = getDatabase();

      // Get all active projects — skip archived
      const projects = db.getProjects({ status: 'active' });

      if (projects.length === 0) {
        // No projects configured — nothing to poll
        return;
      }

      // Build maps of projectId -> githubRepo and projectId -> repoPath
      const projectRepoMap = new Map<number, string>();
      const projectPathMap = new Map<number, string>();
      for (const project of projects) {
        if (project.githubRepo) {
          projectRepoMap.set(project.id, project.githubRepo);
        }
        if (project.repoPath) {
          projectPathMap.set(project.id, project.repoPath);
        }
      }

      const teams = db.getActiveTeams();
      let wantFast = false;

      for (const team of teams) {
        try {
          // Resolve the github repo for this team's project
          const githubRepo = team.projectId ? projectRepoMap.get(team.projectId) : undefined;
          if (!githubRepo) {
            // Team has no project or project is not active — skip
            continue;
          }

          // Check the actual worktree branch and update DB if it differs.
          // The agent may have renamed the branch after launch.
          if (team.projectId && !team.prNumber) {
            const repoPath = projectPathMap.get(team.projectId);
            if (repoPath && team.worktreeName) {
              const actualBranch = await this.detectWorktreeBranch(repoPath, team.worktreeName);
              if (actualBranch && actualBranch !== team.branchName) {
                console.log(
                  `[GitHubPoller] Branch name updated for team ${team.id}: "${team.branchName}" -> "${actualBranch}"`
                );
                db.updateTeam(team.id, { branchName: actualBranch });
                team.branchName = actualBranch;
              }
            }
          }

          if (team.prNumber) {
            const pr = await this.pollPR(team.prNumber, team.id, githubRepo);
            // Fast-poll when CI is pending
            if (pr && (pr.ciStatus === 'pending' || pr.state === 'open')) {
              wantFast = true;
            }
          } else if (team.branchName) {
            // Fast-poll when awaiting PR detection
            wantFast = true;
            await this.detectPR(team.branchName, team.id, githubRepo);
          }
        } catch (err) {
          // Log and continue — never let one team's failure stop the others
          console.error(
            `[GitHubPoller] Error polling team ${team.id} (issue #${team.issueNumber}, project ${team.projectId}):`,
            err instanceof Error ? err.message : err
          );
        }
      }

      this.needsFastPoll = wantFast;

      // Check dependency resolution for previously-blocked issues
      await this.checkDependencyResolution();
    } finally {
      this.isPolling = false;
    }
  }

  // -------------------------------------------------------------------------
  // Private: poll an existing PR
  // -------------------------------------------------------------------------

  private async pollPR(prNumber: number, teamId: number, githubRepo: string): Promise<{ ciStatus: CIStatus; state: PRState } | null> {
    if (!isValidGithubRepo(githubRepo)) {
      console.warn(`[GitHubPoller] Skipping pollPR for team ${teamId} — invalid githubRepo: ${githubRepo}`);
      return null;
    }

    // Use gh pr view to get PR status, CI checks, merge state, and auto-merge
    const result = await execGHAsync(
      `gh pr view ${prNumber} --repo "${githubRepo}" ` +
        `--json number,title,state,mergeStateStatus,statusCheckRollup,autoMergeRequest,headRefName,mergedAt`
    );
    if (!result) return null; // gh CLI failed — skip this cycle

    let data: GHPRViewResult;
    try {
      data = JSON.parse(result);
    } catch {
      console.error(`[GitHubPoller] Failed to parse gh output for PR #${prNumber}`);
      return null;
    }

    const db = getDatabase();
    const existing = db.getPullRequest(prNumber);

    // Map GitHub state to our state — detect merged via mergedAt field
    const isMerged = !!data.mergedAt;
    const rawState = data.state?.toLowerCase() ?? 'open';
    const state: PRState = isMerged ? 'merged' : (['draft', 'open', 'merged', 'closed'].includes(rawState) ? rawState as PRState : 'open');
    const rawMerge = data.mergeStateStatus?.toLowerCase() ?? 'unknown';
    const mergeState: MergeStatus = (['clean', 'behind', 'blocked', 'dirty', 'unstable', 'has_hooks', 'draft', 'unknown'].includes(rawMerge) ? rawMerge as MergeStatus : 'unknown');

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
          .filter((c) => isFailureConclusion(c.conclusion))
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

        // PR status changes count as team activity — update lastEventAt
        // so the stuck-detector knows the team is not truly idle.
        db.updateTeam(teamId, { lastEventAt: new Date().toISOString() });

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
            let ciSubtype: string | undefined;
            if (ciStatus === 'passing') {
              if (mergeState === 'dirty') {
                msg = resolveMessage('ci_green_but_dirty', {
                  PR_NUMBER: String(prNumber),
                  AUTO_MERGE_STATUS: autoMerge ? 'enabled' : 'not enabled',
                });
                ciSubtype = 'ci_green_but_dirty';
              } else {
                msg = resolveMessage('ci_green', {
                  PR_NUMBER: String(prNumber),
                  AUTO_MERGE_STATUS: autoMerge ? 'enabled' : 'not enabled',
                });
                ciSubtype = 'ci_green';
              }
            } else if (ciStatus === 'failing') {
              const failedCheckNames = checks
                .filter((c) => isFailureConclusion(c.conclusion))
                .map((c) => c.name || c.context || 'unknown')
                .join(', ');
              msg = resolveMessage('ci_red', {
                PR_NUMBER: String(prNumber),
                FAILED_CHECKS: failedCheckNames,
                FAIL_COUNT: String(ciFailCount),
                MAX_FAILURES: String(config.maxUniqueCiFailures),
              });
              ciSubtype = 'ci_red';
            }
            if (msg) manager.sendMessage(teamId, msg, 'fc', ciSubtype);
          } catch (err) {
            console.error(`[GitHubPoller] Failed to send CI notification to team ${teamId}:`, err);
          }
        }

        // Notify the team via stdin when merge status changes to/from dirty or behind
        if (existing.mergeStatus !== mergeState) {
          try {
            const { getTeamManager } = await import('./team-manager.js');
            const manager = getTeamManager();

            if (mergeState === 'dirty') {
              const msg = resolveMessage('merge_conflict', {
                PR_NUMBER: String(prNumber),
              });
              if (msg) manager.sendMessage(teamId, msg, 'fc', 'merge_conflict');
            } else if (existing.mergeStatus === 'dirty') {
              const msg = resolveMessage('merge_conflict_resolved', {
                PR_NUMBER: String(prNumber),
              });
              if (msg) manager.sendMessage(teamId, msg, 'fc', 'merge_conflict_resolved');
            } else if (mergeState === 'behind') {
              const msg = resolveMessage('branch_behind', {
                PR_NUMBER: String(prNumber),
              });
              if (msg) manager.sendMessage(teamId, msg, 'fc', 'branch_behind');
            } else if (existing.mergeStatus === 'behind') {
              const msg = resolveMessage('branch_behind_resolved', {
                PR_NUMBER: String(prNumber),
              });
              if (msg) manager.sendMessage(teamId, msg, 'fc', 'branch_behind_resolved');
            }
          } catch (err) {
            console.error(`[GitHubPoller] Failed to send merge-status notification to team ${teamId}:`, err);
          }
        }

        // Merge notification is now handled by gracefulShutdown below
        // (sends pr_merged_shutdown instead of pr_merged to avoid duplicates)
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
        `[GitHubPoller] PR #${prNumber} discovered — state=${state} ci=${ciStatus} merge=${mergeState} (repo: ${githubRepo})`
      );

      // Notify team if the PR was born with merge conflicts
      if (mergeState === 'dirty') {
        try {
          const { getTeamManager } = await import('./team-manager.js');
          const manager = getTeamManager();
          const msg = resolveMessage('merge_conflict', {
            PR_NUMBER: String(prNumber),
          });
          if (msg) manager.sendMessage(teamId, msg, 'fc', 'merge_conflict');
        } catch (err) {
          console.error(`[GitHubPoller] Failed to send initial merge_conflict to team ${teamId}:`, err);
        }
      }
    }

    // If the PR was merged, update the team status to 'done'
    if (state === 'merged') {
      const team = db.getTeam(teamId);
      if (team && team.status !== 'done') {
        const previousStatus = team.status;
        db.insertTransition({
          teamId,
          fromStatus: previousStatus,
          toStatus: 'done',
          trigger: 'poller',
          reason: `PR #${prNumber} merged`,
        });
        db.updateTeam(teamId, { status: 'done', phase: 'done', stoppedAt: new Date().toISOString() });
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

      // Initiate graceful shutdown: notify TL, wait grace period, then kill
      try {
        const { getTeamManager } = await import('./team-manager.js');
        const manager = getTeamManager();
        manager.gracefulShutdown(teamId, prNumber, config.mergeShutdownGraceMs);
      } catch (err) {
        console.error(`[GitHubPoller] Failed to initiate graceful shutdown for team ${teamId}:`, err);
      }
    }

    // If CI has exceeded the maximum unique failure threshold, mark team as blocked + stuck
    if (
      ciFailCount >= config.maxUniqueCiFailures &&
      ciStatus === 'failing'
    ) {
      const team = db.getTeam(teamId);
      if (team && team.phase !== 'blocked') {
        const previousStatus = team.status;
        db.insertTransition({
          teamId,
          fromStatus: previousStatus,
          toStatus: 'stuck',
          trigger: 'poller',
          reason: `CI blocked: ${ciFailCount} unique CI failure types on PR #${prNumber}`,
        });
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
          if (msg) manager.sendMessage(teamId, msg, 'fc', 'ci_blocked');
        } catch (err) {
          console.error(`[GitHubPoller] Failed to send blocked notification to team ${teamId}:`, err);
        }
      }
    }

    return { ciStatus, state };
  }

  // -------------------------------------------------------------------------
  // Private: check dependencies for previously-blocked issues
  // -------------------------------------------------------------------------

  /**
   * Check dependency resolution for issues that were previously blocked.
   * When all blockers close, broadcasts a `dependency_resolved` SSE event
   * and triggers processQueue() to auto-launch newly unblocked teams.
   */
  private async checkDependencyResolution(): Promise<void> {
    // Collect project IDs that had dependencies resolve so we can trigger
    // processQueue once per project after the loop.
    const resolvedProjectIds = new Set<number>();

    // Also check DB-persisted blockers (queued teams with blocked_by_json).
    // This covers teams queued with the "Queue" action whose blocker info
    // survives server restarts, unlike the in-memory previouslyBlocked map.
    const db = getDatabase();
    const dbBlockedTeams = db.getQueuedBlockedTeams();
    const hasInMemoryBlocked = this.previouslyBlocked.size > 0;
    const hasDbBlocked = dbBlockedTeams.length > 0;

    if (!hasInMemoryBlocked && !hasDbBlocked) return;

    try {
      const { getIssueFetcher } = await import('./issue-fetcher.js');
      const fetcher = getIssueFetcher();

      // Check in-memory blocked issues
      for (const [key, entry] of this.previouslyBlocked) {
        try {
          const deps = await fetcher.fetchDependenciesForIssue(entry.projectId, entry.issueNumber);
          if (deps && deps.resolved) {
            // All blockers are now closed — broadcast resolution event
            sseBroker.broadcast('dependency_resolved', {
              issue_number: entry.issueNumber,
              project_id: entry.projectId,
              previously_blocked_by: entry.blockerNumbers,
            });

            console.log(
              `[GitHubPoller] Dependencies resolved for issue #${entry.issueNumber} (project ${entry.projectId})`
            );

            // Remove from tracking
            this.previouslyBlocked.delete(key);

            // Track this project for queue processing
            resolvedProjectIds.add(entry.projectId);
          }
        } catch (err) {
          // Log and continue — don't let one failure stop others
          console.error(
            `[GitHubPoller] Failed to check dependencies for ${key}:`,
            err instanceof Error ? err.message : err
          );
        }
      }

      // Check DB-persisted blocked teams
      for (const team of dbBlockedTeams) {
        if (!team.projectId) continue;

        try {
          const deps = await fetcher.fetchDependenciesForIssue(team.projectId, team.issueNumber);
          if (deps && deps.resolved) {
            // All blockers resolved — clear blocked_by_json and broadcast
            db.updateTeam(team.id, { blockedByJson: null });

            sseBroker.broadcast('dependency_resolved', {
              issue_number: team.issueNumber,
              project_id: team.projectId,
              previously_blocked_by: JSON.parse(team.blockedByJson!),
            });

            console.log(
              `[GitHubPoller] DB-persisted blockers resolved for team ${team.id} (issue #${team.issueNumber})`
            );

            resolvedProjectIds.add(team.projectId);
          }
        } catch (err) {
          console.error(
            `[GitHubPoller] Failed to check DB-persisted blockers for team ${team.id}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
    } catch (err) {
      console.error(
        '[GitHubPoller] Failed to import issue-fetcher for dependency check:',
        err instanceof Error ? err.message : err
      );
    }

    // Trigger queue processing for projects that had dependencies resolve,
    // so newly unblocked teams are auto-launched.
    if (resolvedProjectIds.size > 0) {
      try {
        const { getTeamManager } = await import('./team-manager.js');
        const manager = getTeamManager();
        for (const pid of resolvedProjectIds) {
          manager.processQueue(pid).catch((err) => {
            console.error(
              `[GitHubPoller] processQueue error after dependency resolution for project ${pid}:`,
              err instanceof Error ? err.message : err,
            );
          });
        }
      } catch (err) {
        console.error(
          '[GitHubPoller] Failed to import team-manager for auto-launch after dependency resolution:',
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  /**
   * Register an issue as blocked by dependencies.
   * Called externally when a launch is blocked by the dependency check.
   */
  trackBlockedIssue(projectId: number, issueNumber: number, blockerNumbers: number[]): void {
    const key = `${projectId}:${issueNumber}`;
    this.previouslyBlocked.set(key, { projectId, issueNumber, blockerNumbers });
  }

  /**
   * Remove an issue from blocked tracking (e.g. when force-launched).
   */
  untrackBlockedIssue(projectId: number, issueNumber: number): void {
    const key = `${projectId}:${issueNumber}`;
    this.previouslyBlocked.delete(key);
  }

  /**
   * Reseed the in-memory previouslyBlocked map from queued teams in the DB
   * that have a non-null blocked_by_json column. Called on poller start so
   * that dependency resolution detection survives server restarts.
   */
  reseedBlockedFromDb(): void {
    try {
      const db = getDatabase();
      const queuedTeams = db.getTeams({ status: 'queued' });
      let seeded = 0;

      for (const team of queuedTeams) {
        if (team.blockedByJson && team.projectId) {
          try {
            const blockerNumbers = JSON.parse(team.blockedByJson) as number[];
            if (Array.isArray(blockerNumbers) && blockerNumbers.length > 0) {
              this.trackBlockedIssue(team.projectId, team.issueNumber, blockerNumbers);
              seeded++;
            }
          } catch {
            // Malformed JSON — skip this team
          }
        }
      }

      if (seeded > 0) {
        console.log(`[GitHubPoller] Reseeded ${seeded} blocked issue(s) from DB`);
      }
    } catch (err) {
      console.error(
        '[GitHubPoller] Failed to reseed blocked issues from DB:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private: detect the actual branch name from a worktree on disk
  // -------------------------------------------------------------------------

  /**
   * Read the current branch from a worktree. Returns null if the worktree
   * doesn't exist or the branch can't be determined.
   *
   * The agent may rename the branch after launch (e.g. from "worktree-kea-767"
   * to "refactor/fix/767-unit-user-role-logic"), so we must check the actual
   * git state rather than relying on the initially stored branch name.
   */
  private async detectWorktreeBranch(repoPath: string, worktreeName: string): Promise<string | null> {
    const worktreeAbsPath = path.join(repoPath, config.worktreeDir, worktreeName);
    const branch = await execGitAsync(
      `git -C "${worktreeAbsPath}" rev-parse --abbrev-ref HEAD`,
    );
    return branch && branch !== 'HEAD' ? branch : null;
  }

  // -------------------------------------------------------------------------
  // Private: detect a PR for a branch that doesn't have one yet
  // -------------------------------------------------------------------------

  private async detectPR(branchName: string, teamId: number, githubRepo: string): Promise<void> {
    if (!isValidBranchName(branchName)) {
      console.warn(`[GitHubPoller] Skipping detectPR for team ${teamId} — invalid branchName: ${branchName}`);
      return;
    }
    if (!isValidGithubRepo(githubRepo)) {
      console.warn(`[GitHubPoller] Skipping detectPR for team ${teamId} — invalid githubRepo: ${githubRepo}`);
      return;
    }

    const result = await execGHAsync(
      `gh pr list --head "${branchName}" --repo "${githubRepo}" --state all --json number --limit 1`
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
      const team = db.getTeam(teamId);
      const prevPhase = team?.phase;

      // Update team with PR number and advance phase to 'pr' if appropriate
      const updateFields: Record<string, unknown> = { prNumber: prs[0]!.number };
      if (prevPhase && prevPhase !== 'pr' && prevPhase !== 'done') {
        updateFields.phase = 'pr';
      }
      db.updateTeam(teamId, updateFields);

      // Broadcast phase change if it advanced
      if (team && prevPhase && prevPhase !== 'pr' && prevPhase !== 'done') {
        sseBroker.broadcast('team_status_changed', {
          team_id: teamId,
          status: team.status,
          previous_status: team.status,
          phase: 'pr',
          previous_phase: prevPhase,
        }, teamId);
      }

      console.log(
        `[GitHubPoller] Detected PR #${prs[0]!.number} for branch "${branchName}" (team ${teamId}, repo: ${githubRepo})`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private: derive CI status from check runs
  // -------------------------------------------------------------------------

  private deriveCIStatus(checks: GHCheckRun[]): CIStatus {
    if (checks.length === 0) return 'none';

    const allPassed = checks.every(
      (c) =>
        c.conclusion === 'SUCCESS' ||
        c.conclusion === 'NEUTRAL' ||
        c.conclusion === 'SKIPPED'
    );
    const anyFailed = checks.some(
      (c) => isFailureConclusion(c.conclusion)
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

  // NOTE: The old synchronous execGH method has been removed.
  // All gh CLI calls now use the shared async execGHAsync utility
  // from src/server/utils/exec-gh.ts to avoid blocking the event loop.
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const githubPoller = new GitHubPoller();
