/**
 * Usage Tracking Service — Reads usage from Anthropic OAuth endpoint
 *
 * Replaces the old `claude -p "/usage"` poller with a direct HTTP call to
 * the Anthropic OAuth usage API, reading the token from the local
 * Claude credentials file.
 *
 * Also implements a usage gate: when usage enters the "red zone",
 * queue blocking is activated — no new teams will be dequeued until
 * usage drops back to "green".
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDatabase } from '../db.js';
import { sseBroker } from './sse-broker.js';
import config from '../config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UsageZone = 'green' | 'red';

export interface ParsedUsage {
  daily: number;
  weekly: number;
  sonnet: number;
  extra: number;
}

interface OAuthUsageBucket {
  utilization: number;
  resets_at?: string;
}

interface OAuthUsageResponse {
  five_hour?: OAuthUsageBucket;
  seven_day?: OAuthUsageBucket;
  seven_day_sonnet?: OAuthUsageBucket;
  extra_usage?: OAuthUsageBucket;
}

// ---------------------------------------------------------------------------
// Manual snapshot helper (kept for POST /api/usage testing endpoint)
// ---------------------------------------------------------------------------

/**
 * Process and store a usage snapshot, then broadcast via SSE.
 */
export function processUsageSnapshot(data: {
  teamId?: number;
  projectId?: number;
  sessionId?: string;
  dailyPercent?: number;
  weeklyPercent?: number;
  sonnetPercent?: number;
  extraPercent?: number;
  dailyResetsAt?: string;
  weeklyResetsAt?: string;
  rawOutput?: string;
}): void {
  const db = getDatabase();
  db.insertUsageSnapshot(data);

  sseBroker.broadcast('usage_updated', {
    daily_percent: data.dailyPercent ?? 0,
    weekly_percent: data.weeklyPercent ?? 0,
    sonnet_percent: data.sonnetPercent ?? 0,
    extra_percent: data.extraPercent ?? 0,
    zone: getUsageZone(),
  });
}

// ---------------------------------------------------------------------------
// Usage Zone — red/green gate
// ---------------------------------------------------------------------------

let _lastZone: UsageZone = 'green';
let _latestDaily = 0;
let _latestWeekly = 0;

/**
 * Returns 'red' if usage exceeds the configured thresholds, 'green' otherwise.
 */
export function getUsageZone(): UsageZone {
  if (_latestDaily >= config.usageRedDailyPct || _latestWeekly >= config.usageRedWeeklyPct) {
    return 'red';
  }
  return 'green';
}

// ---------------------------------------------------------------------------
// OAuth token reader
// ---------------------------------------------------------------------------

async function readOAuthToken(): Promise<string | null> {
  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const raw = await fs.promises.readFile(credPath, 'utf-8');
    const creds = JSON.parse(raw);
    const token = creds?.claudeAiOauth?.accessToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Usage Poller — fetches from Anthropic OAuth endpoint
// ---------------------------------------------------------------------------

class UsagePoller {
  private interval: NodeJS.Timeout | null = null;

  /**
   * Start polling at the given interval (default from config).
   * Polls immediately on start, then every `intervalMs` milliseconds.
   */
  start(intervalMs?: number): void {
    const ms = intervalMs ?? config.usagePollIntervalMs;

    // Seed zone state from the last DB snapshot so that zone transitions
    // (especially red -> green) are correctly detected on the first poll
    // after a server restart.  Without this, _lastZone defaults to 'green'
    // and a red->green recovery would never trigger processQueue.
    try {
      const db = getDatabase();
      const latest = db.getLatestUsage();
      if (latest) {
        _latestDaily = latest.dailyPercent;
        _latestWeekly = latest.weeklyPercent;
        _lastZone = getUsageZone();
        console.log(
          `[UsagePoller] Seeded from DB — daily=${_latestDaily}% weekly=${_latestWeekly}% zone=${_lastZone}`,
        );
      }
    } catch (err: unknown) {
      console.warn(
        '[UsagePoller] Could not seed from DB, using defaults:',
        err instanceof Error ? err.message : err,
      );
    }

    // Poll immediately on start
    this.poll();

    this.scheduleNext(ms);
    console.log(`[UsagePoller] Started — polling every ~${ms / 1000}s (±3min jitter)`);
  }

  /**
   * Stop the polling timer.
   */
  stop(): void {
    if (this.interval) {
      clearTimeout(this.interval);
      this.interval = null;
      console.log('[UsagePoller] Stopped');
    }
  }

  /**
   * Schedule the next poll with random jitter (±3 minutes).
   * Uses setTimeout chaining instead of setInterval so each
   * poll fires at a slightly different offset, avoiding
   * thundering-herd patterns.
   */
  private scheduleNext(baseMs?: number): void {
    const base = baseMs ?? config.usagePollIntervalMs;
    const jitter = Math.floor(Math.random() * 360000) - 180000; // ±3 minutes
    const delay = Math.max(60000, base + jitter); // floor: 60s minimum
    this.interval = setTimeout(() => {
      this.poll();
      this.scheduleNext(base);
    }, delay);
    this.interval.unref();
  }

  /**
   * Execute a single poll: fetch usage from Anthropic API,
   * store as a usage snapshot, and broadcast via SSE.
   */
  poll(): void {
    // Fire-and-forget — fetchUsage handles token reading and API call asynchronously
    this.fetchUsage().catch((err: unknown) => {
      console.error(
        '[UsagePoller] Failed to poll usage:',
        err instanceof Error ? err.message : err,
      );
    });
  }

  /**
   * Fetch usage data from the Anthropic OAuth endpoint and process it.
   */
  private async fetchUsage(): Promise<void> {
    const token = await readOAuthToken();
    if (!token) {
      console.warn('[UsagePoller] No OAuth token found in ~/.claude/.credentials.json');
      return;
    }

    const resp = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error(`[UsagePoller] API returned ${resp.status}: ${body.substring(0, 200)}`);
      return;
    }

    const data = (await resp.json()) as OAuthUsageResponse;
    const rawOutput = JSON.stringify(data);

    // API returns utilization as 0-100 already (e.g. 26.0 = 26%)
    const dailyPercent = data.five_hour?.utilization ?? 0;
    const weeklyPercent = data.seven_day?.utilization ?? 0;
    const sonnetPercent = data.seven_day_sonnet?.utilization ?? 0;
    const extraPercent = data.extra_usage?.utilization ?? 0;

    const dailyResetsAt = data.five_hour?.resets_at ?? null;
    const weeklyResetsAt = data.seven_day?.resets_at ?? null;

    // Update module-level tracking variables
    _latestDaily = dailyPercent;
    _latestWeekly = weeklyPercent;

    const previousZone = _lastZone;
    const currentZone = getUsageZone();

    // Store snapshot
    const db = getDatabase();
    db.insertUsageSnapshot({
      dailyPercent,
      weeklyPercent,
      sonnetPercent,
      extraPercent,
      dailyResetsAt: dailyResetsAt ?? undefined,
      weeklyResetsAt: weeklyResetsAt ?? undefined,
      rawOutput,
    });

    // Broadcast via SSE
    sseBroker.broadcast('usage_updated', {
      daily_percent: dailyPercent,
      weekly_percent: weeklyPercent,
      sonnet_percent: sonnetPercent,
      extra_percent: extraPercent,
      zone: currentZone,
    });

    console.log(
      `[UsagePoller] Snapshot recorded — daily=${dailyPercent}% weekly=${weeklyPercent}% sonnet=${sonnetPercent}% extra=${extraPercent}% zone=${currentZone}`,
    );

    // Zone transition: red -> green => trigger queue processing for all projects
    if (previousZone === 'red' && currentZone === 'green') {
      console.log('[UsagePoller] Zone transition: red -> green — draining queues');
      try {
        // Dynamically import to avoid circular dependency
        const { getTeamManager } = await import('./team-manager.js');
        const manager = getTeamManager();
        const projects = db.getProjects({ status: 'active' });
        for (const project of projects) {
          const queued = db.getQueuedTeamsByProject(project.id);
          if (queued.length > 0) {
            manager.processQueue(project.id).catch((err: unknown) => {
              console.error(`[UsagePoller] processQueue error for project ${project.id}:`, err);
            });
          }
        }
      } catch (err: unknown) {
        console.error('[UsagePoller] Failed to drain queues on zone transition:', err);
      }
    }

    _lastZone = currentZone;
  }
}

export const usagePoller = new UsagePoller();
