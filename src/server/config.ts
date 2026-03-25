import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Return the platform-appropriate default directory for Fleet Commander data files.
 *
 * - Windows:  %APPDATA%\fleet-commander
 * - macOS:    ~/Library/Application Support/fleet-commander
 * - Linux:    $XDG_DATA_HOME/fleet-commander  (default ~/.local/share)
 */
function defaultDataDir(): string {
  const APP_DIR = 'fleet-commander';

  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, APP_DIR);
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_DIR);
  }

  // Linux / other
  const dataHome = process.env['XDG_DATA_HOME'] || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, APP_DIR);
}

/**
 * Return the platform-appropriate default path for the Fleet Commander database.
 *
 * - Windows:  %APPDATA%\fleet-commander\fleet.db
 * - macOS:    ~/Library/Application Support/fleet-commander/fleet.db
 * - Linux:    $XDG_DATA_HOME/fleet-commander/fleet.db  (default ~/.local/share)
 */
export function defaultDbPath(): string {
  return path.join(defaultDataDir(), 'fleet.db');
}

/**
 * Return the platform-appropriate default path for the hook execution log.
 *
 * Lives in the same directory as the database file:
 * - Windows:  %APPDATA%\fleet-commander\hooks.log
 * - macOS:    ~/Library/Application Support/fleet-commander/hooks.log
 * - Linux:    $XDG_DATA_HOME/fleet-commander/hooks.log  (default ~/.local/share)
 */
export function defaultHookLogPath(): string {
  return path.join(defaultDataDir(), 'hooks.log');
}

/**
 * Determine the Fleet Commander package root directory.
 *
 * Resolution order:
 *   1. FLEET_COMMANDER_ROOT env var (set by bin/fleet-commander.js for npm global installs)
 *   2. Walk up from this file's location to find package.json (works for both
 *      development `src/server/config.ts` and compiled `dist/server/config.js`)
 *   3. `git rev-parse --show-toplevel` (for development from a git clone)
 *   4. process.cwd() as last resort
 */
function findFleetCommanderRoot(): string {
  // Strategy 1: Walk up from __dirname to find the package root (has package.json + hooks/)
  // This works whether running from src/ (dev) or dist/ (compiled), and critically,
  // from an npm global install where there is no git repo.
  try {
    const __filename = fileURLToPath(import.meta.url);
    let dir = path.dirname(__filename);
    for (let i = 0; i < 5; i++) {
      if (
        fs.existsSync(path.join(dir, 'package.json')) &&
        fs.existsSync(path.join(dir, 'hooks'))
      ) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // import.meta.url not available or other error
  }

  // Strategy 2: git rev-parse (normalize the path for Windows compatibility —
  // git returns POSIX paths like /c/Users/... which path.join can't handle)
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
    return path.resolve(gitRoot);
  } catch {
    // Not in a git repo
  }

  return process.cwd();
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
  host: process.env['FLEET_HOST'] || '0.0.0.0',
  port: safeParseInt(process.env['PORT'] || '4680', 'PORT'),

  /** Absolute path to the fleet-commander installation itself */
  fleetCommanderRoot,

  githubPollIntervalMs: safeParseInt(process.env['FLEET_GITHUB_POLL_MS'] || '30000', 'FLEET_GITHUB_POLL_MS'),
  issuePollIntervalMs: safeParseInt(process.env['FLEET_ISSUE_POLL_MS'] || '60000', 'FLEET_ISSUE_POLL_MS'),
  stuckCheckIntervalMs: safeParseInt(process.env['FLEET_STUCK_CHECK_MS'] || '60000', 'FLEET_STUCK_CHECK_MS'),
  usagePollIntervalMs: safeParseInt(process.env['FLEET_USAGE_POLL_MS'] || '900000', 'FLEET_USAGE_POLL_MS'),

  idleThresholdMin: safeParseInt(process.env['FLEET_IDLE_THRESHOLD_MIN'] || '5', 'FLEET_IDLE_THRESHOLD_MIN'),
  stuckThresholdMin: safeParseInt(process.env['FLEET_STUCK_THRESHOLD_MIN'] || '10', 'FLEET_STUCK_THRESHOLD_MIN'),
  launchTimeoutMin: safeParseInt(process.env['FLEET_LAUNCH_TIMEOUT_MIN'] || '5', 'FLEET_LAUNCH_TIMEOUT_MIN'),
  maxUniqueCiFailures: safeParseInt(process.env['FLEET_MAX_CI_FAILURES'] || '3', 'FLEET_MAX_CI_FAILURES'),

  /** Seconds after SubagentStart before a SubagentStop is considered an early crash */
  earlyCrashThresholdSec: safeParseInt(process.env['FLEET_EARLY_CRASH_THRESHOLD_SEC'] || '120', 'FLEET_EARLY_CRASH_THRESHOLD_SEC'),

  /** Minimum tool-use events for a subagent session to be considered healthy */
  earlyCrashMinTools: safeParseInt(process.env['FLEET_EARLY_CRASH_MIN_TOOLS'] || '5', 'FLEET_EARLY_CRASH_MIN_TOOLS'),

  eventsRetentionDays: safeParseInt(process.env['FLEET_EVENTS_RETENTION_DAYS'] || '90', 'FLEET_EVENTS_RETENTION_DAYS'),
  usageRetentionDays: safeParseInt(process.env['FLEET_USAGE_RETENTION_DAYS'] || '30', 'FLEET_USAGE_RETENTION_DAYS'),

  usageRedDailyPct: safeParseInt(process.env['FLEET_USAGE_RED_DAILY_PCT'] || '85', 'FLEET_USAGE_RED_DAILY_PCT'),
  usageRedWeeklyPct: safeParseInt(process.env['FLEET_USAGE_RED_WEEKLY_PCT'] || '95', 'FLEET_USAGE_RED_WEEKLY_PCT'),
  usageRedSonnetPct: safeParseInt(process.env['FLEET_USAGE_RED_SONNET_PCT'] || '95', 'FLEET_USAGE_RED_SONNET_PCT'),
  usageRedExtraPct: safeParseInt(process.env['FLEET_USAGE_RED_EXTRA_PCT'] || '95', 'FLEET_USAGE_RED_EXTRA_PCT'),

  claudeCmd: process.env['FLEET_CLAUDE_CMD'] || 'claude',
  skipPermissions: process.env['FLEET_SKIP_PERMISSIONS'] !== 'false',
  enableAgentTeams: process.env['FLEET_ENABLE_AGENT_TEAMS'] !== 'false',

  dbPath: process.env['FLEET_DB_PATH'] || defaultDbPath(),
  hookLogPath: process.env['FLEET_HOOK_LOG'] || defaultHookLogPath(),

  logLevel: process.env['LOG_LEVEL'] || 'info',

  worktreeDir: '.claude/worktrees',
  hookDir: '.claude/hooks/fleet-commander',

  // FC's own source directories (for copying into project worktrees)
  fcHooksDir: path.join(fleetCommanderRoot, 'hooks'),
  fcAgentsDir: path.join(fleetCommanderRoot, 'templates', 'agents'),
  fcGuidesDir: path.join(fleetCommanderRoot, 'templates', 'guides'),
  fcPromptsDir: path.join(fleetCommanderRoot, 'prompts'),
  fcWorkflowTemplate: path.join(fleetCommanderRoot, 'templates', 'workflow.md'),

  mergeShutdownGraceMs: safeParseInt(process.env['FLEET_MERGE_SHUTDOWN_GRACE_MS'] || '120000', 'FLEET_MERGE_SHUTDOWN_GRACE_MS'),

  ccQueryModel: process.env['FLEET_CC_QUERY_MODEL'] || 'sonnet',
  ccQueryTimeoutMs: safeParseInt(process.env['FLEET_CC_QUERY_TIMEOUT_MS'] || '30000', 'FLEET_CC_QUERY_TIMEOUT_MS'),
  ccQueryPrioritizeTimeoutMs: safeParseInt(process.env['FLEET_CC_QUERY_PRIORITIZE_TIMEOUT_MS'] || '300000', 'FLEET_CC_QUERY_PRIORITIZE_TIMEOUT_MS'),
  ccQueryMaxRetries: safeParseInt(process.env['FLEET_CC_QUERY_MAX_RETRIES'] || '2', 'FLEET_CC_QUERY_MAX_RETRIES'),
  ccQueryMaxTurns: safeParseInt(process.env['FLEET_CC_QUERY_MAX_TURNS'] || '4', 'FLEET_CC_QUERY_MAX_TURNS'),

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

// Ensure the database directory exists before any DB access
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

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
    ['launchTimeoutMin', config.launchTimeoutMin],
    ['maxUniqueCiFailures', config.maxUniqueCiFailures],
    ['mergeShutdownGraceMs', config.mergeShutdownGraceMs],
    ['earlyCrashThresholdSec', config.earlyCrashThresholdSec],
    ['earlyCrashMinTools', config.earlyCrashMinTools],
    ['ccQueryMaxTurns', config.ccQueryMaxTurns],
    ['eventsRetentionDays', config.eventsRetentionDays],
    ['usageRetentionDays', config.usageRetentionDays],
  ];
  for (const [name, value] of positiveIntegers) {
    if (isNaN(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer, got: ${value}`);
    }
  }

  const nonNegativeIntegers: Array<[string, number]> = [
    ['idleThresholdMin', config.idleThresholdMin],
    ['stuckThresholdMin', config.stuckThresholdMin],
    ['ccQueryMaxRetries', config.ccQueryMaxRetries],
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
