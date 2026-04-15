// =============================================================================
// Fleet Commander — FC Manifest
// =============================================================================
// Single source of truth for all FC-managed files. Discovers files by scanning
// FC's own directories at runtime, eliminating hardcoded file lists scattered
// across project-service.ts, team-manager.ts, and install.sh.
//
// All functions use synchronous fs operations, consistent with the codebase's
// SQLite convention (better-sqlite3 is synchronous).
// =============================================================================

import fs from 'fs';
import path from 'path';
import config from '../config.js';

/**
 * Scan a directory for files matching a glob extension.
 * Returns an array of filenames (not full paths).
 * Returns an empty array if the directory does not exist.
 */
function scanDir(dirPath: string, extension: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath)
    .filter((f) => f.endsWith(extension))
    .sort();
}

/**
 * Get all deployable hook script filenames from FC's hooks/ directory.
 * Returns filenames like ['on_session_start.sh', 'send_event.sh', ...].
 */
export function getHookFiles(): string[] {
  return scanDir(config.fcHooksDir, '.sh');
}

/**
 * Get all agent template filenames from FC's templates/agents/ directory.
 * Returns filenames like ['fleet-dev.md', 'fleet-planner.md', ...].
 */
export function getAgentFiles(): string[] {
  return scanDir(config.fcAgentsDir, '.md');
}

/**
 * Get all guide filenames from FC's templates/guides/ directory.
 * Returns filenames like ['csharp-conventions.md', 'typescript-conventions.md', ...].
 */
export function getGuideFiles(): string[] {
  return scanDir(config.fcGuidesDir, '.md');
}

/**
 * Get the workflow template filename (deployed to .claude/prompts/).
 * Returns 'fleet-workflow.md' — the installed name, not the source name.
 */
export function getWorkflowFile(): string {
  return 'fleet-workflow.md';
}

/**
 * Get the settings example filename.
 * Returns 'settings.json.example'.
 */
export function getSettingsExampleFile(): string {
  return 'settings.json.example';
}

/**
 * Parse the hook event types from hooks/settings.json.example.
 * Returns event type keys like ['SessionStart', 'SessionEnd', 'Stop', ...].
 */
export function getHookEventTypes(): string[] {
  const settingsPath = path.join(config.fcHooksDir, 'settings.json.example');
  if (!fs.existsSync(settingsPath)) return [];
  try {
    const content = fs.readFileSync(settingsPath, 'utf-8');
    const data = JSON.parse(content) as { hooks?: Record<string, unknown> };
    return data.hooks ? Object.keys(data.hooks).sort() : [];
  } catch {
    return [];
  }
}

/**
 * Get the explicit .gitignore entries for FC-managed files that should never
 * be committed to target repos. These are files created/modified at install
 * time or at team runtime that would otherwise pollute `git status`.
 *
 * Returns path strings exactly as they should appear in .gitignore (forward
 * slashes, no globs, no directory-level entries).
 *
 * NOTE: If you add a new FC-managed runtime file, add it here AND in
 * scripts/install.sh step 7 (bash cannot call this function).
 */
export function getGitignoreEntries(): string[] {
  return [
    '.claude/agents/fleet-dev.md',
    '.claude/agents/fleet-planner.md',
    '.claude/agents/fleet-reviewer.md',
    '.claude/settings.json',
    '.claude/prompts/fleet-workflow.md',
    '.claude/scheduled_tasks.lock',
    'changes.md',
    'review.md',
    'plan.md',
    '.fleet-issue-context.md',
    '.fleet-pm-message',
  ];
}

/** Aggregated manifest of all FC-managed files. */
export interface FCManifest {
  /** Hook script filenames (e.g. 'on_session_start.sh') */
  hooks: string[];
  /** Agent template filenames (e.g. 'fleet-planner.md') */
  agents: string[];
  /** Guide filenames (e.g. 'typescript-conventions.md') */
  guides: string[];
  /** Workflow prompt filename (always 'fleet-workflow.md') */
  workflow: string;
  /** Settings example filename (always 'settings.json.example') */
  settingsExample: string;
  /** Explicit .gitignore entries for FC-managed files */
  gitignoreEntries: string[];
}

/**
 * Get the complete manifest of all FC-managed files.
 * This is the single source of truth — all other code should call this
 * instead of maintaining hardcoded file lists.
 */
export function getAllManagedFiles(): FCManifest {
  return {
    hooks: getHookFiles(),
    agents: getAgentFiles(),
    guides: getGuideFiles(),
    workflow: getWorkflowFile(),
    settingsExample: getSettingsExampleFile(),
    gitignoreEntries: getGitignoreEntries(),
  };
}
