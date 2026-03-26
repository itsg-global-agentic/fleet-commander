// =============================================================================
// Fleet Commander — Stuck Detector Service
//
// Periodically checks active teams for idle/stuck transitions based on the
// time since their last event.
//
// CI failure → blocked logic is handled exclusively by github-poller.ts
// (single source of truth for CI status).
//
// State machine transitions (from docs/state-machines.md):
//   running   -> idle    after IDLE_THRESHOLD_MIN    (5 min default)
//   idle      -> stuck   after STUCK_THRESHOLD_MIN   (10 min default)
//   launching -> failed  after LAUNCH_TIMEOUT_MIN    (5 min default)
// =============================================================================

import type { TeamStatus } from '../../shared/types.js';
import { getDatabase } from '../db.js';
import config from '../config.js';
import { sseBroker } from './sse-broker.js';
import { resolveMessage } from '../utils/resolve-message.js';
import { getTeamManager } from './team-manager.js';

class StuckDetector {
  private interval: NodeJS.Timeout | null = null;

  /**
   * Start the periodic stuck-detection check loop.
   * Runs every `config.stuckCheckIntervalMs` (default 60 000 ms).
   */
  start(): void {
    if (this.interval) {
      return; // already running
    }

    this.interval = setInterval(() => this.check(), config.stuckCheckIntervalMs);

    // Allow Node.js to exit even if this timer is still active
    if (this.interval.unref) {
      this.interval.unref();
    }
  }

  /**
   * Stop the periodic check loop.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Run a single stuck-detection pass over all active teams.
   * Can be called manually (e.g. from tests) or is invoked by the timer.
   */
  check(): void {
    const db = getDatabase();

    // Sync stdout activity to DB before evaluating teams (#446)
    // This ensures last_event_at reflects both hook events AND stdout activity
    try {
      const manager = getTeamManager();
      manager.syncStreamActivityToDb();
    } catch {
      // TeamManager may not be initialized yet
    }

    const activeTeams = db.getActiveTeams();
    const now = Date.now();
    const idleThresholdMs = config.idleThresholdMin * 60_000;

    for (const team of activeTeams) {
      // --- Launch timeout detection ----------------------------------------
      // Teams stuck in 'launching' (CC process hangs without crashing or
      // sending any events) are transitioned to 'failed' after the timeout.

      if (team.status === 'launching' && team.launchedAt) {
        const launchedTime = new Date(team.launchedAt).getTime();
        const launchMinutes = (now - launchedTime) / 60_000;

        // Check stdout activity before timing out — team may be alive without hooks
        if (launchMinutes > config.launchTimeoutMin) {
          try {
            const manager = getTeamManager();
            const lastStream = manager.getLastStreamAt(team.id);
            if (lastStream && (now - lastStream) < idleThresholdMs) {
              console.log(
                `[StuckDetector] Team ${team.id} has stdout activity (${Math.round((now - lastStream) / 1000)}s ago), skipping launch timeout`
              );
              continue;
            }
          } catch {
            // TeamManager not available — proceed with timeout
          }
          db.insertTransition({
            teamId: team.id,
            fromStatus: 'launching',
            toStatus: 'failed',
            trigger: 'timer',
            reason: `Launch timeout after ${Math.round(launchMinutes)} minutes`,
          });
          db.updateTeamSilent(team.id, { status: 'failed' });

          sseBroker.broadcast(
            'team_status_changed',
            {
              team_id: team.id,
              status: 'failed',
              previous_status: 'launching',
              idle_minutes: Math.round(launchMinutes),
            },
            team.id,
          );

          // Kill the hung process (best-effort — it may already be dead)
          try {
            const manager = getTeamManager();
            manager.stop(team.id).catch(() => {});
          } catch {
            // ignore — process may not exist
          }

          console.log(
            `[StuckDetector] Team ${team.id} failed — launch timeout after ${Math.round(launchMinutes)} min`
          );
          continue;
        }
      }

      // --- Idle / stuck detection based on time since last event -----------

      if (team.lastEventAt) {
        const lastEventTime = new Date(team.lastEventAt).getTime();
        const idleMinutes = (now - lastEventTime) / 60_000;

        let newStatus: TeamStatus | null = null;

        if (team.status === 'running' && idleMinutes > config.idleThresholdMin) {
          newStatus = 'idle';
        } else if (team.status === 'idle' && idleMinutes > config.stuckThresholdMin) {
          newStatus = 'stuck';
        }

        if (newStatus) {
          // Skip idle/stuck transition if the team is currently thinking.
          // Extended thinking means the model is actively working — not idle.
          try {
            const manager = getTeamManager();
            if (manager.thinkingTeams.has(team.id)) {
              console.log(
                `[StuckDetector] Team ${team.id} skipped — currently in extended thinking`
              );
              continue;
            }
          } catch {
            // TeamManager not initialized — skip thinking check
          }

          // Skip idle/stuck transition if the team has a PR with pending CI.
          // A team waiting for CI is not idle — it's working.
          if (team.prNumber) {
            const pr = db.getPullRequest(team.prNumber);
            if (pr && pr.ciStatus === 'pending') {
              console.log(
                `[StuckDetector] Team ${team.id} skipped — CI pending on PR #${team.prNumber}`
              );
              continue;
            }
          }

          const previousStatus = team.status;
          db.insertTransition({
            teamId: team.id,
            fromStatus: previousStatus,
            toStatus: newStatus,
            trigger: 'timer',
            reason: newStatus === 'idle'
              ? `No events for ${Math.round(idleMinutes)} minutes`
              : `Idle for ${Math.round(idleMinutes)} minutes (stuck threshold exceeded)`,
          });
          db.updateTeamSilent(team.id, { status: newStatus as 'idle' | 'stuck' });

          sseBroker.broadcast(
            'team_status_changed',
            {
              team_id: team.id,
              status: newStatus,
              previous_status: previousStatus,
              idle_minutes: Math.round(idleMinutes),
            },
            team.id,
          );

          // When a team transitions to idle, send an idle nudge to prompt TL
          // to check subagent status and proceed with next steps
          if (newStatus === 'idle') {
            const idleMsg = resolveMessage('idle_nudge', {
              IDLE_MINUTES: String(Math.round(idleMinutes)),
            });
            if (idleMsg) {
              const manager = getTeamManager();
              manager.sendMessage(team.id, idleMsg, 'fc', 'idle_nudge');
              console.log(`[StuckDetector] Idle nudge sent to team ${team.id}`);
            }
          }

          // When a team transitions to stuck, send a nudge message to the TL
          if (newStatus === 'stuck') {
            const msg = resolveMessage('stuck_nudge', {
              ISSUE_NUMBER: String(team.issueNumber),
            });
            if (msg) {
              const manager = getTeamManager();
              manager.sendMessage(team.id, msg, 'fc', 'stuck_nudge');
              console.log(`[StuckDetector] Nudge sent to team ${team.id}`);
            }
          }
        }
      }

    }
  }
}

// Singleton instance — importable from anywhere in the server
export const stuckDetector = new StuckDetector();
