// =============================================================================
// Fleet Commander — Project Routes (CRUD + teams)
// =============================================================================
// Fastify plugin that registers all project-related API endpoints:
// list, create, detail, update, delete, project teams.
// Business logic is delegated to ProjectService.
// =============================================================================

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import { getProjectService } from '../services/project-service.js';
import { ServiceError } from '../services/service-error.js';
import type { ProjectStatus } from '../../shared/types.js';

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
        const statusFilter = (request.query as ProjectListQuery).status;
        const service = getProjectService();
        const enriched = service.listProjects(statusFilter);
        return reply.code(200).send(enriched);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
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
        const service = getProjectService();
        const project = await service.createProject(request.body);
        return reply.code(201).send(project);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }

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

        const service = getProjectService();
        const detail = service.getProjectDetail(projectId);
        return reply.code(200).send(detail);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to get project');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projects/:id/repo-settings — lazy-load GitHub repo settings
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/projects/:id/repo-settings',
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

        const service = getProjectService();
        const settings = await service.getRepoSettings(projectId);
        return reply.code(200).send(settings ?? null);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to get repo settings');
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

        const service = getProjectService();
        const updated = service.updateProject(projectId, request.body || {});
        return reply.code(200).send(updated);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
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

        const service = getProjectService();
        await service.deleteProject(projectId);
        return reply.code(200).send({ success: true });
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
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

        const service = getProjectService();
        const result = service.installHooksForProject(projectId);
        return reply.code(200).send(result);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to install hooks');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projects/:id/commit-claude-files — commit .claude/ to repo
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/projects/:id/commit-claude-files',
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

        const service = getProjectService();
        const result = service.commitClaudeFiles(projectId);
        return reply.code(200).send(result);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to commit .claude/ files');
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

        const service = getProjectService();
        const teams = service.getProjectTeams(projectId);
        return reply.code(200).send(teams);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
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

        const resetTeams = (request.query as { resetTeams?: string }).resetTeams === 'true';
        const service = getProjectService();
        const preview = service.getCleanupPreview(projectId, resetTeams);
        return reply.code(200).send(preview);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
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

        const body = request.body || {};
        const itemPaths = Array.isArray(body.items) ? body.items : [];
        const resetTeams = body.resetTeams === true;

        const service = getProjectService();
        const result = service.executeCleanup(projectId, itemPaths, resetTeams);
        return reply.code(200).send(result);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
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

        const service = getProjectService();
        const result = service.getPrompt(projectId);
        return reply.code(200).send(result);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
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

        const { content } = request.body || {};
        if (content === undefined || typeof content !== 'string') {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'content is required and must be a string',
          });
        }

        const service = getProjectService();
        const result = service.savePrompt(projectId, content);
        return reply.code(200).send(result);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
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
