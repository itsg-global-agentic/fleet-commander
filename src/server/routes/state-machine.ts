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
import { getDatabase } from '../db.js';
import {
  STATES,
  STATE_MACHINE_TRANSITIONS,
} from '../../shared/state-machine.js';
import { DEFAULT_MESSAGE_TEMPLATES } from '../../shared/message-templates.js';

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
        const db = getDatabase();
        const dbTemplates = db.getMessageTemplates();
        const dbMap = new Map(dbTemplates.map((t) => [t.id, t]));

        // Merge defaults with DB overrides so every template is always returned
        const enriched = DEFAULT_MESSAGE_TEMPLATES.map((def) => {
          const dbRow = dbMap.get(def.id);
          return {
            id: def.id,
            template: dbRow?.template ?? def.template,
            enabled: dbRow?.enabled ?? true,
            description: def.description,
            placeholders: def.placeholders,
            isDefault: !dbRow,
          };
        });

        return reply.code(200).send(enriched);
      } catch (err: unknown) {
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

        if (!body || (body.template === undefined && body.enabled === undefined)) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Body must include at least one of: template, enabled',
          });
        }

        const db = getDatabase();
        const existing = db.getMessageTemplate(id);

        if (existing) {
          db.updateMessageTemplate(id, {
            template: body.template,
            enabled: body.enabled,
          });
        } else {
          const defaultTmpl = DEFAULT_MESSAGE_TEMPLATES.find((t) => t.id === id);
          if (!defaultTmpl) {
            return reply.code(404).send({
              error: 'Not Found',
              message: `No message template found for id '${id}'`,
            });
          }

          db.insertMessageTemplate({
            id,
            template: body.template ?? defaultTmpl.template,
            enabled: body.enabled ?? true,
          });
        }

        const updated = db.getMessageTemplate(id);
        return reply.code(200).send(updated);
      } catch (err: unknown) {
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
