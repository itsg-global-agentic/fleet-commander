import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { sseBroker } from '../services/sse-broker.js';
import { getDatabase } from '../db.js';

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

    // Tell Fastify we are taking control of the response before writing headers.
    // hijack() MUST be called before writeHead() so Fastify doesn't try to
    // send its own response or close the socket.
    await reply.hijack();

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

    // Send initial team dashboard snapshot so the client has data immediately.
    // If the write fails (client already disconnected), remove from broker and
    // destroy the socket to prevent a dangling connection.
    try {
      const db = getDatabase();
      const dashboard = db.getTeamDashboard();
      const snapshotData = { type: 'snapshot', teams: dashboard };
      const frame = `event: snapshot\ndata: ${JSON.stringify(snapshotData)}\n\n`;
      reply.raw.write(frame);
    } catch (err) {
      request.log.warn(err, 'Failed to send initial SSE snapshot');
      sseBroker.removeClient(clientId);
      try {
        reply.raw.destroy();
      } catch {
        // Socket may already be destroyed — ignore
      }
    }
  });

  done();
};

export default streamRoutes;
