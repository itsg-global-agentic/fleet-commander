// =============================================================================
// Fleet Commander — Data Retention Service
//
// Periodically purges old records from high-volume tables (events,
// usage_snapshots, commands, team_transitions, agent_messages, stream_events)
// to prevent unbounded database growth.
//
// Runs once on startup, then every 24 hours. Uses batched deletes (LIMIT 5000
// per iteration) to avoid long WAL locks on large tables.
// =============================================================================

import { getDatabase } from '../db.js';
import config from '../config.js';

/** 24 hours in milliseconds */
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

class DataRetention {
  private interval: NodeJS.Timeout | null = null;

  /**
   * Start the data retention service.
   * Runs a purge immediately on startup, then schedules every 24 hours.
   */
  start(): void {
    if (this.interval) {
      return; // already running
    }

    // Run once immediately
    this.purge();

    this.interval = setInterval(() => this.purge(), TWENTY_FOUR_HOURS_MS);

    // Allow Node.js to exit even if this timer is still active
    if (this.interval.unref) {
      this.interval.unref();
    }
  }

  /**
   * Stop the periodic purge loop.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Run a single retention purge pass.
   * Can be called manually (e.g. from tests) or is invoked by the timer.
   */
  purge(): void {
    try {
      const db = getDatabase();
      const eventsRetention = config.eventsRetentionDays;
      const usageRetention = config.usageRetentionDays;

      const eventsDeleted = db.purgeOldEvents(eventsRetention);
      const usageDeleted = db.purgeOldUsageSnapshots(usageRetention);
      const commandsDeleted = db.purgeOldCommands(eventsRetention);
      const transitionsDeleted = db.purgeOldTeamTransitions(eventsRetention);
      const messagesDeleted = db.purgeOldAgentMessages(eventsRetention);
      const streamEventsDeleted = db.purgeOldStreamEvents(eventsRetention);

      const total = eventsDeleted + usageDeleted + commandsDeleted
        + transitionsDeleted + messagesDeleted + streamEventsDeleted;

      if (total > 0) {
        console.log(
          `[DataRetention] Purged ${total} old records — ` +
          `events=${eventsDeleted} (>${eventsRetention}d), ` +
          `usage_snapshots=${usageDeleted} (>${usageRetention}d), ` +
          `commands=${commandsDeleted}, ` +
          `team_transitions=${transitionsDeleted}, ` +
          `agent_messages=${messagesDeleted}, ` +
          `stream_events=${streamEventsDeleted}`
        );
      } else {
        console.log('[DataRetention] No old records to purge');
      }
    } catch (err: unknown) {
      console.error(
        '[DataRetention] Purge failed:',
        err instanceof Error ? err.message : err
      );
    }
  }
}

// Singleton instance — importable from anywhere in the server
export const dataRetention = new DataRetention();
