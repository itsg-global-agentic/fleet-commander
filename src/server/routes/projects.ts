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
import config from '../config.js';
import type { ProjectStatus, InstallStatus, CleanupPreview, CleanupResult } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Request body / param / query interfaces
// ---------------------------------------------------------------------------

interface CreateProjectBody {
  name: string;
  repoPath: string;
  githubRepo?: string;
  maxActiveTeams?: number;
}

interface UpdateProjectBody {
  name?: string;
  status?: ProjectStatus;
  githubRepo?: string | null;
  hooksInstalled?: boolean;
  maxActiveTeams?: number;
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
 * Install Fleet Commander hooks into a project repo.
 * Returns true on success, false on failure (non-fatal).
 */
function installHooks(repoPath: string): boolean {
  try {
    const scriptPath = path.join(config.fleetCommanderRoot, 'scripts', 'install.sh');
    if (!fs.existsSync(scriptPath)) {
      return false;
    }

    // On Windows, run via bash
    const cmd = process.platform === 'win32'
      ? `bash "${scriptPath}" "${repoPath}"`
      : `"${scriptPath}" "${repoPath}"`;

    execSync(cmd, { encoding: 'utf-8', stdio: 'pipe', timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Uninstall Fleet Commander hooks from a project repo.
 */
function uninstallHooks(repoPath: string): void {
  try {
    const scriptPath = path.join(config.fleetCommanderRoot, 'scripts', 'uninstall.sh');
    if (!fs.existsSync(scriptPath)) {
      return;
    }

    const cmd = process.platform === 'win32'
      ? `bash "${scriptPath}" "${repoPath}"`
      : `"${scriptPath}" "${repoPath}"`;

    execSync(cmd, { encoding: 'utf-8', stdio: 'pipe', timeout: 30000 });
  } catch {
    // Non-fatal — log but continue
  }
}

/**
 * Check the install status of all three artifacts deployed by install.sh:
 * hooks directory, workflow prompt, and next-issue command.
 */
function checkInstallStatus(repoPath: string): InstallStatus {
  return {
    hooks: fs.existsSync(path.join(repoPath, '.claude', 'hooks', 'fleet-commander')),
    prompt: fs.existsSync(path.join(repoPath, '.claude', 'prompts', 'fleet-workflow.md')),
    command: fs.existsSync(path.join(repoPath, '.claude', 'commands', 'next-issue.md')),
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
        const { name, repoPath, githubRepo, maxActiveTeams } = request.body;

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

        // Insert the project
        const project = db.insertProject({
          name: name.trim(),
          repoPath: normalizedPath,
          githubRepo: resolvedGithubRepo,
          maxActiveTeams: maxActiveTeams ?? 5,
        });

        // Install hooks (non-fatal)
        installHooks(normalizedPath);

        // Verify all three artifacts were actually installed
        const status = checkInstallStatus(normalizedPath);
        const allInstalled = status.hooks && status.prompt && status.command;
        if (allInstalled) {
          db.updateProject(project.id, { hooksInstalled: true });
        }

        // Re-fetch to get updated hooks_installed
        const finalProject = db.getProject(project.id)!;

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

        const { name, status, githubRepo, hooksInstalled, maxActiveTeams } = request.body || {};

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
          hooksInstalled,
          maxActiveTeams,
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
        uninstallHooks(project.repoPath);

        // Clear cached issues for this project
        const issueFetcher = getIssueFetcher();
        issueFetcher.clearProject(projectId);

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

        const preview: CleanupPreview = getCleanupPreview(projectId);
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
      request: FastifyRequest<{ Params: ProjectIdParams; Body: { items: string[] } }>,
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

        if (itemPaths.length === 0) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'No items provided. Send { items: [...paths] }.',
          });
        }

        const result: CleanupResult = executeCleanup(projectId, itemPaths);

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

  done();
};

export default projectsRoutes;
