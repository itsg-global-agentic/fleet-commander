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

export type UsageZone = 'green' | 'red' | 'hard_red';

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
 * Updates module-level usage variables so getUsageZone() reflects the
 * submitted values, and triggers queue drain on red-to-green transitions.
 */
export async function processUsageSnapshot(data: {
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
}): Promise<void> {
  const previousZone = _lastZone;

  // Update module-level tracking variables so getUsageZone() reflects the submitted values
  _latestDaily = data.dailyPercent ?? 0;
  _latestWeekly = data.weeklyPercent ?? 0;
  _latestExtra = data.extraPercent ?? 0;

  const currentZone = getUsageZone();

  const db = getDatabase();
  db.insertUsageSnapshot(data);

  sseBroker.broadcast('usage_updated', {
    daily_percent: data.dailyPercent ?? 0,
    weekly_percent: data.weeklyPercent ?? 0,
    sonnet_percent: data.sonnetPercent ?? 0,
    extra_percent: data.extraPercent ?? 0,
    zone: currentZone,
    overrideActive: _usageOverrideActive,
    hardPaused: currentZone === 'hard_red',
  });

  await checkZoneTransitionAndDrain(previousZone, currentZone);

  _lastZone = currentZone;

  console.log(
    `[UsageTracker] Manual snapshot — daily=${data.dailyPercent ?? 0}% weekly=${data.weeklyPercent ?? 0}% zone=${currentZone}`,
  );
}

// ---------------------------------------------------------------------------
// Usage Zone — red/green gate
// ---------------------------------------------------------------------------

let _lastZone: UsageZone = 'green';
let _latestDaily = 0;
let _latestWeekly = 0;
let _latestExtra = 0;
let _usageOverrideActive = false;

/**
 * Returns the latest daily usage percentage.
 * Used by the retry scheduler to check against the retry usage threshold.
 */
export function getLatestDailyPercent(): number {
  return _latestDaily;
}

/**
 * Returns the current usage zone:
 * - 'hard_red' when extra usage >= hard extra threshold (non-overridable)
 * - 'red' when daily/weekly exceeds soft thresholds (overridable)
 * - 'green' otherwise
 */
export function getUsageZone(): UsageZone {
  if (_latestExtra >= config.usageHardExtraPct) {
    return 'hard_red';
  }
  if (_latestDaily >= config.usageRedDailyPct || _latestWeekly >= config.usageRedWeeklyPct) {
    return 'red';
  }
  return 'green';
}

/**
 * Returns true when team launches should be blocked.
 * - hard_red zone: always blocked
 * - red zone: blocked unless usage override is active
 * - green zone: never blocked
 */
export function isUsageBlocked(): boolean {
  const zone = getUsageZone();
  if (zone === 'hard_red') return true;
  if (zone === 'red' && !_usageOverrideActive) return true;
  return false;
}

/**
 * Returns whether the usage override is currently active.
 */
export function isUsageOverrideActive(): boolean {
  return _usageOverrideActive;
}

/**
 * Returns whether the system is in hard pause (extra usage >= hard threshold).
 */
export function isHardPaused(): boolean {
  return getUsageZone() === 'hard_red';
}

/**
 * Activate the usage override to allow launches despite soft red zone.
 * Refuses activation when in hard_red zone.
 */
export async function activateUsageOverride(): Promise<{ overrideActive: boolean; hardPaused: boolean }> {
  const zone = getUsageZone();
  if (zone === 'hard_red') {
    return { overrideActive: false, hardPaused: true };
  }
  if (zone === 'green') {
    return { overrideActive: false, hardPaused: false };
  }

  _usageOverrideActive = true;

  sseBroker.broadcast('usage_override_changed', {
    overrideActive: true,
    hardPaused: false,
  });

  console.log('[UsageTracker] Usage override activated — launches allowed despite red zone');

  // Trigger queue drain for all projects (same pattern as checkZoneTransitionAndDrain)
  try {
    const { getTeamManager } = await import('./team-manager.js');
    const manager = getTeamManager();
    const db = getDatabase();
    const projects = db.getProjects({ status: 'active' });
    for (const project of projects) {
      const queued = db.getQueuedTeamsByProject(project.id);
      if (queued.length > 0) {
        manager.processQueue(project.id).catch((err: unknown) => {
          console.error(`[UsageTracker] processQueue error for project ${project.id}:`, err);
        });
      }
    }
  } catch (err: unknown) {
    console.error('[UsageTracker] Failed to drain queues on override activation:', err);
  }

  return { overrideActive: true, hardPaused: false };
}

/**
 * Deactivate the usage override.
 */
export function deactivateUsageOverride(): { overrideActive: boolean; hardPaused: boolean } {
  _usageOverrideActive = false;

  const hardPaused = getUsageZone() === 'hard_red';

  sseBroker.broadcast('usage_override_changed', {
    overrideActive: false,
    hardPaused,
  });

  console.log('[UsageTracker] Usage override deactivated');

  return { overrideActive: false, hardPaused };
}

// ---------------------------------------------------------------------------
// Zone transition — shared drain logic
// ---------------------------------------------------------------------------

/**
 * Check for a red-to-green zone transition and trigger queue processing
 * for all active projects with queued teams.  Used by both the poller's
 * fetchUsage() and the manual processUsageSnapshot() path.
 *
 * Uses a dynamic import for team-manager to avoid circular dependencies.
 */
export async function checkZoneTransitionAndDrain(
  previousZone: UsageZone,
  currentZone: UsageZone,
): Promise<void> {
  // Auto-clear override when transitioning to green (no longer needed)
  if (currentZone === 'green' && _usageOverrideActive) {
    _usageOverrideActive = false;
    sseBroker.broadcast('usage_override_changed', { overrideActive: false, hardPaused: false });
    console.log('[UsageTracker] Override auto-cleared — zone returned to green');
  }

  // Auto-clear override when transitioning to hard_red (non-overridable)
  if (currentZone === 'hard_red' && _usageOverrideActive) {
    _usageOverrideActive = false;
    sseBroker.broadcast('usage_override_changed', { overrideActive: false, hardPaused: true });
    console.log('[UsageTracker] Override auto-cleared — zone transitioned to hard_red');
  }

  // Drain queues on red/hard_red -> green transition
  if ((previousZone === 'red' || previousZone === 'hard_red') && currentZone === 'green') {
    console.log(`[UsageTracker] Zone transition: ${previousZone} -> green — draining queues`);
    try {
      const { getTeamManager } = await import('./team-manager.js');
      const manager = getTeamManager();
      const db = getDatabase();
      const projects = db.getProjects({ status: 'active' });
      for (const project of projects) {
        const queued = db.getQueuedTeamsByProject(project.id);
        if (queued.length > 0) {
          manager.processQueue(project.id).catch((err: unknown) => {
            console.error(`[UsageTracker] processQueue error for project ${project.id}:`, err);
          });
        }
      }
    } catch (err: unknown) {
      console.error('[UsageTracker] Failed to drain queues on zone transition:', err);
    }
  }
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
        _latestExtra = latest.extraPercent ?? 0;
        _lastZone = getUsageZone();
        console.log(
          `[UsagePoller] Seeded from DB — daily=${_latestDaily}% weekly=${_latestWeekly}% extra=${_latestExtra}% zone=${_lastZone}`,
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
    _latestExtra = extraPercent;

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
      overrideActive: _usageOverrideActive,
      hardPaused: currentZone === 'hard_red',
    });

    console.log(
      `[UsagePoller] Snapshot recorded — daily=${dailyPercent}% weekly=${weeklyPercent}% sonnet=${sonnetPercent}% extra=${extraPercent}% zone=${currentZone}`,
    );

    // Zone transition: red -> green => trigger queue processing for all projects
    await checkZoneTransitionAndDrain(previousZone, currentZone);

    _lastZone = currentZone;
  }
}

export const usagePoller = new UsagePoller();
