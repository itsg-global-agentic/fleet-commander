// =============================================================================
// Fleet Commander -- Issue Sources Routes (REST endpoints for project issue sources)
// =============================================================================
// Registered as a Fastify plugin. Provides CRUD endpoints for managing
// per-project issue sources (multi-provider support).
//
//   GET    /api/projects/:projectId/issue-sources                          — list all sources
//   POST   /api/projects/:projectId/issue-sources                          — create a source
//   PATCH  /api/projects/:projectId/issue-sources/:sourceId                — update a source
//   GET    /api/projects/:projectId/issue-sources/:sourceId/credentials    — get decrypted credentials
//   DELETE /api/projects/:projectId/issue-sources/:sourceId                — delete a source
// =============================================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getDatabase } from '../db.js';
import { ServiceError, validationError, notFoundError } from '../services/service-error.js';
import { parseIdParam } from '../utils/parse-params.js';
import type { ProjectIssueSource, ProjectIssueSourceResponse } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip credentialsJson from a source and replace with hasCredentials boolean */
function toIssueSourceResponse(source: ProjectIssueSource): ProjectIssueSourceResponse {
  return {
    id: source.id,
    projectId: source.projectId,
    provider: source.provider,
    label: source.label,
    configJson: source.configJson,
    hasCredentials: source.credentialsJson !== null && source.credentialsJson !== '',
    enabled: source.enabled,
    createdAt: source.createdAt,
  };
}

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
        return { sources: sources.map(toIssueSourceResponse) };
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

        return reply.code(201).send(toIssueSourceResponse(source));
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

        return toIssueSourceResponse(updated!);
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
   * GET /api/projects/:projectId/issue-sources/:sourceId/credentials
   *
   * Returns the decrypted credentialsJson for a single issue source.
   * Used by the edit dialog to populate credential fields.
   */
  server.get<{ Params: { projectId: string; sourceId: string } }>(
    '/api/projects/:projectId/issue-sources/:sourceId/credentials',
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

        const source = db.getIssueSource(sourceId);
        if (!source || source.projectId !== projectId) {
          throw notFoundError(`Issue source ${sourceId} not found for project ${projectId}`);
        }

        return { credentialsJson: source.credentialsJson };
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to get issue source credentials');
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

  /**
   * POST /api/projects/:projectId/issue-sources/test-connection — Test Jira connection
   *
   * Accepts Jira credential fields and validates them against the Jira REST API.
   * Always returns 200 with { ok, projectName?, error? }.
   */
  server.post<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/issue-sources/test-connection',
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

        const jiraUrl = body.jiraUrl;
        const projectKey = body.projectKey;
        const email = body.email;
        const apiToken = body.apiToken;

        if (!jiraUrl || typeof jiraUrl !== 'string') {
          throw validationError('jiraUrl is required and must be a string');
        }
        if (!projectKey || typeof projectKey !== 'string') {
          throw validationError('projectKey is required and must be a string');
        }
        if (!email || typeof email !== 'string') {
          throw validationError('email is required and must be a string');
        }
        if (!apiToken || typeof apiToken !== 'string') {
          throw validationError('apiToken is required and must be a string');
        }

        // Validate Jira URL format
        if (!jiraUrl.startsWith('https://')) {
          return reply.code(200).send({
            ok: false,
            error: 'Jira URL must start with https://',
          });
        }

        // Strip trailing slash
        const baseUrl = jiraUrl.replace(/\/+$/, '');
        const apiUrl = `${baseUrl}/rest/api/3/project/${encodeURIComponent(projectKey)}`;
        const authHeader = 'Basic ' + Buffer.from(`${email}:${apiToken}`).toString('base64');

        try {
          const response = await fetch(apiUrl, {
            method: 'GET',
            headers: {
              'Authorization': authHeader,
              'Accept': 'application/json',
            },
            signal: AbortSignal.timeout(10000),
          });

          if (response.ok) {
            const data = await response.json() as Record<string, unknown>;
            return reply.code(200).send({
              ok: true,
              projectName: typeof data.name === 'string' ? data.name : projectKey,
            });
          }

          if (response.status === 401) {
            return reply.code(200).send({
              ok: false,
              error: 'Authentication failed: invalid email or API token',
            });
          }

          if (response.status === 404) {
            return reply.code(200).send({
              ok: false,
              error: `Project "${projectKey}" not found on this Jira instance`,
            });
          }

          return reply.code(200).send({
            ok: false,
            error: `Jira API returned ${response.status}: ${response.statusText}`,
          });
        } catch (fetchErr: unknown) {
          if (fetchErr instanceof Error && fetchErr.name === 'TimeoutError') {
            return reply.code(200).send({
              ok: false,
              error: 'Connection timed out after 10 seconds',
            });
          }
          return reply.code(200).send({
            ok: false,
            error: `Connection failed: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
          });
        }
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to test Jira connection');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );
}

export default issueSourcesRoutes;
