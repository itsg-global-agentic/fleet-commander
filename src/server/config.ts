import { execSync } from 'child_process';
import path from 'path';

function findFleetCommanderRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  } catch {
    return process.cwd();
  }
}

/** Parse an integer from a string, throwing if the result is NaN. */
export function safeParseInt(value: string, name: string): number {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid integer for ${name}: "${value}"`);
  }
  return parsed;
}

const fleetCommanderRoot = process.env['FLEET_COMMANDER_ROOT'] || findFleetCommanderRoot();

const config = Object.freeze({
  port: safeParseInt(process.env['PORT'] || '4680', 'PORT'),

  /** Absolute path to the fleet-commander installation itself */
  fleetCommanderRoot,

  githubPollIntervalMs: safeParseInt(process.env['FLEET_GITHUB_POLL_MS'] || '30000', 'FLEET_GITHUB_POLL_MS'),
  issuePollIntervalMs: safeParseInt(process.env['FLEET_ISSUE_POLL_MS'] || '60000', 'FLEET_ISSUE_POLL_MS'),
  stuckCheckIntervalMs: safeParseInt(process.env['FLEET_STUCK_CHECK_MS'] || '60000', 'FLEET_STUCK_CHECK_MS'),
  usagePollIntervalMs: safeParseInt(process.env['FLEET_USAGE_POLL_MS'] || '120000', 'FLEET_USAGE_POLL_MS'),

  idleThresholdMin: safeParseInt(process.env['FLEET_IDLE_THRESHOLD_MIN'] || '5', 'FLEET_IDLE_THRESHOLD_MIN'),
  stuckThresholdMin: safeParseInt(process.env['FLEET_STUCK_THRESHOLD_MIN'] || '15', 'FLEET_STUCK_THRESHOLD_MIN'),
  maxUniqueCiFailures: safeParseInt(process.env['FLEET_MAX_CI_FAILURES'] || '3', 'FLEET_MAX_CI_FAILURES'),

  usageRedDailyPct: safeParseInt(process.env['FLEET_USAGE_RED_DAILY_PCT'] || '85', 'FLEET_USAGE_RED_DAILY_PCT'),
  usageRedWeeklyPct: safeParseInt(process.env['FLEET_USAGE_RED_WEEKLY_PCT'] || '95', 'FLEET_USAGE_RED_WEEKLY_PCT'),
  usageRedSonnetPct: safeParseInt(process.env['FLEET_USAGE_RED_SONNET_PCT'] || '95', 'FLEET_USAGE_RED_SONNET_PCT'),
  usageRedExtraPct: safeParseInt(process.env['FLEET_USAGE_RED_EXTRA_PCT'] || '95', 'FLEET_USAGE_RED_EXTRA_PCT'),

  claudeCmd: process.env['FLEET_CLAUDE_CMD'] || 'claude',
  skipPermissions: process.env['FLEET_SKIP_PERMISSIONS'] !== 'false',

  dbPath: process.env['FLEET_DB_PATH'] || path.join(fleetCommanderRoot, 'fleet.db'),

  logLevel: process.env['LOG_LEVEL'] || 'info',

  worktreeDir: '.claude/worktrees',
  hookDir: '.claude/hooks/fleet-commander',

  // FC's own hooks/ directory (source for copying into project worktrees)
  fcHooksDir: path.join(fleetCommanderRoot, 'hooks'),

  outputBufferLines: 500,
  sseHeartbeatMs: 30000,

  /**
   * Terminal preference for interactive (non-headless) mode on Windows.
   *   'auto' — try Windows Terminal (wt.exe) first, fall back to cmd.exe
   *   'wt'   — force Windows Terminal
   *   'cmd'  — force classic cmd.exe
   */
  terminalCmd: (process.env['FLEET_TERMINAL'] || 'auto') as 'auto' | 'wt' | 'cmd',
});

// Validate config
export function validateConfig(): void {
  if (isNaN(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error(`Invalid port: ${config.port}`);
  }

  const positiveIntegers: Array<[string, number]> = [
    ['githubPollIntervalMs', config.githubPollIntervalMs],
    ['issuePollIntervalMs', config.issuePollIntervalMs],
    ['stuckCheckIntervalMs', config.stuckCheckIntervalMs],
    ['usagePollIntervalMs', config.usagePollIntervalMs],
    ['maxUniqueCiFailures', config.maxUniqueCiFailures],
  ];
  for (const [name, value] of positiveIntegers) {
    if (isNaN(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer, got: ${value}`);
    }
  }

  const nonNegativeIntegers: Array<[string, number]> = [
    ['idleThresholdMin', config.idleThresholdMin],
    ['stuckThresholdMin', config.stuckThresholdMin],
  ];
  for (const [name, value] of nonNegativeIntegers) {
    if (isNaN(value) || value < 0) {
      throw new Error(`${name} must be a non-negative integer, got: ${value}`);
    }
  }

  if (config.stuckThresholdMin <= config.idleThresholdMin) {
    throw new Error(
      `stuckThresholdMin (${config.stuckThresholdMin}) must be > idleThresholdMin (${config.idleThresholdMin})`
    );
  }
}

validateConfig();

export default config;
export type Config = typeof config;
