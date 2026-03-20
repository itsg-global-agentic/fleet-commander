// =============================================================================
// Fleet Commander — Project Service
// =============================================================================
// Manages project CRUD operations, hook installation, and prompt file I/O.
// Owns all business logic, DB calls, SSE broadcasts, filesystem operations,
// and CLI calls related to projects.
// =============================================================================

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getDatabase } from '../db.js';
import { getTeamManager } from './team-manager.js';
import { getIssueFetcher } from './issue-fetcher.js';
import { sseBroker } from './sse-broker.js';
import { installHooks, uninstallHooks } from '../utils/hook-installer.js';
import config from '../config.js';
import type { ProjectStatus, InstallStatus, InstallFileStatus } from '../../shared/types.js';
import { ServiceError, validationError, notFoundError, conflictError } from './service-error.js';

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
 * Check if a directory is a git repository.
 */
function isGitRepo(dirPath: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: dirPath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Auto-detect the GitHub repo (owner/name) for a local git repo via gh CLI.
 * Returns null if detection fails (non-fatal).
 */
function detectGithubRepo(dirPath: string): string | null {
  try {
    const result = execSync(
      'gh repo view --json nameWithOwner -q .nameWithOwner',
      { cwd: dirPath, encoding: 'utf-8', stdio: 'pipe', timeout: 10000 },
    ).trim();
    return result || null;
  } catch {
    return null;
  }
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
 * Check the install status of artifacts deployed by install.sh:
 * hooks directory and workflow prompt.
 * Returns detailed file-level breakdown for tooltip display.
 *
 * @param repoPath - Absolute path to the target repository
 * @returns InstallStatus with hooks, prompt, agents, guides, and settings info
 */
export function checkInstallStatus(repoPath: string): InstallStatus {
  const hookNames = [
    'send_event.sh',
    'on_session_start.sh',
    'on_session_end.sh',
    'on_stop.sh',
    'on_stop_failure.sh',
    'on_subagent_start.sh',
    'on_subagent_stop.sh',
    'on_notification.sh',
    'on_post_tool_use.sh',
    'on_tool_error.sh',
    'on_pre_compact.sh',
    'on_teammate_idle.sh',
  ];

  const hooksDir = path.join(repoPath, '.claude', 'hooks', 'fleet-commander');
  const hookFiles: InstallFileStatus[] = hookNames.map((name) => {
    const filePath = path.join(hooksDir, name);
    const exists = fs.existsSync(filePath);
    return {
      name,
      exists,
      hasCrlf: exists ? fileHasCrlf(filePath) : false,
    };
  });
  const hookFoundCount = hookFiles.filter((f) => f.exists).length;
  const hookHasCrlf = hookFiles.some((f) => f.hasCrlf);

  const promptFiles: InstallFileStatus[] = [
    {
      name: 'fleet-workflow.md',
      exists: fs.existsSync(path.join(repoPath, '.claude', 'prompts', 'fleet-workflow.md')),
    },
  ];

  const agentNames = [
    'fleet-planner.md',
    'fleet-dev.md',
    'fleet-reviewer.md',
  ];
  const agentsDir = path.join(repoPath, '.claude', 'agents');
  const agentFiles: InstallFileStatus[] = agentNames.map((name) => ({
    name,
    exists: fs.existsSync(path.join(agentsDir, name)),
  }));

  const guidesDir = path.join(repoPath, '.claude', 'guides');
  const guideFiles: InstallFileStatus[] = fs.existsSync(guidesDir)
    ? fs.readdirSync(guidesDir)
        .filter((f) => f.endsWith('.md'))
        .map((name) => ({ name, exists: true }))
    : [];

  const settingsFile: InstallFileStatus = {
    name: 'settings.json',
    exists: fs.existsSync(path.join(repoPath, '.claude', 'settings.json')),
  };

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
      installed: guideFiles.length > 0,
      files: guideFiles,
    },
    settings: settingsFile,
  };
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

    return filtered.map((p) => ({
      ...p,
      installStatus: checkInstallStatus(p.repoPath),
    }));
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
  createProject(data: {
    name: string;
    repoPath: string;
    githubRepo?: string;
    maxActiveTeams?: number;
    model?: string;
  }): unknown {
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

    if (!isGitRepo(normalizedPath)) {
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
    const resolvedGithubRepo = githubRepo || detectGithubRepo(normalizedPath);

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

    // Uninstall hooks
    uninstallHooks(project.repoPath, _minimalLogger);

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

    // Check what actually landed on disk
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
