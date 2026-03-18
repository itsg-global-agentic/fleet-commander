// =============================================================================
// Fleet Commander — Project Routes (CRUD + teams)
// =============================================================================
// Fastify plugin that registers all project-related API endpoints:
// list, create, detail, update, delete, project teams.
// =============================================================================

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getDatabase } from '../db.js';
import { getTeamManager } from '../services/team-manager.js';
import { getIssueFetcher } from '../services/issue-fetcher.js';
import { getCleanupPreview, executeCleanup } from '../services/cleanup.js';
import { sseBroker } from '../services/sse-broker.js';
import { installHooks, uninstallHooks } from '../utils/hook-installer.js';
import config from '../config.js';
import type { ProjectStatus, InstallStatus, InstallFileStatus, CleanupPreview, CleanupResult } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Request body / param / query interfaces
// ---------------------------------------------------------------------------

interface CreateProjectBody {
  name: string;
  repoPath: string;
  githubRepo?: string;
  maxActiveTeams?: number;
  model?: string;
}

interface UpdateProjectBody {
  name?: string;
  status?: ProjectStatus;
  githubRepo?: string | null;
  groupId?: number | null;
  hooksInstalled?: boolean;
  maxActiveTeams?: number;
  promptFile?: string | null;
  model?: string | null;
}

interface ProjectIdParams {
  id: string;
}

interface ProjectListQuery {
  status?: ProjectStatus;
}

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
 */
function checkInstallStatus(repoPath: string): InstallStatus {
  // Hook scripts expected in .claude/hooks/fleet-commander/
  const hookNames = [
    'send_event.sh',
    'on_session_start.sh',
    'on_session_end.sh',
    'on_stop.sh',
    'on_subagent_start.sh',
    'on_subagent_stop.sh',
    'on_notification.sh',
    'on_post_tool_use.sh',
    'on_tool_error.sh',
    'on_pre_compact.sh',
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

  // Prompt files expected in .claude/prompts/
  const promptFiles: InstallFileStatus[] = [
    {
      name: 'fleet-workflow.md',
      exists: fs.existsSync(path.join(repoPath, '.claude', 'prompts', 'fleet-workflow.md')),
    },
  ];

  // Agent templates expected in .claude/agents/
  const agentNames = [
    'fleet-coordinator.md',
    'fleet-analyst.md',
    'fleet-reviewer.md',
    'fleet-dev-generic.md',
    'fleet-dev-csharp.md',
    'fleet-dev-fsharp.md',
    'fleet-dev-python.md',
    'fleet-dev-typescript.md',
    'fleet-dev-devops.md',
  ];
  const agentsDir = path.join(repoPath, '.claude', 'agents');
  const agentFiles: InstallFileStatus[] = agentNames.map((name) => ({
    name,
    exists: fs.existsSync(path.join(agentsDir, name)),
  }));

  // Additional config files
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
    settings: settingsFile,
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const projectsRoutes: FastifyPluginCallback = (
  fastify: FastifyInstance,
  _opts: Record<string, unknown>,
  done: (err?: Error) => void,
) => {
  // -------------------------------------------------------------------------
  // GET /api/projects — list all projects with team counts
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/projects',
    async (
      request: FastifyRequest<{ Querystring: ProjectListQuery }>,
      reply: FastifyReply,
    ) => {
      try {
        const db = getDatabase();
        const statusFilter = (request.query as ProjectListQuery).status;

        if (statusFilter) {
          const validStatuses: ProjectStatus[] = ['active', 'paused', 'archived'];
          if (!validStatuses.includes(statusFilter)) {
            return reply.code(400).send({
              error: 'Bad Request',
              message: `Invalid status filter. Must be one of: ${validStatuses.join(', ')}`,
            });
          }
        }

        // Get summaries (includes team counts) and filter if needed
        const summaries = db.getProjectSummaries();
        const filtered = statusFilter
          ? summaries.filter((p) => p.status === statusFilter)
          : summaries;

        // Enrich each project with live install status from the filesystem
        const enriched = filtered.map((p) => ({
          ...p,
          installStatus: checkInstallStatus(p.repoPath),
        }));

        return reply.code(200).send(enriched);
      } catch (err: unknown) {
        request.log.error(err, 'Failed to list projects');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projects — create a new project
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/projects',
    async (
      request: FastifyRequest<{ Body: CreateProjectBody }>,
      reply: FastifyReply,
    ) => {
      try {
        const { name, repoPath, githubRepo, maxActiveTeams, model } = request.body;

        // Validate name
        if (!name || typeof name !== 'string' || name.trim().length === 0) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'name is required and must be a non-empty string',
          });
        }

        // Validate repoPath
        if (!repoPath || typeof repoPath !== 'string' || repoPath.trim().length === 0) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'repoPath is required and must be a non-empty string',
          });
        }

        // Normalize the path
        const normalizedPath = normalizePath(repoPath);

        // Check that the path exists
        if (!fs.existsSync(normalizedPath)) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: `Path does not exist: ${normalizedPath}`,
          });
        }

        // Check that it's a git repository
        if (!isGitRepo(normalizedPath)) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: `Path is not a git repository: ${normalizedPath}`,
          });
        }

        // Check for duplicate repo_path
        const db = getDatabase();
        const existing = db.getProjectByRepoPath(normalizedPath);
        if (existing) {
          return reply.code(409).send({
            error: 'Conflict',
            message: `A project already exists for this path: ${normalizedPath} (project: ${existing.name})`,
          });
        }

        // Auto-detect githubRepo if not provided
        const resolvedGithubRepo = githubRepo || detectGithubRepo(normalizedPath);

        // Validate maxActiveTeams if provided
        if (maxActiveTeams !== undefined) {
          if (typeof maxActiveTeams !== 'number' || maxActiveTeams < 1 || maxActiveTeams > 50) {
            return reply.code(400).send({
              error: 'Bad Request',
              message: 'maxActiveTeams must be a number between 1 and 50',
            });
          }
        }

        // Create project-specific prompt file from default template
        const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const promptRelPath = `prompts/${slug}-prompt.md`;
        const promptAbsPath = path.join(config.fleetCommanderRoot, promptRelPath);
        const defaultPromptPath = path.join(config.fleetCommanderRoot, 'prompts', 'default-prompt.md');

        try {
          // Ensure prompts directory exists
          fs.mkdirSync(path.join(config.fleetCommanderRoot, 'prompts'), { recursive: true });

          // Copy default prompt if the project-specific one doesn't exist
          if (!fs.existsSync(promptAbsPath)) {
            if (fs.existsSync(defaultPromptPath)) {
              fs.copyFileSync(defaultPromptPath, promptAbsPath);
            } else {
              // Create a basic default prompt inline
              fs.writeFileSync(promptAbsPath,
                'Read the ENTIRE file `.claude/prompts/fleet-workflow.md` before taking any actions.\n' +
                'You are the TL. Spawn the CORE team (Coordinator + Analyst + Reviewer) as described in the workflow. Do NOT spawn developers yet.\n' +
                'Issue: #{{ISSUE_NUMBER}}\n',
                'utf-8',
              );
            }
          }
        } catch (promptErr: unknown) {
          request.log.warn(promptErr, 'Failed to create project prompt file (non-fatal)');
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
        const installResult = installHooks(normalizedPath, request.log);
        if (!installResult.ok) {
          request.log.warn(
            `Hook installation failed for ${normalizedPath}: ${installResult.stderr}`,
          );
        }

        // Verify artifacts were actually installed
        const status = checkInstallStatus(normalizedPath);
        const allInstalled = status.hooks.installed && status.prompt.installed;
        if (allInstalled) {
          db.updateProject(project.id, { hooksInstalled: true });
        }

        // Re-fetch to get updated hooks_installed
        const finalProject = db.getProject(project.id)!;

        // Ensure the issue fetcher's polling loop is running.
        // After a factory reset the fetcher is stopped; re-start it now that
        // there is at least one project to poll issues for.
        const issueFetcher = getIssueFetcher();
        issueFetcher.start(); // no-op if already running

        // Broadcast SSE event
        sseBroker.broadcast('project_added', {
          project_id: finalProject.id,
          name: finalProject.name,
          repo_path: finalProject.repoPath,
        });

        return reply.code(201).send(finalProject);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        if (message.includes('UNIQUE constraint failed')) {
          return reply.code(409).send({
            error: 'Conflict',
            message: 'A project with this repo path already exists',
          });
        }

        request.log.error(err, 'Failed to create project');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projects/:id — project detail with team count
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/projects/:id',
    async (
      request: FastifyRequest<{ Params: ProjectIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const projectId = parseInt(request.params.id, 10);
        if (isNaN(projectId) || projectId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid project ID',
          });
        }

        const db = getDatabase();
        const project = db.getProject(projectId);
        if (!project) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Project ${projectId} not found`,
          });
        }

        // Get team counts for this project
        const teams = db.getTeams({ projectId });
        const activeStatuses = ['launching', 'running', 'idle', 'stuck'];
        const activeCount = teams.filter((t) => activeStatuses.includes(t.status)).length;
        const queuedCount = teams.filter((t) => t.status === 'queued').length;

        const summary = {
          ...project,
          teamCount: teams.length,
          activeTeamCount: activeCount,
          queuedTeamCount: queuedCount,
        };

        return reply.code(200).send(summary);
      } catch (err: unknown) {
        request.log.error(err, 'Failed to get project');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // PUT /api/projects/:id — update project name/status
  // -------------------------------------------------------------------------
  fastify.put(
    '/api/projects/:id',
    async (
      request: FastifyRequest<{ Params: ProjectIdParams; Body: UpdateProjectBody }>,
      reply: FastifyReply,
    ) => {
      try {
        const projectId = parseInt(request.params.id, 10);
        if (isNaN(projectId) || projectId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid project ID',
          });
        }

        const db = getDatabase();
        const project = db.getProject(projectId);
        if (!project) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Project ${projectId} not found`,
          });
        }

        const { name, status, githubRepo, groupId, hooksInstalled, maxActiveTeams, promptFile, model } = request.body || {};

        // Validate status if provided
        if (status !== undefined) {
          const validStatuses: ProjectStatus[] = ['active', 'paused', 'archived'];
          if (!validStatuses.includes(status)) {
            return reply.code(400).send({
              error: 'Bad Request',
              message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
            });
          }
        }

        // Validate name if provided
        if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'name must be a non-empty string',
          });
        }

        // Validate maxActiveTeams if provided
        if (maxActiveTeams !== undefined) {
          if (typeof maxActiveTeams !== 'number' || maxActiveTeams < 1 || maxActiveTeams > 50) {
            return reply.code(400).send({
              error: 'Bad Request',
              message: 'maxActiveTeams must be a number between 1 and 50',
            });
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

        return reply.code(200).send(updated);
      } catch (err: unknown) {
        request.log.error(err, 'Failed to update project');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/projects/:id — remove project
  // -------------------------------------------------------------------------
  fastify.delete(
    '/api/projects/:id',
    async (
      request: FastifyRequest<{ Params: ProjectIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const projectId = parseInt(request.params.id, 10);
        if (isNaN(projectId) || projectId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid project ID',
          });
        }

        const db = getDatabase();
        const project = db.getProject(projectId);
        if (!project) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Project ${projectId} not found`,
          });
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
        uninstallHooks(project.repoPath, request.log);

        // Clear cached issues for this project
        const issueFetcher = getIssueFetcher();
        issueFetcher.clearProject(projectId);

        // Delete all teams and related records (events, commands, usage_snapshots,
        // transitions, PRs) in a single transaction
        db.deleteTeamsByProject(projectId);

        // Delete the project from DB
        db.deleteProject(projectId);

        // Broadcast SSE event
        sseBroker.broadcast('project_removed', {
          project_id: projectId,
        });

        return reply.code(200).send({ success: true });
      } catch (err: unknown) {
        request.log.error(err, 'Failed to delete project');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projects/:id/install — (re)install hooks, settings, prompt
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/projects/:id/install',
    async (
      request: FastifyRequest<{ Params: ProjectIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const projectId = parseInt(request.params.id, 10);
        if (isNaN(projectId) || projectId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid project ID',
          });
        }

        const db = getDatabase();
        const project = db.getProject(projectId);
        if (!project) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Project ${projectId} not found`,
          });
        }

        const result = installHooks(project.repoPath, request.log);

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

        return reply.code(200).send({
          ok: result.ok,
          output: result.stdout.trim(),
          error: result.stderr.trim() || undefined,
          installStatus: status,
        });
      } catch (err: unknown) {
        request.log.error(err, 'Failed to install hooks');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projects/:id/teams — teams for this project
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/projects/:id/teams',
    async (
      request: FastifyRequest<{ Params: ProjectIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const projectId = parseInt(request.params.id, 10);
        if (isNaN(projectId) || projectId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid project ID',
          });
        }

        const db = getDatabase();
        const project = db.getProject(projectId);
        if (!project) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Project ${projectId} not found`,
          });
        }

        const teams = db.getProjectTeams(projectId);
        return reply.code(200).send(teams);
      } catch (err: unknown) {
        request.log.error(err, 'Failed to get project teams');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projects/:id/cleanup-preview — dry-run: what would be cleaned
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/projects/:id/cleanup-preview',
    async (
      request: FastifyRequest<{ Params: ProjectIdParams; Querystring: { resetTeams?: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const projectId = parseInt(request.params.id, 10);
        if (isNaN(projectId) || projectId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid project ID',
          });
        }

        const db = getDatabase();
        const project = db.getProject(projectId);
        if (!project) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Project ${projectId} not found`,
          });
        }

        const resetTeams = (request.query as { resetTeams?: string }).resetTeams === 'true';
        const preview: CleanupPreview = getCleanupPreview(projectId, resetTeams);
        return reply.code(200).send(preview);
      } catch (err: unknown) {
        request.log.error(err, 'Failed to generate cleanup preview');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projects/:id/cleanup — execute cleanup for confirmed items
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/projects/:id/cleanup',
    async (
      request: FastifyRequest<{ Params: ProjectIdParams; Body: { items: string[]; resetTeams?: boolean } }>,
      reply: FastifyReply,
    ) => {
      try {
        const projectId = parseInt(request.params.id, 10);
        if (isNaN(projectId) || projectId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid project ID',
          });
        }

        const db = getDatabase();
        const project = db.getProject(projectId);
        if (!project) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Project ${projectId} not found`,
          });
        }

        const body = request.body || {};
        const itemPaths = Array.isArray(body.items) ? body.items : [];
        const resetTeams = body.resetTeams === true;

        if (itemPaths.length === 0) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'No items provided. Send { items: [...paths] }.',
          });
        }

        const result: CleanupResult = executeCleanup(projectId, itemPaths, resetTeams);

        // Broadcast SSE event so dashboards refresh
        sseBroker.broadcast('project_cleanup', {
          project_id: projectId,
          removed_count: result.removed.length,
          failed_count: result.failed.length,
        });

        return reply.code(200).send(result);
      } catch (err: unknown) {
        request.log.error(err, 'Failed to execute cleanup');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projects/:id/prompt — return contents of the project's prompt file
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/projects/:id/prompt',
    async (
      request: FastifyRequest<{ Params: ProjectIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const projectId = parseInt(request.params.id, 10);
        if (isNaN(projectId) || projectId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid project ID',
          });
        }

        const db = getDatabase();
        const project = db.getProject(projectId);
        if (!project) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Project ${projectId} not found`,
          });
        }

        if (!project.promptFile) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `No prompt file configured for project ${projectId}`,
          });
        }

        const absPath = path.join(config.fleetCommanderRoot, project.promptFile);
        if (!fs.existsSync(absPath)) {
          // Try falling back to default
          const defaultPath = path.join(config.fleetCommanderRoot, 'prompts', 'default-prompt.md');
          if (fs.existsSync(defaultPath)) {
            const content = fs.readFileSync(defaultPath, 'utf-8');
            return reply.code(200).send({ promptFile: project.promptFile, content, isDefault: true });
          }
          return reply.code(404).send({
            error: 'Not Found',
            message: `Prompt file not found: ${project.promptFile}`,
          });
        }

        const content = fs.readFileSync(absPath, 'utf-8');
        return reply.code(200).send({ promptFile: project.promptFile, content, isDefault: false });
      } catch (err: unknown) {
        request.log.error(err, 'Failed to read project prompt');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // PUT /api/projects/:id/prompt — update the contents of the prompt file
  // -------------------------------------------------------------------------
  fastify.put(
    '/api/projects/:id/prompt',
    async (
      request: FastifyRequest<{ Params: ProjectIdParams; Body: { content: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const projectId = parseInt(request.params.id, 10);
        if (isNaN(projectId) || projectId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid project ID',
          });
        }

        const db = getDatabase();
        const project = db.getProject(projectId);
        if (!project) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Project ${projectId} not found`,
          });
        }

        const { content } = request.body || {};
        if (content === undefined || typeof content !== 'string') {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'content is required and must be a string',
          });
        }

        if (!project.promptFile) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: `No prompt file configured for project ${projectId}`,
          });
        }

        const absPath = path.join(config.fleetCommanderRoot, project.promptFile);

        // Ensure directory exists
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, content, 'utf-8');

        return reply.code(200).send({ promptFile: project.promptFile, content });
      } catch (err: unknown) {
        request.log.error(err, 'Failed to update project prompt');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  done();
};

export default projectsRoutes;
