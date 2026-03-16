import { execSync } from 'child_process';
import path from 'path';

function findFleetCommanderRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  } catch {
    return process.cwd();
  }
}

const fleetCommanderRoot = process.env['FLEET_COMMANDER_ROOT'] || findFleetCommanderRoot();

const config = Object.freeze({
  port: parseInt(process.env['PORT'] || '4680', 10),

  /** Absolute path to the fleet-commander installation itself */
  fleetCommanderRoot,

  /**
   * @deprecated Use per-project repoPath from the projects table instead.
   * Kept as fallback for services not yet migrated to per-project context.
   */
  repoRoot: process.env['FLEET_REPO_ROOT'] || fleetCommanderRoot,

  /**
   * @deprecated Use per-project githubRepo from the projects table instead.
   * Kept as fallback for services not yet migrated to per-project context.
   */
  githubRepo: process.env['FLEET_GITHUB_REPO'] || 'itsg-global-agentic/itsg-kea',

  githubPollIntervalMs: parseInt(process.env['FLEET_GITHUB_POLL_MS'] || '30000', 10),
  issuePollIntervalMs: parseInt(process.env['FLEET_ISSUE_POLL_MS'] || '60000', 10),
  stuckCheckIntervalMs: parseInt(process.env['FLEET_STUCK_CHECK_MS'] || '60000', 10),
  usagePollIntervalMs: parseInt(process.env['FLEET_USAGE_POLL_MS'] || '300000', 10),

  idleThresholdMin: parseInt(process.env['FLEET_IDLE_THRESHOLD_MIN'] || '5', 10),
  stuckThresholdMin: parseInt(process.env['FLEET_STUCK_THRESHOLD_MIN'] || '15', 10),
  maxUniqueCiFailures: parseInt(process.env['FLEET_MAX_CI_FAILURES'] || '3', 10),

  claudeCmd: process.env['FLEET_CLAUDE_CMD'] || 'claude',
  defaultPrompt: process.env['FLEET_DEFAULT_PROMPT'] || '/next-issue-kea',
  skipPermissions: process.env['FLEET_SKIP_PERMISSIONS'] !== 'false',

  dbPath: process.env['FLEET_DB_PATH'] || path.join(fleetCommanderRoot, 'fleet.db'),

  logLevel: process.env['LOG_LEVEL'] || 'info',

  worktreeDir: '.claude/worktrees',
  hookDir: '.claude/hooks/fleet-commander',

  // FC's own hooks/ directory (source for copying into project worktrees)
  fcHooksDir: path.join(fleetCommanderRoot, 'hooks'),

  outputBufferLines: 500,
  sseHeartbeatMs: 30000,
});

// Validate config
function validateConfig(): void {
  if (config.port < 1 || config.port > 65535) {
    throw new Error(`Invalid port: ${config.port}`);
  }
  if (config.idleThresholdMin < 0) {
    throw new Error(`Invalid idleThresholdMin: ${config.idleThresholdMin}`);
  }
  if (config.stuckThresholdMin < 0) {
    throw new Error(`Invalid stuckThresholdMin: ${config.stuckThresholdMin}`);
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
