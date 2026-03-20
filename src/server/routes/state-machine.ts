// =============================================================================
// Fleet Commander — State Machine Routes
// =============================================================================
// Returns the team lifecycle state machine definition with transitions.
// Message templates are served separately via GET/PUT /api/message-templates
// and are decoupled from transitions. Template defaults come from the shared
// DEFAULT_MESSAGE_TEMPLATES array; the DB stores user-edited overrides.
// =============================================================================

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import {
  STATES,
  STATE_MACHINE_TRANSITIONS,
} from '../../shared/state-machine.js';
import { getMessageTemplateService } from '../services/message-template-service.js';
import { ServiceError } from '../services/service-error.js';

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const stateMachineRoutes: FastifyPluginCallback = (
  fastify: FastifyInstance,
  _opts: Record<string, unknown>,
  done: (err?: Error) => void,
) => {
  // -------------------------------------------------------------------------
  // GET /api/state-machine — state machine definition (transitions only)
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/state-machine',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const transitions = STATE_MACHINE_TRANSITIONS.map((t) => ({
          id: t.id,
          from: t.from,
          to: t.to,
          trigger: t.trigger,
          triggerLabel: t.triggerLabel,
          description: t.description,
          condition: t.condition,
          hookEvent: t.hookEvent ?? null,
        }));

        return reply.code(200).send({ states: STATES, transitions });
      } catch (err: unknown) {
        _request.log.error(err, 'Failed to get state machine');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/message-templates — all PM message templates, enriched with defaults
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/message-templates',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const service = getMessageTemplateService();
        const enriched = service.listTemplates();
        return reply.code(200).send(enriched);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        _request.log.error(err, 'Failed to get message templates');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // PUT /api/message-templates/:id — upsert a message template in the DB
  // -------------------------------------------------------------------------
  fastify.put(
    '/api/message-templates/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const body = request.body as { template?: string; enabled?: boolean } | null;

        const service = getMessageTemplateService();
        const updated = service.upsertTemplate(id, body ?? {});
        return reply.code(200).send(updated);
      } catch (err: unknown) {
        if (err instanceof ServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        request.log.error(err, 'Failed to update message template');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  done();
};

export default stateMachineRoutes;
