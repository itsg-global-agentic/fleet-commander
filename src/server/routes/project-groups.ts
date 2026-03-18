// =============================================================================
// Fleet Commander — Project Group Routes (CRUD)
// =============================================================================

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import { getDatabase } from '../db.js';
import type { ProjectGroup } from '../../shared/types.js';

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
        const db = getDatabase();
        const groups = db.getProjectGroups();

        // Enrich with project counts
        const allProjects = db.getProjects();
        const enriched = groups.map((g: ProjectGroup) => {
          const linked = allProjects.filter((p) => p.groupId === g.id);
          return {
            ...g,
            projectCount: linked.length,
          };
        });

        return reply.code(200).send(enriched);
      } catch (err: unknown) {
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
        const { name, description } = request.body || {};

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'name is required and must be a non-empty string',
          });
        }

        const db = getDatabase();
        const group = db.insertProjectGroup({
          name: name.trim(),
          description: description?.trim() || null,
        });

        return reply.code(201).send(group);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        if (message.includes('UNIQUE constraint failed')) {
          return reply.code(409).send({
            error: 'Conflict',
            message: 'A project group with this name already exists',
          });
        }

        request.log.error(err, 'Failed to create project group');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message,
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

        const db = getDatabase();
        const group = db.getProjectGroup(groupId);
        if (!group) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Project group ${groupId} not found`,
          });
        }

        const allProjects = db.getProjects();
        const projects = allProjects.filter((p) => p.groupId === groupId);

        return reply.code(200).send({
          ...group,
          projects,
        });
      } catch (err: unknown) {
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
        if (isNaN(groupId) || groupId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid group ID',
          });
        }

        const db = getDatabase();
        const group = db.getProjectGroup(groupId);
        if (!group) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Project group ${groupId} not found`,
          });
        }

        const { name, description } = request.body || {};

        if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'name must be a non-empty string',
          });
        }

        const updated = db.updateProjectGroup(groupId, {
          name: name?.trim(),
          description: description !== undefined ? (description?.trim() || null) : undefined,
        });

        return reply.code(200).send(updated);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        if (message.includes('UNIQUE constraint failed')) {
          return reply.code(409).send({
            error: 'Conflict',
            message: 'A project group with this name already exists',
          });
        }

        request.log.error(err, 'Failed to update project group');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message,
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
        if (isNaN(groupId) || groupId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid group ID',
          });
        }

        const db = getDatabase();
        const group = db.getProjectGroup(groupId);
        if (!group) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Project group ${groupId} not found`,
          });
        }

        db.deleteProjectGroup(groupId);

        return reply.code(200).send({ success: true });
      } catch (err: unknown) {
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
