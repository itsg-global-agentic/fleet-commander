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
import systemRoutes from './routes/system.js';
import costsRoutes from './routes/costs.js';
import usageRoutes from './routes/usage.js';
import prsRoutes from './routes/prs.js';
import projectsRoutes from './routes/projects.js';
import { sseBroker } from './services/sse-broker.js';
import { getIssueFetcher } from './services/issue-fetcher.js';
import { stuckDetector } from './services/stuck-detector.js';
import { githubPoller } from './services/github-poller.js';
import { errorHandler } from './middleware/error-handler.js';
import { closeDatabase } from './db.js';
import { recoverOnStartup } from './services/startup-recovery.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env['PORT'] ?? '4680', 10);

async function main() {
  const server = Fastify({
    logger: { level: process.env['LOG_LEVEL'] || 'info' },
  });

  // Centralized error handler
  server.setErrorHandler(errorHandler);

  await server.register(cors, { origin: true });

  // Health check
  server.get('/api/health', async (_request, _reply) => {
    return { status: 'ok' };
  });

  // API routes
  await server.register(eventsRoutes);
  await server.register(streamRoutes);
  await server.register(issueRoutes);
  await server.register(teamsRoutes);
  await server.register(systemRoutes);
  await server.register(costsRoutes);
  await server.register(usageRoutes);
  await server.register(prsRoutes);
  await server.register(projectsRoutes);

  // Static file serving for production builds
  const clientDistPath = path.resolve(__dirname, '..', 'client');
  if (fs.existsSync(clientDistPath)) {
    await server.register(fastifyStatic, {
      root: clientDistPath,
      prefix: '/',
      decorateReply: true,
    });

    server.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        reply.status(404).send({ error: 'Not found', code: 'NOT_FOUND' });
      } else {
        reply.sendFile('index.html');
      }
    });
  }

  // Recover state from before restart (reconcile PIDs, detect orphan worktrees)
  await recoverOnStartup();

  // Start all services
  sseBroker.start();
  const issueFetcher = getIssueFetcher();
  issueFetcher.start();
  stuckDetector.start();
  githubPoller.start();
  server.log.info('All services started (SSE, issues, stuck detector, GitHub poller)');

  // Graceful shutdown
  server.addHook('onClose', async () => {
    githubPoller.stop();
    stuckDetector.stop();
    issueFetcher.stop();
    sseBroker.stop();
    closeDatabase();
    server.log.info('All services stopped, database closed');
  });

  await server.listen({ port: PORT, host: '0.0.0.0' });
  server.log.info(`Fleet Commander server listening on port ${PORT}`);

  // Signal handlers for graceful shutdown
  const shutdown = async (signal: string) => {
    server.log.info(`Received ${signal}, shutting down...`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
