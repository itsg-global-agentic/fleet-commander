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
//   running -> idle   after IDLE_THRESHOLD_MIN  (5 min default)
//   idle    -> stuck  after STUCK_THRESHOLD_MIN (15 min default)
// =============================================================================

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
    const activeTeams = db.getActiveTeams();
    const now = Date.now();

    for (const team of activeTeams) {
      // --- Idle / stuck detection based on time since last event -----------

      if (team.lastEventAt) {
        const lastEventTime = new Date(team.lastEventAt).getTime();
        const idleMinutes = (now - lastEventTime) / 60_000;

        let newStatus: string | null = null;

        if (team.status === 'running' && idleMinutes > config.idleThresholdMin) {
          newStatus = 'idle';
        } else if (team.status === 'idle' && idleMinutes > config.stuckThresholdMin) {
          newStatus = 'stuck';
        }

        if (newStatus) {
          const previousStatus = team.status;
          db.updateTeam(team.id, { status: newStatus as 'idle' | 'stuck' });

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

          // When a team transitions to stuck, send a nudge message to the TL
          if (newStatus === 'stuck') {
            const msg = resolveMessage('stuck_nudge', {
              ISSUE_NUMBER: String(team.issueNumber),
            });
            if (msg) {
              const manager = getTeamManager();
              manager.sendMessage(team.id, msg);
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
