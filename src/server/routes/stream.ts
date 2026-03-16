import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { sseBroker } from '../services/sse-broker.js';

/**
 * SSE streaming endpoint.
 *
 * GET /api/stream
 *
 * Query params:
 *   ?teams=1,2,3   Subscribe only to events for the given team IDs.
 *                   Omit to receive all events.
 *
 * Response:
 *   Content-Type: text/event-stream
 *   Cache-Control: no-cache
 *   Connection: keep-alive
 */
const streamRoutes: FastifyPluginCallback = (
  fastify: FastifyInstance,
  _opts: Record<string, unknown>,
  done: (err?: Error) => void,
) => {
  fastify.get('/api/stream', async (request, reply) => {
    // Parse ?teams=1,2,3 into number[]
    const teamsParam = (request.query as Record<string, string | undefined>).teams;
    let teamFilter: number[] | undefined;

    if (teamsParam) {
      teamFilter = teamsParam
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n));
    }

    // Set SSE headers — use raw API so Fastify doesn't close the response
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable buffering in nginx proxies
    });

    // Register the client with the broker
    const clientId = sseBroker.addClient(reply, teamFilter);

    // Send an initial comment so the client knows the connection is live
    reply.raw.write(`:ok\n\n`);

    // Detect client disconnect
    request.raw.on('close', () => {
      sseBroker.removeClient(clientId);
    });

    // Keep the route handler "pending" — Fastify must not send a response.
    // Returning the reply object with hijack semantics is not needed because
    // we already wrote to reply.raw directly. We just need to ensure Fastify
    // does not try to serialize a return value.  Using reply.hijack() tells
    // Fastify we took control of the response.
    await reply.hijack();
  });

  done();
};

export default streamRoutes;
