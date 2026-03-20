// =============================================================================
// Fleet Commander — PR Management Routes
// =============================================================================
// Fastify plugin for pull request endpoints: list, detail, refresh poller,
// enable/disable auto-merge, and update branch.
//
// All GitHub operations use the `gh` CLI (never Octokit) per project conventions.
// Mutation actions delegate to PRService which handles CLI calls, DB updates,
// and SSE broadcasts.
// =============================================================================

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import { getDatabase } from '../db.js';
import { githubPoller } from '../services/github-poller.js';
import { getPRService } from '../services/pr-service.js';
import { ServiceError } from '../services/service-error.js';

// ---------------------------------------------------------------------------
// Request param interfaces
// ---------------------------------------------------------------------------

interface PRNumberParams {
  number: string;
}

// ---------------------------------------------------------------------------
// Helper: parse and validate PR number from route params
// ---------------------------------------------------------------------------

function parsePRNumber(raw: string): number | null {
  const n = parseInt(raw, 10);
  return isNaN(n) || n < 1 ? null : n;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const prsRoutes: FastifyPluginCallback = (
  fastify: FastifyInstance,
  _opts: Record<string, unknown>,
  done: (err?: Error) => void,
) => {
  // -------------------------------------------------------------------------
  // GET /api/prs — list all tracked PRs
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/prs',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const db = getDatabase();
        const prs = db.getAllPullRequests();
        return reply.code(200).send(prs);
      } catch (err: unknown) {
        _request.log.error(err, 'Failed to list PRs');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/prs/:number — single PR detail with checks_json parsed
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/prs/:number',
    async (
      request: FastifyRequest<{ Params: PRNumberParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const prNumber = parsePRNumber(request.params.number);
        if (!prNumber) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid PR number',
          });
        }

        const db = getDatabase();
        const pr = db.getPullRequest(prNumber);
        if (!pr) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `PR #${prNumber} not found`,
          });
        }

        // Parse checks_json into a proper array for the client
        let checks: unknown[] = [];
        if (pr.checksJson) {
          try {
            checks = JSON.parse(pr.checksJson);
          } catch {
            checks = [];
          }
        }

        return reply.code(200).send({
          ...pr,
          checks,
        });
      } catch (err: unknown) {
        request.log.error(err, 'Failed to get PR detail');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/prs/refresh — trigger immediate GitHub poller poll
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/prs/refresh',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        githubPoller.poll().catch(err => request.log.error(err, 'Poll failed'));
        return reply.code(200).send({
          ok: true,
          message: 'GitHub poller poll triggered',
        });
      } catch (err: unknown) {
        request.log.error(err, 'Failed to trigger poller refresh');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/prs/:number/enable-auto-merge — enable auto-merge via gh CLI
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/prs/:number/enable-auto-merge',
    async (
      request: FastifyRequest<{ Params: PRNumberParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const prNumber = parsePRNumber(request.params.number);
        if (!prNumber) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid PR number',
          });
        }

        const service = getPRService();
        const result = service.enableAutoMerge(prNumber);
        return reply.code(200).send(result);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({
            error: err.code === 'EXTERNAL_ERROR' ? 'GitHub CLI Error' : err.code,
            message: err.message,
            details: err.details,
          });
        }
        request.log.error(err, 'Failed to enable auto-merge');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/prs/:number/disable-auto-merge — disable auto-merge via gh CLI
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/prs/:number/disable-auto-merge',
    async (
      request: FastifyRequest<{ Params: PRNumberParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const prNumber = parsePRNumber(request.params.number);
        if (!prNumber) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid PR number',
          });
        }

        const service = getPRService();
        const result = service.disableAutoMerge(prNumber);
        return reply.code(200).send(result);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({
            error: err.code === 'EXTERNAL_ERROR' ? 'GitHub CLI Error' : err.code,
            message: err.message,
            details: err.details,
          });
        }
        request.log.error(err, 'Failed to disable auto-merge');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/prs/:number/update-branch — update PR branch via GitHub API
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/prs/:number/update-branch',
    async (
      request: FastifyRequest<{ Params: PRNumberParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const prNumber = parsePRNumber(request.params.number);
        if (!prNumber) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid PR number',
          });
        }

        const service = getPRService();
        const result = service.updateBranch(prNumber);
        return reply.code(200).send(result);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({
            error: err.code === 'EXTERNAL_ERROR' ? 'GitHub CLI Error' : err.code,
            message: err.message,
            details: err.details,
          });
        }
        request.log.error(err, 'Failed to update PR branch');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  done();
};

export default prsRoutes;
