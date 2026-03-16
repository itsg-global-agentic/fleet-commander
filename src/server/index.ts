import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import eventsRoutes from './routes/events.js';
import streamRoutes from './routes/stream.js';
import issueRoutes from './routes/issues.js';
import teamsRoutes from './routes/teams.js';
import { sseBroker } from './services/sse-broker.js';
import { getIssueFetcher } from './services/issue-fetcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env['PORT'] ?? '4680', 10);

async function main() {
  const server = Fastify({ logger: true });

  await server.register(cors, { origin: true });

  // Health check
  server.get('/api/health', async (_request, _reply) => {
    return { status: 'ok' };
  });

  // API routes
  await server.register(eventsRoutes);

  // SSE streaming endpoint
  await server.register(streamRoutes);

  // Issue hierarchy routes
  await server.register(issueRoutes);

  // Team management routes
  await server.register(teamsRoutes);

  // Static file serving for production builds
  const clientDistPath = path.resolve(__dirname, '..', 'client');
  if (fs.existsSync(clientDistPath)) {
    await server.register(fastifyStatic, {
      root: clientDistPath,
      prefix: '/',
      decorateReply: false,
    });

    // SPA fallback - serve index.html for non-API routes
    server.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        reply.status(404).send({ error: 'Not found', code: 'NOT_FOUND' });
      } else {
        reply.sendFile('index.html');
      }
    });
  }

  // Start services
  sseBroker.start();
  server.log.info('SSE broker heartbeat started');

  const issueFetcher = getIssueFetcher();
  issueFetcher.start();
  server.log.info('Issue fetcher polling started');

  // Graceful shutdown
  server.addHook('onClose', async () => {
    sseBroker.stop();
    issueFetcher.stop();
    server.log.info('Services stopped');
  });

  await server.listen({ port: PORT, host: '0.0.0.0' });
  server.log.info(`Fleet Commander server listening on port ${PORT}`);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
