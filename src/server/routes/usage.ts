// =============================================================================
// Fleet Commander — Usage Routes (usage percentage tracking)
// =============================================================================
// Fastify plugin that registers usage-related API endpoints:
// latest snapshot, history, and manual submission.
// Business logic is delegated to UsageService.
// =============================================================================

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import { getUsageService } from '../services/usage-service.js';
import { ServiceError } from '../services/service-error.js';

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const usageRoutes: FastifyPluginCallback = (
  fastify: FastifyInstance,
  _opts: Record<string, unknown>,
  done: (err?: Error) => void,
) => {
  // -------------------------------------------------------------------------
  // GET /api/usage — latest usage snapshot
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/usage',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const service = getUsageService();
        const result = service.getLatest();
        return reply.code(200).send(result);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        _request.log.error(err, 'Failed to get latest usage');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/usage/history — recent usage snapshots
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/usage/history',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const query = request.query as { limit?: string };
        const limit = query.limit ? parseInt(query.limit, 10) : undefined;

        const service = getUsageService();
        const result = service.getHistory(limit);
        return reply.code(200).send(result);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to get usage history');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/usage — manually submit usage data (for testing)
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/usage',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = request.body as {
          teamId?: number;
          projectId?: number;
          sessionId?: string;
          dailyPercent?: number;
          weeklyPercent?: number;
          sonnetPercent?: number;
          extraPercent?: number;
          rawOutput?: string;
        } | null;

        const service = getUsageService();
        const result = service.submitSnapshot(body);
        return reply.code(201).send(result);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to submit usage data');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  done();
};

export default usageRoutes;
