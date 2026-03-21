// =============================================================================
// Fleet Commander — Project Group Routes (CRUD)
// =============================================================================
// Business logic is delegated to ProjectGroupService.
// =============================================================================

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import { getProjectGroupService } from '../services/project-group-service.js';
import { ServiceError } from '../services/service-error.js';

// ---------------------------------------------------------------------------
// Request body / param interfaces
// ---------------------------------------------------------------------------

interface CreateGroupBody {
  name: string;
  description?: string | null;
}

interface UpdateGroupBody {
  name?: string;
  description?: string | null;
}

interface GroupIdParams {
  id: string;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const projectGroupsRoutes: FastifyPluginCallback = (
  fastify: FastifyInstance,
  _opts: Record<string, unknown>,
  done: (err?: Error) => void,
) => {
  // -------------------------------------------------------------------------
  // GET /api/project-groups — list all groups with project counts
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/project-groups',
    async (
      _request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      try {
        const service = getProjectGroupService();
        const enriched = service.listWithCounts();
        return reply.code(200).send(enriched);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        _request.log.error(err, 'Failed to list project groups');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/project-groups — create a new group
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/project-groups',
    async (
      request: FastifyRequest<{ Body: CreateGroupBody }>,
      reply: FastifyReply,
    ) => {
      try {
        const service = getProjectGroupService();
        const group = service.createGroup(request.body || {});
        return reply.code(201).send(group);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to create project group');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/project-groups/:id — get group detail with its projects
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/project-groups/:id',
    async (
      request: FastifyRequest<{ Params: GroupIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const groupId = parseInt(request.params.id, 10);
        if (isNaN(groupId) || groupId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid group ID',
          });
        }

        const service = getProjectGroupService();
        const result = service.getWithProjects(groupId);
        return reply.code(200).send(result);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to get project group');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // PUT /api/project-groups/:id — update group
  // -------------------------------------------------------------------------
  fastify.put(
    '/api/project-groups/:id',
    async (
      request: FastifyRequest<{ Params: GroupIdParams; Body: UpdateGroupBody }>,
      reply: FastifyReply,
    ) => {
      try {
        const groupId = parseInt(request.params.id, 10);

        const service = getProjectGroupService();
        const updated = service.updateGroup(groupId, request.body || {});
        return reply.code(200).send(updated);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to update project group');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/project-groups/:id — delete group (unlinks projects)
  // -------------------------------------------------------------------------
  fastify.delete(
    '/api/project-groups/:id',
    async (
      request: FastifyRequest<{ Params: GroupIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const groupId = parseInt(request.params.id, 10);

        const service = getProjectGroupService();
        service.deleteGroup(groupId);
        return reply.code(200).send({ success: true });
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to delete project group');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  done();
};

export default projectGroupsRoutes;
