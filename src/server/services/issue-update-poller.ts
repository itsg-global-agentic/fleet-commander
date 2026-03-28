// =============================================================================
// Fleet Commander — Issue Update Poller Service
// =============================================================================
// Polls running teams' issues every 30s (configurable) for mid-execution
// changes: new comments, label changes, body edits, and external closure.
// Detects changes by comparing against in-memory snapshots and sends
// structured messages to the team lead via stdin.
//
// Follows the same singleton + class pattern as github-poller.ts:
//   - setTimeout (not setInterval) to prevent overlapping poll cycles
//   - In-memory snapshot map (ephemeral, not persisted)
//   - First poll initializes snapshots without sending notifications
//   - Bot comments are filtered out
//   - Only priority/blocking label changes trigger notifications
//
// Supports GitHub (via `gh` CLI). Jira is stubbed for future implementation.
// =============================================================================

import { getDatabase } from '../db.js';
import config from '../config.js';
import { sseBroker } from './sse-broker.js';
import { resolveMessage } from '../utils/resolve-message.js';
import { execGHAsync, isValidGithubRepo } from '../utils/exec-gh.js';
import type { Team } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Regex patterns for labels that trigger notifications when added or removed.
 * Other label changes (e.g. 'documentation', 'enhancement') are filtered as noise.
 */
const PRIORITY_LABEL_PATTERNS: RegExp[] = [
  /^priority[:/]/i,
  /^P[0-4]$/,
  /^block/i,
  /^urgent$/i,
  /^critical$/i,
];

/**
 * Statuses that represent a team with a live stdin pipe.
 * We skip 'queued' (no process) and 'launching' (not ready yet).
 */
const POLLABLE_STATUSES = new Set(['running', 'idle', 'stuck']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-team snapshot of the issue state for change detection. */
interface IssueSnapshot {
  commentCount: number;
  labels: string[];
  state: string;
  bodyHash: string;
}

/** Shape of the JSON returned by `gh issue view`. */
interface GHIssueComment {
  author: { login: string; type?: string };
  body: string;
  createdAt: string;
}

interface GHIssueViewResult {
  number: number;
  title: string;
  state: string;
  body: string | null;
  labels: Array<{ name: string }>;
  comments: GHIssueComment[];
  updatedAt: string;
}

/** A detected change to be processed into a message. */
interface IssueChange {
  type: 'comment' | 'labels' | 'closed' | 'body';
  templateId: string;
  vars: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Issue Update Poller
// ---------------------------------------------------------------------------

class IssueUpdatePoller {
  private timer: NodeJS.Timeout | null = null;
  private isPolling = false;

  /**
   * In-memory snapshots keyed by team ID.
   * First poll initializes without sending notifications.
   * Lost on restart — by design (acceptance criterion).
   */
  private snapshots = new Map<number, IssueSnapshot>();

  /**
   * Start the polling loop. First poll fires after 10s delay, then
   * every `config.issueUpdatePollMs` milliseconds.
   */
  start(): void {
    if (this.timer) return; // already running

    const initialTimer = setTimeout(() => this.poll(), 10_000);
    if (initialTimer.unref) initialTimer.unref();

    this.scheduleNextPoll();
    console.log(
      `[IssueUpdatePoller] Started — interval ${config.issueUpdatePollMs}ms`,
    );
  }

  /** Stop the polling loop. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      console.log('[IssueUpdatePoller] Stopped');
    }
  }

  /**
   * Remove the snapshot for a team. Called externally when a team is stopped
   * so we don't accumulate stale entries.
   */
  removeTeam(teamId: number): void {
    this.snapshots.delete(teamId);
  }

  // -------------------------------------------------------------------------
  // Private: scheduling
  // -------------------------------------------------------------------------

  private scheduleNextPoll(): void {
    if (this.timer) clearTimeout(this.timer);

    this.timer = setTimeout(() => {
      this.poll().finally(() => this.scheduleNextPoll());
    }, config.issueUpdatePollMs);

    if (this.timer.unref) this.timer.unref();
  }

  // -------------------------------------------------------------------------
  // Private: main poll loop
  // -------------------------------------------------------------------------

  private async poll(): Promise<void> {
    if (this.isPolling) {
      return; // previous cycle still running
    }
    this.isPolling = true;

    try {
      const db = getDatabase();
      const allTeams = db.getActiveTeams();

      // Only poll teams with a live stdin pipe
      const teams = allTeams.filter((t) => POLLABLE_STATUSES.has(t.status));
      if (teams.length === 0) return;

      // Build project map for resolving github repos
      const projects = db.getProjects({ status: 'active' });
      const projectMap = new Map(
        projects.map((p) => [p.id, p]),
      );

      for (const team of teams) {
        try {
          if (!team.projectId) continue;

          const project = projectMap.get(team.projectId);
          if (!project) continue;

          const provider = project.issueProvider || 'github';

          if (provider === 'github' && project.githubRepo) {
            await this.pollGitHubIssue(team, project.githubRepo);
          }
          // Jira / Linear — stub for future implementation
        } catch (err) {
          console.error(
            `[IssueUpdatePoller] Error polling team ${team.id} (issue #${team.issueNumber}):`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    } finally {
      this.isPolling = false;
    }
  }

  // -------------------------------------------------------------------------
  // Private: GitHub issue polling
  // -------------------------------------------------------------------------

  private async pollGitHubIssue(
    team: Team,
    githubRepo: string,
  ): Promise<void> {
    if (!isValidGithubRepo(githubRepo)) {
      return;
    }

    const issueKey = team.issueKey || String(team.issueNumber);

    const raw = await execGHAsync(
      `gh issue view ${team.issueNumber} --repo "${githubRepo}" --json number,state,body,labels,comments,updatedAt`,
    );
    if (!raw) return; // gh CLI failed — skip this cycle, don't update snapshot

    let data: GHIssueViewResult;
    try {
      data = JSON.parse(raw);
    } catch {
      console.error(
        `[IssueUpdatePoller] Failed to parse gh output for issue #${team.issueNumber}`,
      );
      return;
    }

    const currentLabels = (data.labels || []).map((l) => l.name);
    const currentState = (data.state || 'OPEN').toUpperCase();
    const currentBodyHash = hashString(data.body || '');

    // Filter out bot comments to get non-bot comment count
    const nonBotComments = (data.comments || []).filter(
      (c) => !isBot(c.author),
    );

    const existing = this.snapshots.get(team.id);

    if (!existing) {
      // First poll — initialize snapshot without sending notifications
      this.snapshots.set(team.id, {
        commentCount: nonBotComments.length,
        labels: currentLabels,
        state: currentState,
        bodyHash: currentBodyHash,
      });
      return;
    }

    // Detect changes
    const changes: IssueChange[] = [];

    // 1. New non-bot comments
    if (nonBotComments.length > existing.commentCount) {
      // Get new comments (those after the previously known count)
      const newComments = nonBotComments.slice(existing.commentCount);
      if (newComments.length > 0) {
        // Send the latest comment to the team. If there are multiple new
        // comments, include a count note.
        const latest = newComments[newComments.length - 1]!;
        let commentBody = latest.body;
        if (newComments.length > 1) {
          commentBody = `[${newComments.length} new comments — showing latest]\n\n${commentBody}`;
        }
        changes.push({
          type: 'comment',
          templateId: 'issue_comment_new',
          vars: {
            ISSUE_KEY: issueKey,
            COMMENT_AUTHOR: latest.author.login,
            COMMENT_BODY: commentBody,
          },
        });
      }
    }

    // 2. Label changes (only priority/blocking labels)
    const addedLabels = currentLabels.filter(
      (l) => !existing.labels.includes(l),
    );
    const removedLabels = existing.labels.filter(
      (l) => !currentLabels.includes(l),
    );
    const priorityAdded = addedLabels.filter(isPriorityLabel);
    const priorityRemoved = removedLabels.filter(isPriorityLabel);

    if (priorityAdded.length > 0 || priorityRemoved.length > 0) {
      changes.push({
        type: 'labels',
        templateId: 'issue_labels_changed',
        vars: {
          ISSUE_KEY: issueKey,
          LABELS_ADDED: priorityAdded.length > 0 ? priorityAdded.join(', ') : 'none',
          LABELS_REMOVED: priorityRemoved.length > 0 ? priorityRemoved.join(', ') : 'none',
          CURRENT_LABELS: currentLabels.length > 0 ? currentLabels.join(', ') : 'none',
        },
      });
    }

    // 3. Issue closed externally
    if (
      existing.state === 'OPEN' &&
      currentState === 'CLOSED'
    ) {
      changes.push({
        type: 'closed',
        templateId: 'issue_closed_externally',
        vars: { ISSUE_KEY: issueKey },
      });
    }

    // 4. Body updated
    if (existing.bodyHash !== currentBodyHash) {
      // Provide a summary — we cannot diff markdown easily, so tell the TL
      // to review the latest requirements.
      changes.push({
        type: 'body',
        templateId: 'issue_body_updated',
        vars: {
          ISSUE_KEY: issueKey,
          BODY_DIFF_SUMMARY: 'The issue body has been modified. Please re-read the issue for updated requirements.',
        },
      });
    }

    // Update the snapshot with current values
    this.snapshots.set(team.id, {
      commentCount: nonBotComments.length,
      labels: currentLabels,
      state: currentState,
      bodyHash: currentBodyHash,
    });

    // Send messages for all detected changes
    if (changes.length > 0) {
      await this.sendChangeMessages(team, changes);
    }
  }

  // -------------------------------------------------------------------------
  // Private: send messages to the team
  // -------------------------------------------------------------------------

  private async sendChangeMessages(
    team: Team,
    changes: IssueChange[],
  ): Promise<void> {
    try {
      const { getTeamManager } = await import('./team-manager.js');
      const manager = getTeamManager();

      for (const change of changes) {
        const msg = resolveMessage(change.templateId, change.vars);
        if (msg) {
          manager.sendMessage(team.id, msg, 'fc', change.templateId);
        }

        // External closure triggers graceful shutdown
        if (change.type === 'closed') {
          const db = getDatabase();
          const previousStatus = team.status;

          db.insertTransition({
            teamId: team.id,
            fromStatus: previousStatus,
            toStatus: 'done',
            trigger: 'poller',
            reason: 'Issue closed externally',
          });
          db.updateTeamSilent(team.id, {
            status: 'done',
            phase: 'done',
            stoppedAt: new Date().toISOString(),
          });

          sseBroker.broadcast(
            'team_status_changed',
            {
              team_id: team.id,
              status: 'done',
              previous_status: previousStatus,
            },
            team.id,
          );

          console.log(
            `[IssueUpdatePoller] Team ${team.id} marked done — issue #${team.issueNumber} closed externally`,
          );

          manager.stop(team.id);

          // Remove snapshot since team is done
          this.snapshots.delete(team.id);

          // No further changes matter after closure
          break;
        }
      }
    } catch (err) {
      console.error(
        `[IssueUpdatePoller] Failed to send messages to team ${team.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Utility functions (module-level for testability)
// ---------------------------------------------------------------------------

/**
 * Check if a label matches known priority/blocking patterns.
 */
function isPriorityLabel(label: string): boolean {
  return PRIORITY_LABEL_PATTERNS.some((re) => re.test(label));
}

/**
 * Check if a comment author is a bot.
 * Uses the `type` field when available, falls back to login suffix.
 */
function isBot(author: { login: string; type?: string }): boolean {
  if (author.type === 'Bot') return true;
  if (author.login.endsWith('[bot]')) return true;
  return false;
}

/**
 * Simple djb2 hash of a string, returned as a hex string.
 * No crypto needed — this is for change detection, not security.
 */
function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0; // hash * 33 + char
  }
  // Convert to unsigned 32-bit hex
  return (hash >>> 0).toString(16);
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const issueUpdatePoller = new IssueUpdatePoller();

// Export utilities for testing
export { isPriorityLabel, isBot, hashString };
export type { IssueSnapshot, GHIssueViewResult, GHIssueComment, IssueChange };
