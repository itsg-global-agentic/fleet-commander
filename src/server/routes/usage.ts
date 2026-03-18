// =============================================================================
// Fleet Commander — Usage Routes (usage percentage tracking)
// =============================================================================
// Fastify plugin that registers usage-related API endpoints:
// latest snapshot, history, and manual submission.
// =============================================================================

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import { getDatabase } from '../db.js';
import { processUsageSnapshot, getUsageZone } from '../services/usage-tracker.js';
import config from '../config.js';

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
        const db = getDatabase();
        const latest = db.getLatestUsage();

        if (!latest) {
          return reply.code(200).send({
            dailyPercent: 0,
            weeklyPercent: 0,
            sonnetPercent: 0,
            extraPercent: 0,
            recordedAt: null,
            zone: getUsageZone(),
            redThresholds: { daily: config.usageRedDailyPct, weekly: config.usageRedWeeklyPct, sonnet: config.usageRedSonnetPct, extra: config.usageRedExtraPct },
          });
        }

        return reply.code(200).send({
          ...latest,
          zone: getUsageZone(),
          redThresholds: { daily: config.usageRedDailyPct, weekly: config.usageRedWeeklyPct, sonnet: config.usageRedSonnetPct, extra: config.usageRedExtraPct },
        });
      } catch (err: unknown) {
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
        const db = getDatabase();
        const query = request.query as { limit?: string };
        const limit = Math.min(Math.max(parseInt(query.limit ?? '50', 10) || 50, 1), 500);
        const history = db.getUsageHistory(limit);

        return reply.code(200).send({
          count: history.length,
          snapshots: history,
        });
      } catch (err: unknown) {
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

        if (!body) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Request body is required',
          });
        }

        processUsageSnapshot({
          teamId: body.teamId,
          projectId: body.projectId,
          sessionId: body.sessionId,
          dailyPercent: body.dailyPercent,
          weeklyPercent: body.weeklyPercent,
          sonnetPercent: body.sonnetPercent,
          extraPercent: body.extraPercent,
          rawOutput: body.rawOutput,
        });

        const db = getDatabase();
        const latest = db.getLatestUsage();

        return reply.code(201).send(latest);
      } catch (err: unknown) {
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
