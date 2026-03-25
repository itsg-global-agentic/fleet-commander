// =============================================================================
// Fleet Commander — Project Service
// =============================================================================
// Manages project CRUD operations, hook installation, and prompt file I/O.
// Owns all business logic, DB calls, SSE broadcasts, filesystem operations,
// and CLI calls related to projects.
// =============================================================================

import fs from 'fs';
import path from 'path';
import { getDatabase } from '../db.js';
import { getTeamManager } from './team-manager.js';
import { getIssueFetcher } from './issue-fetcher.js';
import { sseBroker } from './sse-broker.js';
import { installHooks, uninstallHooks } from '../utils/hook-installer.js';
import config from '../config.js';
import { execGitAsync, execGHAsync, execGHResult } from '../utils/exec-gh.js';
import { execSync } from 'child_process';
import type { ProjectStatus, InstallStatus, InstallFileStatus, RepoSettings, GitCommitStatus, GitCommitFileStatus, GitCommitHealth, ProjectReadiness } from '../../shared/types.js';
import { ServiceError, validationError, notFoundError, conflictError } from './service-error.js';
import { getPackageVersion } from '../utils/version.js';
import { getHookFiles as getManifestHookFiles, getAgentFiles as getManifestAgentFiles, getGuideFiles as getManifestGuideFiles, getWorkflowFile } from '../utils/fc-manifest.js';
import { getCleanupPreview as _getCleanupPreview, executeCleanup as _executeCleanup } from './cleanup.js';
import type { CleanupPreview, CleanupResult } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a file path to use forward slashes (cross-platform).
 */
function normalizePath(p: string): string {
  return path.resolve(p).replace(/\\/g, '/');
}

/**
 * Check if a directory is a git repository (async to avoid blocking event loop).
 */
async function isGitRepo(dirPath: string): Promise<boolean> {
  const result = await execGitAsync('git rev-parse --is-inside-work-tree', { cwd: dirPath });
  return result !== null;
}

/**
 * Auto-detect the GitHub repo (owner/name) for a local git repo via gh CLI.
 * Returns null if detection fails (non-fatal). Async to avoid blocking event loop.
 */
async function detectGithubRepo(dirPath: string): Promise<string | null> {
  const result = await execGHAsync(
    'gh repo view --json nameWithOwner -q .nameWithOwner',
    { cwd: dirPath, timeout: 10_000 },
  );
  return result?.trim() || null;
}

/**
 * Check whether a file contains CRLF line endings by reading its first 512 bytes.
 */
function fileHasCrlf(filePath: string): boolean {
  try {
    const buf = Buffer.alloc(512);
    const fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    return buf.subarray(0, bytesRead).includes(0x0D);
  } catch {
    return false;
  }
}

/**
 * Check GitHub repository settings (auto-merge, branch protection) via `gh api`.
 * Returns undefined if githubRepo is not provided or the `gh` CLI call fails.
 * Async to avoid blocking the event loop.
 *
 * @param githubRepo - GitHub repo slug (e.g. "owner/repo"), or null/undefined
 * @returns RepoSettings or undefined on failure
 */
export async function checkRepoSettings(githubRepo: string | null | undefined): Promise<RepoSettings | undefined> {
  if (!githubRepo) return undefined;

  try {
    const repoJson = await execGHAsync(
      `gh api repos/${githubRepo} --jq "{allow_auto_merge, default_branch}"`,
      { timeout: 10_000 },
    );

    if (!repoJson) return undefined;

    const repoData = JSON.parse(repoJson.trim()) as {
      allow_auto_merge?: boolean;
      default_branch?: string;
    };

    const defaultBranch = repoData.default_branch ?? 'main';
    const result: RepoSettings = {
      autoMergeEnabled: repoData.allow_auto_merge ?? false,
      defaultBranch,
    };

    // Branch protection may not be configured — 404 is expected
    const protectionJson = await execGHAsync(
      `gh api repos/${githubRepo}/branches/${defaultBranch}/protection --jq "{required_status_checks}"`,
      { timeout: 10_000 },
    );

    if (protectionJson) {
      try {
        const protectionData = JSON.parse(protectionJson.trim()) as {
          required_status_checks?: {
            contexts?: string[];
          } | null;
        };

        result.branchProtection = {
          enabled: true,
          requiredChecks: protectionData.required_status_checks?.contexts ?? [],
        };
      } catch {
        result.branchProtection = { enabled: false, requiredChecks: [] };
      }
    } else {
      // Branch protection not configured or not accessible — that's fine
      result.branchProtection = { enabled: false, requiredChecks: [] };
    }

    return result;
  } catch {
    // JSON parse error or other unexpected failure
    return undefined;
  }
}

/**
 * Extract Fleet Commander version stamp from the first few lines of a file.
 * Supports shell scripts (`# fleet-commander vX.Y.Z`), markdown
 * files (`<!-- fleet-commander vX.Y.Z -->`), and YAML frontmatter
 * fields (`_fleetCommanderVersion: "X.Y.Z"`).
 * For shell scripts the stamp is on line 2 (after the shebang); for
 * markdown files it is on line 1 or inside YAML frontmatter.
 *
 * @param filePath - Absolute path to the installed file
 * @returns The version string (e.g. "0.0.6") or undefined if not found
 */
function extractVersionStamp(filePath: string): string | undefined {
  try {
    // Read first 512 bytes — the stamp is within the first few lines
    const buf = Buffer.alloc(512);
    const fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    const header = buf.subarray(0, bytesRead).toString('utf-8');
    // Try HTML comment / shell comment format first
    const match = header.match(/fleet-commander v(\d+\.\d+\.\d+)/);
    if (match) return match[1];
    // Try YAML frontmatter field (used by agent .md files)
    const yamlMatch = header.match(/_fleetCommanderVersion:\s*"(\d+\.\d+\.\d+)"/);
    return yamlMatch ? yamlMatch[1] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract Fleet Commander version from a JSON file's `_fleetCommanderVersion` field.
 *
 * @param filePath - Absolute path to the JSON file
 * @returns The version string (e.g. "0.0.6") or undefined if not found
 */
function extractJsonVersionStamp(filePath: string): string | undefined {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content);
    const ver = data._fleetCommanderVersion;
    return typeof ver === 'string' ? ver : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract Fleet Commander version stamp from a string content (e.g. from `git show`).
 * Supports shell comment (`# fleet-commander vX.Y.Z`), HTML comment
 * (`<!-- fleet-commander vX.Y.Z -->`), YAML frontmatter (`_fleetCommanderVersion: "X.Y.Z"`),
 * and JSON (`"_fleetCommanderVersion": "X.Y.Z"`).
 *
 * @param content - File content string (typically first 512 chars)
 * @returns The version string (e.g. "0.0.6") or undefined if not found
 */
function extractVersionStampFromContent(content: string): string | undefined {
  // Try HTML comment / shell comment format first
  const match = content.match(/fleet-commander v(\d+\.\d+\.\d+)/);
  if (match) return match[1];
  // Try YAML frontmatter field (used by agent .md files)
  const yamlMatch = content.match(/_fleetCommanderVersion:\s*"(\d+\.\d+\.\d+)"/);
  if (yamlMatch) return yamlMatch[1];
  // Try JSON field (used by settings.json)
  const jsonMatch = content.match(/"_fleetCommanderVersion":\s*"(\d+\.\d+\.\d+)"/);
  if (jsonMatch) return jsonMatch[1];
  return undefined;
}

/**
 * Detect the default branch for a git repository by checking `refs/remotes/origin/HEAD`.
 * Falls back to `origin/main` then `origin/master` if symbolic-ref fails.
 *
 * @param repoPath - Absolute path to the git repository
 * @returns The remote default branch ref (e.g. "origin/main") or undefined if not detectable
 */
function detectDefaultBranch(repoPath: string): string | undefined {
  try {
    const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD --short', {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (ref) return ref;
  } catch {
    // symbolic-ref failed — try common branch names
  }

  // Try origin/main
  try {
    execSync('git rev-parse --verify origin/main', {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return 'origin/main';
  } catch {
    // origin/main does not exist
  }

  // Try origin/master
  try {
    execSync('git rev-parse --verify origin/master', {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return 'origin/master';
  } catch {
    // origin/master does not exist either
  }

  return undefined;
}

/**
 * Check whether `.claude/` files are committed to the default branch of a git repository.
 * Returns a GitCommitStatus describing:
 * - whether .claude is gitignored
 * - which expected files are committed
 * - version stamps of committed files vs current FC version
 * - overall health (green/amber/red)
 *
 * All git commands are wrapped in try/catch — if git fails (not a git repo,
 * no remote), this returns `undefined` rather than crashing.
 *
 * @param repoPath - Absolute path to the target repository
 * @returns GitCommitStatus or undefined if the check cannot be performed
 */
export function checkGitCommitStatus(repoPath: string): GitCommitStatus | undefined {
  try {
    // Detect default branch
    const defaultBranch = detectDefaultBranch(repoPath);
    if (!defaultBranch) return undefined;

    const shortBranch = defaultBranch.replace(/^origin\//, '');
    const currentVersion = getPackageVersion();

    // Check if .claude/ is gitignored
    let gitignored = false;
    try {
      execSync('git check-ignore .claude/', {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // Exit code 0 means .claude/ IS ignored
      gitignored = true;
    } catch {
      // Non-zero exit means .claude/ is NOT ignored (good)
    }

    if (gitignored) {
      return {
        health: 'red',
        gitignored: true,
        defaultBranch: shortBranch,
        files: [],
        message: `.claude/ in .gitignore — remove it and commit .claude/`,
      };
    }

    // List committed .claude/ files on the default branch
    let committedPaths: string[] = [];
    try {
      const output = execSync(`git ls-tree -r --name-only ${defaultBranch} -- .claude/`, {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      committedPaths = output ? output.split('\n').map((l) => l.trim()).filter(Boolean) : [];
    } catch {
      // ls-tree failed — the branch may not have any .claude/ files
    }

    const committedSet = new Set(committedPaths);

    // Build expected files from the manifest (single source of truth)
    const manifestAgents = getManifestAgentFiles();
    const expectedFiles: string[] = [
      '.claude/settings.json',
      `.claude/prompts/${getWorkflowFile()}`,
      ...manifestAgents.map((a) => `.claude/agents/${a}`),
      // Check a representative sample of hooks
      '.claude/hooks/fleet-commander/send_event.sh',
      '.claude/hooks/fleet-commander/on_session_start.sh',
      '.claude/hooks/fleet-commander/on_session_end.sh',
    ];

    const fileStatuses: GitCommitFileStatus[] = [];
    let allCommitted = true;
    let anyOutdated = false;

    for (const filePath of expectedFiles) {
      const committed = committedSet.has(filePath);
      const fileStatus: GitCommitFileStatus = {
        path: filePath,
        committed,
        currentVersion,
      };

      if (committed) {
        // Extract version stamp from committed copy
        try {
          const content = execSync(`git show ${defaultBranch}:${filePath}`, {
            cwd: repoPath,
            encoding: 'utf-8',
            timeout: 5_000,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          // Only check first 512 chars for version stamp
          const header = content.slice(0, 512);
          fileStatus.committedVersion = extractVersionStampFromContent(header);
          if (fileStatus.committedVersion && fileStatus.committedVersion !== currentVersion) {
            anyOutdated = true;
          }
        } catch {
          // git show failed — skip version check
        }
      } else {
        allCommitted = false;
      }

      fileStatuses.push(fileStatus);
    }

    // Also check if ALL hooks from the fleet-commander directory are committed
    const hookPrefix = '.claude/hooks/fleet-commander/';
    const committedHooks = committedPaths.filter((p) => p.startsWith(hookPrefix));
    // Use manifest as single source of truth for hook filenames
    const manifestHooks = getManifestHookFiles();
    const missingHooks = manifestHooks.filter((h) => !committedSet.has(hookPrefix + h));
    if (missingHooks.length > 0) {
      allCommitted = false;
    }

    // Compute health
    let health: GitCommitHealth;
    let message: string;

    if (!allCommitted && !anyOutdated) {
      // Files genuinely not committed (not a version upgrade scenario)
      health = 'red';
      const missingCount = fileStatuses.filter((f) => !f.committed).length + missingHooks.length;
      message = `${missingCount} .claude/ file${missingCount === 1 ? '' : 's'} not committed to ${shortBranch}`;
    } else if (!allCommitted && anyOutdated) {
      // Some files missing + some outdated = likely a version upgrade
      // Missing files are new in this FC version, not user error
      health = 'amber';
      const outdatedVersion = fileStatuses.find(
        (f) => f.committed && f.committedVersion && f.committedVersion !== currentVersion,
      )?.committedVersion;
      message = outdatedVersion
        ? `Outdated (v${outdatedVersion} → v${currentVersion}) — reinstall and commit to update`
        : `Committed to ${shortBranch} but some files outdated — reinstall and commit to update`;
    } else if (anyOutdated) {
      // All files committed but some have older version stamps
      health = 'amber';
      const outdatedVersion = fileStatuses.find(
        (f) => f.committed && f.committedVersion && f.committedVersion !== currentVersion,
      )?.committedVersion;
      const outdatedCount = fileStatuses.filter(
        (f) => f.committed && f.committedVersion && f.committedVersion !== currentVersion,
      ).length;
      message = outdatedVersion
        ? `Outdated (v${outdatedVersion} → v${currentVersion}) — reinstall and commit to update`
        : `Committed to ${shortBranch} but ${outdatedCount} file${outdatedCount === 1 ? '' : 's'} outdated`;
    } else {
      health = 'green';
      message = `All .claude/ files committed to ${shortBranch}`;
    }

    return {
      health,
      gitignored: false,
      defaultBranch: shortBranch,
      files: fileStatuses,
      message,
    };
  } catch {
    // Any unexpected failure — return undefined (unknown)
    return undefined;
  }
}

/**
 * Check the install status of artifacts deployed by install.sh:
 * hooks directory and workflow prompt.
 * Returns detailed file-level breakdown for tooltip display.
 *
 * @param repoPath - Absolute path to the target repository
 * @returns InstallStatus with hooks, prompt, agents, guides, and settings info
 */
export function checkInstallStatus(repoPath: string): InstallStatus {
  // Use manifest as single source of truth for file lists
  const hookNames = getManifestHookFiles();

  const currentVersion = getPackageVersion();

  const hooksDir = path.join(repoPath, '.claude', 'hooks', 'fleet-commander');
  const hookFiles: InstallFileStatus[] = hookNames.map((name) => {
    const filePath = path.join(hooksDir, name);
    const exists = fs.existsSync(filePath);
    const installedVersion = exists ? extractVersionStamp(filePath) : undefined;
    return {
      name,
      exists,
      hasCrlf: exists ? fileHasCrlf(filePath) : false,
      installedVersion,
      currentVersion,
    };
  });
  const hookFoundCount = hookFiles.filter((f) => f.exists).length;
  const hookHasCrlf = hookFiles.some((f) => f.hasCrlf);

  const workflowName = getWorkflowFile();
  const workflowPath = path.join(repoPath, '.claude', 'prompts', workflowName);
  const workflowExists = fs.existsSync(workflowPath);
  const promptFiles: InstallFileStatus[] = [
    {
      name: workflowName,
      exists: workflowExists,
      installedVersion: workflowExists ? extractVersionStamp(workflowPath) : undefined,
      currentVersion,
    },
  ];

  const agentNames = getManifestAgentFiles();
  const agentsDir = path.join(repoPath, '.claude', 'agents');
  const agentFiles: InstallFileStatus[] = agentNames.map((name) => {
    const filePath = path.join(agentsDir, name);
    const exists = fs.existsSync(filePath);
    return {
      name,
      exists,
      installedVersion: exists ? extractVersionStamp(filePath) : undefined,
      currentVersion,
    };
  });

  const guideNames = getManifestGuideFiles();
  const guidesDir = path.join(repoPath, '.claude', 'guides');
  const guideFiles: InstallFileStatus[] = guideNames.map((name) => {
    const filePath = path.join(guidesDir, name);
    const exists = fs.existsSync(filePath);
    return {
      name,
      exists,
      installedVersion: exists ? extractVersionStamp(filePath) : undefined,
      currentVersion,
    };
  });

  const settingsPath = path.join(repoPath, '.claude', 'settings.json');
  const settingsExists = fs.existsSync(settingsPath);
  const settingsFile: InstallFileStatus = {
    name: 'settings.json',
    exists: settingsExists,
    installedVersion: settingsExists ? extractJsonVersionStamp(settingsPath) : undefined,
    currentVersion,
  };

  // Count files that exist but have a mismatched or missing version stamp
  const allFiles = [...hookFiles, ...promptFiles, ...agentFiles, ...guideFiles, settingsFile];
  const outdatedCount = allFiles.filter(
    (f) => f.exists && f.installedVersion !== currentVersion,
  ).length;

  // Check git commit status for .claude/ files on the default branch
  const gitCommitStatus = checkGitCommitStatus(repoPath);

  return {
    hooks: {
      installed: hookFoundCount === hookNames.length && !hookHasCrlf,
      total: hookNames.length,
      found: hookFoundCount,
      files: hookFiles,
    },
    prompt: {
      installed: promptFiles.every((f) => f.exists),
      files: promptFiles,
    },
    agents: {
      installed: agentFiles.every((f) => f.exists),
      files: agentFiles,
    },
    guides: {
      installed: guideFiles.length > 0 && guideFiles.every((f) => f.exists),
      files: guideFiles,
    },
    settings: settingsFile,
    outdatedCount,
    currentVersion,
    gitCommitStatus,
  };
}

// ---------------------------------------------------------------------------
// TTL-based install status cache
// ---------------------------------------------------------------------------

interface InstallStatusCacheEntry {
  status: InstallStatus;
  cachedAt: number;
}

/** In-memory cache for checkInstallStatus(), keyed by repoPath */
const _installStatusCache: Map<string, InstallStatusCacheEntry> = new Map();

/** Cache TTL in milliseconds (30 seconds) */
const INSTALL_STATUS_CACHE_TTL_MS = 30_000;

/**
 * Invalidate the install status cache for a specific repo path.
 * Called after install/uninstall/create operations.
 */
function invalidateInstallStatusCache(repoPath: string): void {
  _installStatusCache.delete(repoPath);
}

// ---------------------------------------------------------------------------
// Minimal logger for use outside Fastify request context
// ---------------------------------------------------------------------------

const _minimalLogger = {
  info: (...args: unknown[]) => console.log('[ProjectService]', ...args),
  warn: (...args: unknown[]) => console.warn('[ProjectService]', ...args),
  error: (...args: unknown[]) => console.error('[ProjectService]', ...args),
} as any;

// ---------------------------------------------------------------------------
// Readiness evaluation (pure function, no side effects)
// ---------------------------------------------------------------------------

/**
 * Evaluate project readiness for launching teams from an InstallStatus.
 * Pure function — no DB or filesystem access — suitable for unit testing.
 */
export function evaluateProjectReadiness(status: InstallStatus): ProjectReadiness {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Blocking: hooks not installed (distinguish CRLF issue from missing hooks)
  if (!status.hooks.installed) {
    const hasCrlf = status.hooks.files.some((f) => f.hasCrlf);
    if (hasCrlf) {
      errors.push('Hook scripts have CRLF line endings — reinstall to fix');
    } else {
      errors.push(
        `Hooks not installed (${status.hooks.found}/${status.hooks.total} found)`,
      );
    }
  }

  // Blocking: prompt file not installed
  if (!status.prompt.installed) {
    errors.push('Prompt file not installed');
  }

  // Blocking: agent files not installed
  if (!status.agents.installed) {
    errors.push('Agent files not installed');
  }

  // Blocking: settings.json not installed
  if (!status.settings.exists) {
    errors.push('Settings file (settings.json) not installed');
  }

  // Blocking: .claude/ in .gitignore
  if (status.gitCommitStatus?.gitignored) {
    errors.push('.claude/ is in .gitignore — files will not be available on branches');
  }

  // Blocking: git commit health is red (files not committed)
  if (
    status.gitCommitStatus?.health === 'red' &&
    !status.gitCommitStatus.gitignored // already covered above
  ) {
    errors.push(
      `Git commit check failed: ${status.gitCommitStatus.message}`,
    );
  }

  // Blocking: outdated files (version mismatch)
  if (status.outdatedCount > 0) {
    errors.push(
      `${status.outdatedCount} installed file(s) are outdated — reinstall to update`,
    );
  }

  // Blocking: git commit health is amber (outdated on branch)
  if (status.gitCommitStatus?.health === 'amber') {
    errors.push(
      `Git commit check: ${status.gitCommitStatus.message}`,
    );
  }

  return {
    ready: errors.length === 0,
    warnings,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ProjectService {
  /**
   * List all projects with team counts and live install status.
   * Optionally filter by project status.
   *
   * @param statusFilter - Optional status to filter by ('active' | 'archived')
   * @returns Array of project summaries enriched with install status
   * @throws ServiceError with code VALIDATION if status filter is invalid
   */
  listProjects(statusFilter?: ProjectStatus): unknown[] {
    if (statusFilter) {
      const validStatuses: ProjectStatus[] = ['active', 'archived'];
      if (!validStatuses.includes(statusFilter)) {
        throw validationError(
          `Invalid status filter. Must be one of: ${validStatuses.join(', ')}`,
        );
      }
    }

    const db = getDatabase();
    const summaries = db.getProjectSummaries();
    const filtered = statusFilter
      ? summaries.filter((p) => p.status === statusFilter)
      : summaries;

    return filtered.map((p) => {
      const now = Date.now();
      const cached = _installStatusCache.get(p.repoPath);
      let installStatus: InstallStatus;
      if (cached && (now - cached.cachedAt) < INSTALL_STATUS_CACHE_TTL_MS) {
        installStatus = cached.status;
      } else {
        installStatus = checkInstallStatus(p.repoPath);
        _installStatusCache.set(p.repoPath, { status: installStatus, cachedAt: now });
      }
      return { ...p, installStatus };
    });
  }

  /**
   * Evaluate a project's readiness for launching teams.
   * Checks install status (hooks, prompt, agents) and git commit status.
   *
   * @param projectId - The project ID
   * @returns ProjectReadiness with ready flag, warnings, and errors
   * @throws ServiceError with code NOT_FOUND if project doesn't exist
   */
  getProjectReadiness(projectId: number): ProjectReadiness {
    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) {
      throw notFoundError(`Project ${projectId} not found`);
    }

    const status = checkInstallStatus(project.repoPath);
    return evaluateProjectReadiness(status);
  }

  /**
   * Create a new project with full orchestration:
   * validate input, detect GitHub repo, create prompt file, insert DB record,
   * install hooks, and broadcast SSE event.
   *
   * @param data - Project creation data
   * @returns The created project record
   * @throws ServiceError with code VALIDATION for invalid input
   * @throws ServiceError with code CONFLICT for duplicate repo path
   */
  async createProject(data: {
    name: string;
    repoPath: string;
    githubRepo?: string;
    maxActiveTeams?: number;
    model?: string;
  }): Promise<unknown> {
    const { name, repoPath, githubRepo, maxActiveTeams, model } = data;

    // Validate name
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw validationError('name is required and must be a non-empty string');
    }

    // Validate repoPath
    if (!repoPath || typeof repoPath !== 'string' || repoPath.trim().length === 0) {
      throw validationError('repoPath is required and must be a non-empty string');
    }

    const normalizedPath = normalizePath(repoPath);

    if (!fs.existsSync(normalizedPath)) {
      throw validationError(`Path does not exist: ${normalizedPath}`);
    }

    if (!(await isGitRepo(normalizedPath))) {
      throw validationError(`Path is not a git repository: ${normalizedPath}`);
    }

    // Check for duplicate repo_path
    const db = getDatabase();
    const existing = db.getProjectByRepoPath(normalizedPath);
    if (existing) {
      throw conflictError(
        `A project already exists for this path: ${normalizedPath} (project: ${existing.name})`,
      );
    }

    // Auto-detect githubRepo if not provided
    const resolvedGithubRepo = githubRepo || await detectGithubRepo(normalizedPath);

    // Validate maxActiveTeams if provided
    if (maxActiveTeams !== undefined) {
      if (typeof maxActiveTeams !== 'number' || maxActiveTeams < 1 || maxActiveTeams > 50) {
        throw validationError('maxActiveTeams must be a number between 1 and 50');
      }
    }

    // Create project-specific prompt file from default template
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const promptRelPath = `prompts/${slug}-prompt.md`;
    const promptAbsPath = path.join(config.fleetCommanderRoot, promptRelPath);
    const defaultPromptPath = path.join(config.fleetCommanderRoot, 'prompts', 'default-prompt.md');

    try {
      fs.mkdirSync(path.join(config.fleetCommanderRoot, 'prompts'), { recursive: true });

      if (!fs.existsSync(promptAbsPath)) {
        if (fs.existsSync(defaultPromptPath)) {
          fs.copyFileSync(defaultPromptPath, promptAbsPath);
        } else {
          fs.writeFileSync(promptAbsPath,
            'Read the ENTIRE file `.claude/prompts/fleet-workflow.md` before taking any actions.\n' +
            'You are the TL. There is NO coordinator — you orchestrate the Diamond team directly.\n' +
            'Phase 0: Spawn fleet-planner. Wait for plan. Phase 1: Spawn fleet-dev WITH the planner\'s plan. Wait for ready. Phase 2: Spawn fleet-reviewer. Planner stays alive for p2p questions.\n' +
            'Issue: #{{ISSUE_NUMBER}}\n',
            'utf-8',
          );
        }
      }
    } catch (promptErr: unknown) {
      console.warn('[ProjectService] Failed to create project prompt file (non-fatal):', promptErr);
    }

    // Insert the project
    const project = db.insertProject({
      name: name.trim(),
      repoPath: normalizedPath,
      githubRepo: resolvedGithubRepo,
      maxActiveTeams: maxActiveTeams ?? 5,
      promptFile: promptRelPath,
      model: model?.trim() || null,
    });

    // Install hooks (non-fatal)
    const installResult = installHooks(normalizedPath, _minimalLogger);
    if (!installResult.ok) {
      console.warn(`[ProjectService] Hook installation failed for ${normalizedPath}: ${installResult.stderr}`);
    }

    // Invalidate install status cache after installation
    invalidateInstallStatusCache(normalizedPath);

    // Verify artifacts were actually installed
    const status = checkInstallStatus(normalizedPath);
    const allInstalled = status.hooks.installed && status.prompt.installed;
    if (allInstalled) {
      db.updateProject(project.id, { hooksInstalled: true });
    }

    // Re-fetch to get updated hooks_installed
    const finalProject = db.getProject(project.id)!;

    // Ensure the issue fetcher's polling loop is running
    const issueFetcher = getIssueFetcher();
    issueFetcher.start();

    // Broadcast SSE event
    sseBroker.broadcast('project_added', {
      project_id: finalProject.id,
      name: finalProject.name,
      repo_path: finalProject.repoPath,
    });

    return finalProject;
  }

  /**
   * Get detailed project info with team counts.
   *
   * @param projectId - The project ID
   * @returns Project detail with team counts
   * @throws ServiceError with code NOT_FOUND if project doesn't exist
   */
  getProjectDetail(projectId: number): unknown {
    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) {
      throw notFoundError(`Project ${projectId} not found`);
    }

    const teams = db.getTeams({ projectId });
    const activeStatuses = ['launching', 'running', 'idle', 'stuck'];
    const activeCount = teams.filter((t) => activeStatuses.includes(t.status)).length;
    const queuedCount = teams.filter((t) => t.status === 'queued').length;

    return {
      ...project,
      teamCount: teams.length,
      activeTeamCount: activeCount,
      queuedTeamCount: queuedCount,
    };
  }

  /**
   * Get GitHub repository settings (auto-merge, branch protection) for a project.
   * This is loaded lazily (on-demand) rather than in the list endpoint,
   * because it makes synchronous `gh api` CLI calls that are slow.
   *
   * @param projectId - The project ID
   * @returns RepoSettings or undefined if not available
   * @throws ServiceError with code NOT_FOUND if project doesn't exist
   */
  async getRepoSettings(projectId: number): Promise<RepoSettings | undefined> {
    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) {
      throw notFoundError(`Project ${projectId} not found`);
    }

    return checkRepoSettings(project.githubRepo);
  }

  /**
   * Delete a project with full teardown: stop teams, uninstall hooks,
   * clear caches, delete DB records, broadcast SSE.
   *
   * @param projectId - The project ID to delete
   * @throws ServiceError with code NOT_FOUND if project doesn't exist
   */
  async deleteProject(projectId: number): Promise<void> {
    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) {
      throw notFoundError(`Project ${projectId} not found`);
    }

    // Mark queued teams as failed before deletion
    const queuedTeams = db.getQueuedTeamsByProject(projectId);
    for (const t of queuedTeams) {
      db.updateTeam(t.id, { status: 'failed' });
    }

    // Stop all active teams for this project
    const activeTeams = db.getTeams({ projectId }).filter((t) =>
      ['launching', 'running', 'idle', 'stuck'].includes(t.status),
    );

    const manager = getTeamManager();
    for (const team of activeTeams) {
      try {
        await manager.stop(team.id);
      } catch {
        // Continue stopping other teams even if one fails
      }
    }

    // Uninstall hooks and invalidate install status cache
    uninstallHooks(project.repoPath, _minimalLogger);
    invalidateInstallStatusCache(project.repoPath);

    // Clear cached issues for this project
    const issueFetcher = getIssueFetcher();
    issueFetcher.clearProject(projectId);

    // Delete all teams and related records
    db.deleteTeamsByProject(projectId);

    // Delete the project from DB
    db.deleteProject(projectId);

    // Broadcast SSE event
    sseBroker.broadcast('project_removed', {
      project_id: projectId,
    });
  }

  /**
   * (Re)install hooks for a project. Verifies artifacts on disk after install
   * and updates the DB accordingly.
   *
   * @param projectId - The project ID
   * @returns Install result with status details
   * @throws ServiceError with code NOT_FOUND if project doesn't exist
   */
  installHooksForProject(projectId: number): {
    ok: boolean;
    output: string;
    error?: string;
    installStatus: InstallStatus;
  } {
    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) {
      throw notFoundError(`Project ${projectId} not found`);
    }

    const result = installHooks(project.repoPath, _minimalLogger);

    // Invalidate cache and check what actually landed on disk
    invalidateInstallStatusCache(project.repoPath);
    const status = checkInstallStatus(project.repoPath);
    const allInstalled = status.hooks.installed && status.prompt.installed;
    db.updateProject(project.id, { hooksInstalled: allInstalled });

    // Broadcast so UI refreshes badges
    sseBroker.broadcast('project_updated', {
      project_id: projectId,
      name: project.name,
      status: project.status,
    });

    return {
      ok: result.ok,
      output: result.stdout.trim(),
      error: result.stderr.trim() || undefined,
      installStatus: status,
    };
  }

  /**
   * Commit .claude/ files to the current branch of the project repository.
   * If `.claude` is in `.gitignore`, removes it first.
   * Runs: `git add -f .claude/` + `git commit -m "..."`.
   *
   * @param projectId - The project ID
   * @param options - Optional: reinstall hooks before committing (amber path)
   * @returns { ok: true } on success, { ok: false, error: string } on failure
   * @throws ServiceError with code NOT_FOUND if project doesn't exist
   */
  commitClaudeFiles(
    projectId: number,
    options?: { reinstall?: boolean },
  ): { ok: boolean; error?: string; message?: string } {
    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) {
      throw notFoundError(`Project ${projectId} not found`);
    }

    const repoPath = project.repoPath;
    const reinstall = options?.reinstall ?? false;

    try {
      // For the amber (update) path, reinstall hooks first so on-disk files
      // are updated to the current version before staging
      if (reinstall) {
        installHooks(repoPath, _minimalLogger);
      }

      // Check if .claude is in .gitignore — remove it if so
      const gitignorePath = path.join(repoPath, '.gitignore');
      if (fs.existsSync(gitignorePath)) {
        const content = fs.readFileSync(gitignorePath, 'utf-8');
        const lines = content.split('\n');
        const filtered = lines.filter((line) => {
          const trimmed = line.trim();
          return trimmed !== '.claude' && trimmed !== '.claude/' && trimmed !== '.claude/**';
        });
        if (filtered.length !== lines.length) {
          fs.writeFileSync(gitignorePath, filtered.join('\n'), 'utf-8');
          // Stage the updated .gitignore
          execSync('git add .gitignore', {
            cwd: repoPath,
            encoding: 'utf-8',
            timeout: 5_000,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        }
      }

      // Stage .claude/ directory — use -f to force-add regardless of gitignore rules
      execSync('git add -f .claude/', {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Check if anything was actually staged
      try {
        execSync('git diff --cached --quiet', {
          cwd: repoPath,
          encoding: 'utf-8',
          timeout: 5_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        // Exit code 0 means nothing staged — files already up to date
        invalidateInstallStatusCache(repoPath);
        return { ok: true, message: 'Nothing to commit — files already up to date' };
      } catch {
        // Exit code 1 means there are staged changes — proceed with commit
      }

      // Commit with appropriate message
      const commitMessage = reinstall
        ? 'Update Fleet Commander hooks and agents'
        : 'Add Fleet Commander hooks and agents';
      execSync(`git commit -m "${commitMessage}"`, {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Push to remote — if push fails, report error but keep the commit
      try {
        execSync('git push', {
          cwd: repoPath,
          encoding: 'utf-8',
          timeout: 30_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (pushErr: unknown) {
        const pushMessage = pushErr instanceof Error ? pushErr.message : String(pushErr);
        invalidateInstallStatusCache(repoPath);
        sseBroker.broadcast('project_updated', {
          project_id: projectId,
          name: project.name,
          status: project.status,
        });
        return { ok: true, error: `Committed but push failed: ${pushMessage}` };
      }

      // Invalidate the install status cache so the next check picks up the change
      invalidateInstallStatusCache(repoPath);

      // Broadcast so UI refreshes badges
      sseBroker.broadcast('project_updated', {
        project_id: projectId,
        name: project.name,
        status: project.status,
      });

      return { ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  /**
   * Read the contents of a project's prompt file.
   * Falls back to the default prompt if the project-specific one is missing.
   *
   * @param projectId - The project ID
   * @returns Prompt file contents and metadata
   * @throws ServiceError with code NOT_FOUND if project or prompt file not found
   */
  getPrompt(projectId: number): { promptFile: string; content: string; isDefault: boolean } {
    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) {
      throw notFoundError(`Project ${projectId} not found`);
    }

    if (!project.promptFile) {
      throw notFoundError(`No prompt file configured for project ${projectId}`);
    }

    const absPath = path.join(config.fleetCommanderRoot, project.promptFile);
    if (!fs.existsSync(absPath)) {
      const defaultPath = path.join(config.fleetCommanderRoot, 'prompts', 'default-prompt.md');
      if (fs.existsSync(defaultPath)) {
        const content = fs.readFileSync(defaultPath, 'utf-8');
        return { promptFile: project.promptFile, content, isDefault: true };
      }
      throw notFoundError(`Prompt file not found: ${project.promptFile}`);
    }

    const content = fs.readFileSync(absPath, 'utf-8');
    return { promptFile: project.promptFile, content, isDefault: false };
  }

  /**
   * Save content to a project's prompt file.
   *
   * @param projectId - The project ID
   * @param content - The prompt content to write
   * @returns Prompt file path and saved content
   * @throws ServiceError with code NOT_FOUND if project not found
   * @throws ServiceError with code VALIDATION if content is missing or no prompt file configured
   */
  savePrompt(projectId: number, content: string): { promptFile: string; content: string } {
    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) {
      throw notFoundError(`Project ${projectId} not found`);
    }

    if (content === undefined || typeof content !== 'string') {
      throw validationError('content is required and must be a string');
    }

    if (!project.promptFile) {
      throw validationError(`No prompt file configured for project ${projectId}`);
    }

    const absPath = path.join(config.fleetCommanderRoot, project.promptFile);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf-8');

    return { promptFile: project.promptFile, content };
  }

  /**
   * Update a project's fields (name, status, githubRepo, groupId, etc.).
   * Validates input and broadcasts SSE event.
   *
   * @param projectId - The project ID
   * @param data - Fields to update
   * @returns The updated project record
   * @throws ServiceError with code VALIDATION for invalid input
   * @throws ServiceError with code NOT_FOUND if project doesn't exist
   */
  updateProject(projectId: number, data: {
    name?: string;
    status?: ProjectStatus;
    githubRepo?: string | null;
    groupId?: number | null;
    hooksInstalled?: boolean;
    maxActiveTeams?: number;
    promptFile?: string | null;
    model?: string | null;
  }): unknown {
    if (isNaN(projectId) || projectId < 1) {
      throw validationError('Invalid project ID');
    }

    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) {
      throw notFoundError(`Project ${projectId} not found`);
    }

    const { name, status, githubRepo, groupId, hooksInstalled, maxActiveTeams, promptFile, model } = data;

    // Validate status if provided
    if (status !== undefined) {
      const validStatuses: ProjectStatus[] = ['active', 'archived'];
      if (!validStatuses.includes(status)) {
        throw validationError(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
      }
    }

    // Validate name if provided
    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
      throw validationError('name must be a non-empty string');
    }

    // Validate maxActiveTeams if provided
    if (maxActiveTeams !== undefined) {
      if (typeof maxActiveTeams !== 'number' || maxActiveTeams < 1 || maxActiveTeams > 50) {
        throw validationError('maxActiveTeams must be a number between 1 and 50');
      }
    }

    const updated = db.updateProject(projectId, {
      name: name?.trim(),
      status,
      githubRepo,
      groupId,
      hooksInstalled,
      maxActiveTeams,
      promptFile,
      model: model !== undefined ? (model?.trim() || null) : undefined,
    });

    // Broadcast SSE event
    sseBroker.broadcast('project_updated', {
      project_id: projectId,
      name: updated!.name,
      status: updated!.status,
    });

    return updated;
  }

  /**
   * Get teams belonging to a project.
   *
   * @param projectId - The project ID
   * @returns Array of teams for the project
   * @throws ServiceError with code VALIDATION if projectId is invalid
   * @throws ServiceError with code NOT_FOUND if project doesn't exist
   */
  getProjectTeams(projectId: number): unknown[] {
    if (isNaN(projectId) || projectId < 1) {
      throw validationError('Invalid project ID');
    }

    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) {
      throw notFoundError(`Project ${projectId} not found`);
    }

    return db.getProjectTeams(projectId);
  }

  /**
   * Generate a cleanup preview (dry-run) for a project.
   *
   * @param projectId - The project ID
   * @param resetTeams - If true, include team DB records in preview
   * @returns Cleanup preview with items that would be removed
   * @throws ServiceError with code VALIDATION if projectId is invalid
   * @throws ServiceError with code NOT_FOUND if project doesn't exist
   */
  getCleanupPreview(projectId: number, resetTeams: boolean): CleanupPreview {
    if (isNaN(projectId) || projectId < 1) {
      throw validationError('Invalid project ID');
    }

    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) {
      throw notFoundError(`Project ${projectId} not found`);
    }

    return _getCleanupPreview(projectId, resetTeams);
  }

  /**
   * Execute cleanup for confirmed items. Broadcasts SSE event.
   *
   * @param projectId - The project ID
   * @param itemPaths - Array of item paths to remove
   * @param resetTeams - If true, allow removal of team DB records
   * @returns Cleanup result with removed and failed items
   * @throws ServiceError with code VALIDATION for invalid input
   * @throws ServiceError with code NOT_FOUND if project doesn't exist
   */
  executeCleanup(projectId: number, itemPaths: string[], resetTeams: boolean): CleanupResult {
    if (isNaN(projectId) || projectId < 1) {
      throw validationError('Invalid project ID');
    }

    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) {
      throw notFoundError(`Project ${projectId} not found`);
    }

    if (!Array.isArray(itemPaths) || itemPaths.length === 0) {
      throw validationError('No items provided. Send { items: [...paths] }.');
    }

    const result = _executeCleanup(projectId, itemPaths, resetTeams);

    // Broadcast SSE event so dashboards refresh
    sseBroker.broadcast('project_cleanup', {
      project_id: projectId,
      removed_count: result.removed.length,
      failed_count: result.failed.length,
    });

    return result;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: ProjectService | null = null;

/**
 * Get the singleton ProjectService instance.
 *
 * @returns ProjectService singleton
 */
export function getProjectService(): ProjectService {
  if (!_instance) {
    _instance = new ProjectService();
  }
  return _instance;
}
