// =============================================================================
// Fleet Commander -- Issue Routes (REST endpoints for issue hierarchy)
// =============================================================================
// Registered as a Fastify plugin. Provides endpoints for:
//   GET  /api/issues                        — full hierarchy tree (cached, all projects)
//   GET  /api/issues/next                   — suggest next issue to work on
//   GET  /api/issues/available              — issues with no active team
//   GET  /api/issues/:number                — single issue detail
//   POST /api/issues/refresh                — force re-fetch from GitHub
//   GET  /api/projects/:projectId/issues    — per-project issue tree
// Business logic is delegated to IssueService.
// =============================================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getIssueService } from '../services/issue-service.js';
import { ServiceError } from '../services/service-error.js';

// ---------------------------------------------------------------------------
// Fastify plugin
// ---------------------------------------------------------------------------

async function issueRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /api/issues — Full hierarchy tree (cached, all projects)
   * Returns the complete issue tree enriched with active team info.
   * Also returns `groups` — issues grouped by project — so the client
   * can render collapsible project sections when "All Projects" is selected.
   */
  server.get('/api/issues', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const service = getIssueService();
      const result = await service.getAllIssues();
      return result;
    } catch (err: unknown) {
      if (err instanceof ServiceError) {
        return reply.code(err.statusCode).send({ error: err.code, message: err.message });
      }
      _request.log.error(err, 'Failed to get issues');
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * GET /api/projects/:projectId/issues — Per-project issue tree
   * Returns the issue hierarchy for a specific project.
   */
  server.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/issues',
    async (request: FastifyRequest<{ Params: { projectId: string } }>, reply: FastifyReply) => {
      try {
        const projectId = parseInt(request.params.projectId, 10);
        const service = getIssueService();
        const result = await service.getProjectIssues(projectId);
        return result;
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to get project issues');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  /**
   * GET /api/issues/next — Suggest next issue to work on
   * Returns the highest-priority Ready issue with no active team.
   */
  server.get('/api/issues/next', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const service = getIssueService();
      return service.getNextIssue();
    } catch (err: unknown) {
      if (err instanceof ServiceError) {
        return reply.code(err.statusCode).send({ error: err.code, message: err.message });
      }
      _request.log.error(err, 'Failed to get next issue');
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * GET /api/issues/available — Issues with no active team
   * Returns all open leaf issues that have no team currently working on them.
   */
  server.get('/api/issues/available', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const service = getIssueService();
      return service.getAvailableIssues();
    } catch (err: unknown) {
      if (err instanceof ServiceError) {
        return reply.code(err.statusCode).send({ error: err.code, message: err.message });
      }
      _request.log.error(err, 'Failed to get available issues');
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * GET /api/issues/:number — Single issue detail
   * Returns a single issue from the cache, enriched with team info.
   */
  server.get<{ Params: { number: string } }>(
    '/api/issues/:number',
    async (request: FastifyRequest<{ Params: { number: string } }>, reply: FastifyReply) => {
      try {
        const issueNumber = parseInt(request.params.number, 10);
        const service = getIssueService();
        return service.getIssue(issueNumber);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to get issue');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  /**
   * GET /api/projects/:projectId/issues/dependencies — Dependencies for all issues in a project
   * Returns dependency info for all cached issues in the specified project.
   */
  server.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/issues/dependencies',
    async (request: FastifyRequest<{ Params: { projectId: string } }>, reply: FastifyReply) => {
      try {
        const projectId = parseInt(request.params.projectId, 10);
        const service = getIssueService();
        return await service.getProjectDependencies(projectId);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to get project dependencies');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  /**
   * GET /api/issues/:number/dependencies — Dependencies for a single issue
   * Returns dependency info for the specified issue number.
   * Requires a projectId query parameter.
   */
  server.get<{ Params: { number: string }; Querystring: { projectId?: string } }>(
    '/api/issues/:number/dependencies',
    async (
      request: FastifyRequest<{ Params: { number: string }; Querystring: { projectId?: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const issueNumber = parseInt(request.params.number, 10);
        const projectIdStr = (request.query as { projectId?: string }).projectId;

        if (!projectIdStr) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'projectId query parameter is required',
          });
        }

        const projectId = parseInt(projectIdStr, 10);
        const service = getIssueService();
        return await service.getIssueDependencies(issueNumber, projectId);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to get issue dependencies');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  /**
   * POST /api/issues/refresh — Force re-fetch from GitHub
   * Clears the cache and re-fetches the full hierarchy for all projects.
   */
  server.post('/api/issues/refresh', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const service = getIssueService();
      return await service.refresh();
    } catch (err: unknown) {
      if (err instanceof ServiceError) {
        return reply.code(err.statusCode).send({ error: err.code, message: err.message });
      }
      _request.log.error(err, 'Failed to refresh issues');
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

export default issueRoutes;
