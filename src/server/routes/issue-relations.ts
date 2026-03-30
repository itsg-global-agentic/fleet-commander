// =============================================================================
// Fleet Commander -- Issue Relations Routes (REST endpoints for relation CRUD)
// =============================================================================
// Registered as a Fastify plugin. Provides endpoints for managing issue
// relations: parent/child and blockedBy/blocking.
//
//   GET    /api/projects/:projectId/issues/:issueKey/relations
//   POST   /api/projects/:projectId/issues/:issueKey/blocked-by
//   DELETE /api/projects/:projectId/issues/:issueKey/blocked-by/:blockerKey
//   POST   /api/projects/:projectId/issues/:issueKey/parent
//   DELETE /api/projects/:projectId/issues/:issueKey/parent
//   POST   /api/projects/:projectId/issues/:issueKey/children
//   DELETE /api/projects/:projectId/issues/:issueKey/children/:childKey
// =============================================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ServiceError, validationError } from '../services/service-error.js';
import { parseIdParam } from '../utils/parse-params.js';
import { getIssueRelationsService } from '../services/issue-relations-service.js';

// ---------------------------------------------------------------------------
// Fastify plugin
// ---------------------------------------------------------------------------

async function issueRelationsRoutes(server: FastifyInstance): Promise<void> {

  /**
   * GET /api/projects/:projectId/issues/:issueKey/relations
   * Returns the full set of relations for an issue.
   */
  server.get<{ Params: { projectId: string; issueKey: string } }>(
    '/api/projects/:projectId/issues/:issueKey/relations',
    async (
      request: FastifyRequest<{ Params: { projectId: string; issueKey: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const projectId = parseIdParam(request.params.projectId, 'projectId');
        const issueKey = request.params.issueKey;
        if (!issueKey) throw validationError('issueKey is required');

        const service = getIssueRelationsService();
        const relations = await service.getRelations(projectId, issueKey);
        return relations;
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to get relations');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  /**
   * POST /api/projects/:projectId/issues/:issueKey/blocked-by
   * Body: { blockerKey: string }
   */
  server.post<{ Params: { projectId: string; issueKey: string } }>(
    '/api/projects/:projectId/issues/:issueKey/blocked-by',
    async (
      request: FastifyRequest<{ Params: { projectId: string; issueKey: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const projectId = parseIdParam(request.params.projectId, 'projectId');
        const issueKey = request.params.issueKey;
        if (!issueKey) throw validationError('issueKey is required');

        const body = request.body as Record<string, unknown> | null;
        if (!body) throw validationError('Request body is required');

        const blockerKey = body.blockerKey;
        if (!blockerKey || typeof blockerKey !== 'string') {
          throw validationError('blockerKey is required and must be a string');
        }

        const service = getIssueRelationsService();
        await service.addBlockedBy(projectId, issueKey, blockerKey);
        return reply.code(201).send({ ok: true });
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to add blocked-by relation');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  /**
   * DELETE /api/projects/:projectId/issues/:issueKey/blocked-by/:blockerKey
   */
  server.delete<{ Params: { projectId: string; issueKey: string; blockerKey: string } }>(
    '/api/projects/:projectId/issues/:issueKey/blocked-by/:blockerKey',
    async (
      request: FastifyRequest<{ Params: { projectId: string; issueKey: string; blockerKey: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const projectId = parseIdParam(request.params.projectId, 'projectId');
        const issueKey = request.params.issueKey;
        const blockerKey = request.params.blockerKey;
        if (!issueKey) throw validationError('issueKey is required');
        if (!blockerKey) throw validationError('blockerKey is required');

        const service = getIssueRelationsService();
        await service.removeBlockedBy(projectId, issueKey, blockerKey);
        return reply.code(204).send();
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to remove blocked-by relation');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  /**
   * POST /api/projects/:projectId/issues/:issueKey/parent
   * Body: { parentKey: string }
   */
  server.post<{ Params: { projectId: string; issueKey: string } }>(
    '/api/projects/:projectId/issues/:issueKey/parent',
    async (
      request: FastifyRequest<{ Params: { projectId: string; issueKey: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const projectId = parseIdParam(request.params.projectId, 'projectId');
        const issueKey = request.params.issueKey;
        if (!issueKey) throw validationError('issueKey is required');

        const body = request.body as Record<string, unknown> | null;
        if (!body) throw validationError('Request body is required');

        const parentKey = body.parentKey;
        if (!parentKey || typeof parentKey !== 'string') {
          throw validationError('parentKey is required and must be a string');
        }

        const service = getIssueRelationsService();
        await service.setParent(projectId, issueKey, parentKey);
        return reply.code(201).send({ ok: true });
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to set parent relation');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  /**
   * DELETE /api/projects/:projectId/issues/:issueKey/parent
   */
  server.delete<{ Params: { projectId: string; issueKey: string } }>(
    '/api/projects/:projectId/issues/:issueKey/parent',
    async (
      request: FastifyRequest<{ Params: { projectId: string; issueKey: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const projectId = parseIdParam(request.params.projectId, 'projectId');
        const issueKey = request.params.issueKey;
        if (!issueKey) throw validationError('issueKey is required');

        const service = getIssueRelationsService();
        await service.removeParent(projectId, issueKey);
        return reply.code(204).send();
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to remove parent relation');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  /**
   * POST /api/projects/:projectId/issues/:issueKey/children
   * Body: { childKey: string }
   */
  server.post<{ Params: { projectId: string; issueKey: string } }>(
    '/api/projects/:projectId/issues/:issueKey/children',
    async (
      request: FastifyRequest<{ Params: { projectId: string; issueKey: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const projectId = parseIdParam(request.params.projectId, 'projectId');
        const issueKey = request.params.issueKey;
        if (!issueKey) throw validationError('issueKey is required');

        const body = request.body as Record<string, unknown> | null;
        if (!body) throw validationError('Request body is required');

        const childKey = body.childKey;
        if (!childKey || typeof childKey !== 'string') {
          throw validationError('childKey is required and must be a string');
        }

        const service = getIssueRelationsService();
        await service.addChild(projectId, issueKey, childKey);
        return reply.code(201).send({ ok: true });
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to add child relation');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  /**
   * DELETE /api/projects/:projectId/issues/:issueKey/children/:childKey
   */
  server.delete<{ Params: { projectId: string; issueKey: string; childKey: string } }>(
    '/api/projects/:projectId/issues/:issueKey/children/:childKey',
    async (
      request: FastifyRequest<{ Params: { projectId: string; issueKey: string; childKey: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const projectId = parseIdParam(request.params.projectId, 'projectId');
        const issueKey = request.params.issueKey;
        const childKey = request.params.childKey;
        if (!issueKey) throw validationError('issueKey is required');
        if (!childKey) throw validationError('childKey is required');

        const service = getIssueRelationsService();
        await service.removeChild(projectId, issueKey, childKey);
        return reply.code(204).send();
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to remove child relation');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}

export default issueRelationsRoutes;
