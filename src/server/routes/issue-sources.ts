// =============================================================================
// Fleet Commander -- Issue Sources Routes (REST endpoints for project issue sources)
// =============================================================================
// Registered as a Fastify plugin. Provides CRUD endpoints for managing
// per-project issue sources (multi-provider support).
//
//   GET    /api/projects/:projectId/issue-sources              — list all sources
//   POST   /api/projects/:projectId/issue-sources              — create a source
//   PATCH  /api/projects/:projectId/issue-sources/:sourceId    — update a source
//   DELETE /api/projects/:projectId/issue-sources/:sourceId    — delete a source
// =============================================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getDatabase } from '../db.js';
import { ServiceError, validationError, notFoundError } from '../services/service-error.js';
import { parseIdParam } from '../utils/parse-params.js';

// ---------------------------------------------------------------------------
// Fastify plugin
// ---------------------------------------------------------------------------

async function issueSourcesRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /api/projects/:projectId/issue-sources — List all sources for a project
   */
  server.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/issue-sources',
    async (request: FastifyRequest<{ Params: { projectId: string } }>, reply: FastifyReply) => {
      try {
        const projectId = parseIdParam(request.params.projectId, 'projectId');
        const db = getDatabase();

        const project = db.getProject(projectId);
        if (!project) {
          throw notFoundError(`Project ${projectId} not found`);
        }

        const sources = db.getIssueSources(projectId);
        return { sources };
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to list issue sources');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  /**
   * POST /api/projects/:projectId/issue-sources — Create a new source
   */
  server.post<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/issue-sources',
    async (request: FastifyRequest<{ Params: { projectId: string } }>, reply: FastifyReply) => {
      try {
        const projectId = parseIdParam(request.params.projectId, 'projectId');
        const db = getDatabase();

        const project = db.getProject(projectId);
        if (!project) {
          throw notFoundError(`Project ${projectId} not found`);
        }

        const body = request.body as Record<string, unknown> | null;
        if (!body) {
          throw validationError('Request body is required');
        }

        const provider = body.provider;
        const configJson = body.configJson;

        if (!provider || typeof provider !== 'string') {
          throw validationError('provider is required and must be a string');
        }
        if (!configJson || typeof configJson !== 'string') {
          throw validationError('configJson is required and must be a string');
        }

        // Validate configJson is parseable JSON
        try {
          JSON.parse(configJson);
        } catch {
          throw validationError('configJson must be valid JSON');
        }

        const source = db.insertIssueSource({
          projectId,
          provider,
          label: typeof body.label === 'string' ? body.label : null,
          configJson,
          credentialsJson: typeof body.credentialsJson === 'string' ? body.credentialsJson : null,
        });

        return reply.code(201).send(source);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        // Handle UNIQUE constraint violation (duplicate source)
        if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
          return reply.code(409).send({
            error: 'CONFLICT',
            message: 'A source with this provider and config already exists for this project',
          });
        }
        request.log.error(err, 'Failed to create issue source');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  /**
   * PATCH /api/projects/:projectId/issue-sources/:sourceId — Update a source
   */
  server.patch<{ Params: { projectId: string; sourceId: string } }>(
    '/api/projects/:projectId/issue-sources/:sourceId',
    async (
      request: FastifyRequest<{ Params: { projectId: string; sourceId: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const projectId = parseIdParam(request.params.projectId, 'projectId');
        const sourceId = parseIdParam(request.params.sourceId, 'sourceId');
        const db = getDatabase();

        const project = db.getProject(projectId);
        if (!project) {
          throw notFoundError(`Project ${projectId} not found`);
        }

        const existing = db.getIssueSource(sourceId);
        if (!existing || existing.projectId !== projectId) {
          throw notFoundError(`Issue source ${sourceId} not found for project ${projectId}`);
        }

        const body = request.body as Record<string, unknown> | null;
        if (!body) {
          throw validationError('Request body is required');
        }

        // Validate configJson if provided
        if (body.configJson !== undefined) {
          if (typeof body.configJson !== 'string') {
            throw validationError('configJson must be a string');
          }
          try {
            JSON.parse(body.configJson);
          } catch {
            throw validationError('configJson must be valid JSON');
          }
        }

        const updated = db.updateIssueSource(sourceId, {
          label: body.label !== undefined ? (typeof body.label === 'string' ? body.label : null) : undefined,
          configJson: typeof body.configJson === 'string' ? body.configJson : undefined,
          credentialsJson: body.credentialsJson !== undefined
            ? (typeof body.credentialsJson === 'string' ? body.credentialsJson : null)
            : undefined,
          enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        });

        return updated;
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to update issue source');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  /**
   * DELETE /api/projects/:projectId/issue-sources/:sourceId — Delete a source
   */
  server.delete<{ Params: { projectId: string; sourceId: string } }>(
    '/api/projects/:projectId/issue-sources/:sourceId',
    async (
      request: FastifyRequest<{ Params: { projectId: string; sourceId: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const projectId = parseIdParam(request.params.projectId, 'projectId');
        const sourceId = parseIdParam(request.params.sourceId, 'sourceId');
        const db = getDatabase();

        const project = db.getProject(projectId);
        if (!project) {
          throw notFoundError(`Project ${projectId} not found`);
        }

        const existing = db.getIssueSource(sourceId);
        if (!existing || existing.projectId !== projectId) {
          throw notFoundError(`Issue source ${sourceId} not found for project ${projectId}`);
        }

        db.deleteIssueSource(sourceId);
        return reply.code(204).send();
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to delete issue source');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );
}

export default issueSourcesRoutes;
