/**
 * Usage Tracking Service — Records and broadcasts usage percentage snapshots
 *
 * Replaces cost tracking with usage-percentage tracking that mirrors what
 * Claude Code's /usage command reports: daily, weekly, Sonnet-only, and
 * extra usage as 0-100% progress bars.
 *
 * Includes a UsagePoller that periodically runs `claude -p "/usage"` to
 * capture real usage data from Claude Code.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import { getDatabase } from '../db.js';
import { sseBroker } from './sse-broker.js';
import config from '../config.js';

/** Find bash.exe for CLAUDE_CODE_GIT_BASH_PATH on Windows */
function findGitBash(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  if (process.env['CLAUDE_CODE_GIT_BASH_PATH']) return process.env['CLAUDE_CODE_GIT_BASH_PATH'];
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Git\\scm\\usr\\bin\\bash.exe',
    'C:\\Git\\scm\\bin\\bash.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Try to find via where command
  try {
    const result = execSync('where bash.exe 2>nul', { encoding: 'utf-8', timeout: 5000 });
    const first = result.trim().split('\n')[0]?.trim();
    if (first && fs.existsSync(first)) return first;
  } catch { /* ignore */ }
  return undefined;
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
  rawOutput?: string;
}): void {
  const db = getDatabase();
  db.insertUsageSnapshot(data);

  sseBroker.broadcast('usage_updated', {
    daily_percent: data.dailyPercent ?? 0,
    weekly_percent: data.weeklyPercent ?? 0,
    sonnet_percent: data.sonnetPercent ?? 0,
    extra_percent: data.extraPercent ?? 0,
  });
}

// ---------------------------------------------------------------------------
// Parsed usage result
// ---------------------------------------------------------------------------

export interface ParsedUsage {
  daily: number;
  weekly: number;
  sonnet: number;
  extra: number;
}

// ---------------------------------------------------------------------------
// Usage Poller — runs `claude -p "/usage"` on a timer
// ---------------------------------------------------------------------------

class UsagePoller {
  private interval: NodeJS.Timeout | null = null;

  /**
   * Start polling at the given interval (default from config).
   * Polls immediately on start, then every `intervalMs` milliseconds.
   */
  start(intervalMs?: number): void {
    const ms = intervalMs ?? config.usagePollIntervalMs;

    // Poll immediately on start
    this.poll();

    this.interval = setInterval(() => this.poll(), ms);
    this.interval.unref(); // allow process to exit even if timer is active
    console.log(`[UsagePoller] Started — polling every ${ms / 1000}s`);
  }

  /**
   * Stop the polling timer.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log('[UsagePoller] Stopped');
    }
  }

  /**
   * Execute a single poll: run `claude -p "/usage"`, parse the output,
   * store it as a usage snapshot, and broadcast via SSE.
   */
  poll(): void {
    try {
      const claudeCmd = config.claudeCmd;
      // Run claude in print mode with the /usage slash command.
      // This should output usage information and exit immediately.
      const env: Record<string, string | undefined> = { ...process.env };
      const gitBash = findGitBash();
      if (gitBash) env['CLAUDE_CODE_GIT_BASH_PATH'] = gitBash;

      const output = execSync(`${claudeCmd} -p "/usage"`, {
        encoding: 'utf-8',
        timeout: 30000,
        env,
      });

      const parsed = this.parseUsageOutput(output);
      if (parsed) {
        const db = getDatabase();
        db.insertUsageSnapshot({
          dailyPercent: parsed.daily,
          weeklyPercent: parsed.weekly,
          sonnetPercent: parsed.sonnet,
          extraPercent: parsed.extra,
          rawOutput: output,
        });

        sseBroker.broadcast('usage_updated', {
          daily_percent: parsed.daily,
          weekly_percent: parsed.weekly,
          sonnet_percent: parsed.sonnet,
          extra_percent: parsed.extra,
        });

        console.log(
          `[UsagePoller] Snapshot recorded — daily=${parsed.daily}% weekly=${parsed.weekly}% sonnet=${parsed.sonnet}% extra=${parsed.extra}%`,
        );
      }
    } catch (err: unknown) {
      console.error(
        '[UsagePoller] Failed to poll usage:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Parse the raw text output of `claude -p "/usage"` into percentage values.
   *
   * The exact format of the /usage output is not guaranteed, so we try
   * multiple parsing strategies:
   *
   * 1. Keyword matching — look for lines containing "daily", "weekly",
   *    "sonnet", or "extra" with a percentage nearby.
   * 2. Positional fallback — take the first 2-4 percentage values found
   *    and assign them in order (daily, weekly, sonnet, extra).
   */
  parseUsageOutput(output: string): ParsedUsage | null {
    const result: ParsedUsage = { daily: 0, weekly: 0, sonnet: 0, extra: 0 };

    // Strategy 1: Keyword-based matching on each line
    const lines = output.split('\n');
    for (const line of lines) {
      const lower = line.toLowerCase();
      const pctMatch = line.match(/(\d+(?:\.\d+)?)\s*%/);
      if (!pctMatch) continue;
      const pct = parseFloat(pctMatch[1]);

      if (lower.includes('daily') || lower.includes('dzien')) {
        result.daily = pct;
      } else if (lower.includes('weekly') || lower.includes('tydz') || lower.includes('tygodn')) {
        result.weekly = pct;
      } else if (lower.includes('sonnet')) {
        result.sonnet = pct;
      } else if (lower.includes('extra') || lower.includes('dodatkow')) {
        result.extra = pct;
      }
    }

    // If at least one value was found via keywords, use them
    if (result.daily > 0 || result.weekly > 0 || result.sonnet > 0 || result.extra > 0) {
      return result;
    }

    // Strategy 2: Positional — grab all percentages in document order
    const allPcts = output.match(/(\d+(?:\.\d+)?)\s*%/g);
    if (allPcts && allPcts.length >= 2) {
      const nums = allPcts.map((s) => parseFloat(s));
      result.daily = nums[0] ?? 0;
      result.weekly = nums[1] ?? 0;
      result.sonnet = nums[2] ?? 0;
      result.extra = nums[3] ?? 0;
      return result;
    }

    // Could not parse — log for debugging
    console.log(
      '[UsagePoller] Could not parse usage output:',
      output.substring(0, 500),
    );
    return null;
  }
}

export const usagePoller = new UsagePoller();
