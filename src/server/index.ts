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
import usageRoutes from './routes/usage.js';
import prsRoutes from './routes/prs.js';
import projectsRoutes from './routes/projects.js';
import stateMachineRoutes from './routes/state-machine.js';
import queryRoutes from './routes/query.js';
import { sseBroker } from './services/sse-broker.js';
import { getIssueFetcher } from './services/issue-fetcher.js';
import { stuckDetector } from './services/stuck-detector.js';
import { githubPoller } from './services/github-poller.js';
import { errorHandler } from './middleware/error-handler.js';
import { getDatabase, closeDatabase } from './db.js';
import { recoverOnStartup } from './services/startup-recovery.js';
import { usagePoller } from './services/usage-tracker.js';
import config from './config.js';
import { DEFAULT_MESSAGE_TEMPLATES } from '../shared/message-templates.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const server = Fastify({
    logger: { level: config.logLevel },
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
  await server.register(usageRoutes);
  await server.register(prsRoutes);
  await server.register(projectsRoutes);
  await server.register(stateMachineRoutes);
  await server.register(queryRoutes);

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

  // Initialize default message templates from the standalone template list
  const db = getDatabase();
  db.initDefaultTemplates(
    DEFAULT_MESSAGE_TEMPLATES.map((t) => ({ id: t.id, template: t.template }))
  );

  // Recover state from before restart (reconcile PIDs, detect orphan worktrees)
  await recoverOnStartup();

  // Start all services
  sseBroker.start(config.sseHeartbeatMs);
  const issueFetcher = getIssueFetcher();
  issueFetcher.start();
  stuckDetector.start();
  githubPoller.start();
  usagePoller.start();
  server.log.info('All services started (SSE, issues, stuck detector, GitHub poller, usage poller)');

  // Graceful shutdown
  server.addHook('onClose', async () => {
    usagePoller.stop();
    githubPoller.stop();
    stuckDetector.stop();
    issueFetcher.stop();
    sseBroker.stop();
    closeDatabase();
    server.log.info('All services stopped, database closed');
  });

  await server.listen({ port: config.port, host: '0.0.0.0' });
  server.log.info(`Fleet Commander server listening on port ${config.port}`);

  // Signal handlers for graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      // Second signal — force exit immediately
      server.log.info(`Received ${signal} again, forcing exit`);
      process.exit(1);
    }
    shuttingDown = true;
    server.log.info(`Received ${signal}, shutting down...`);

    // Force exit after 5 seconds if graceful shutdown hangs
    const forceTimer = setTimeout(() => {
      console.error('Graceful shutdown timed out after 5s, forcing exit');
      process.exit(1);
    }, 5000);
    forceTimer.unref();

    // Close SSE connections BEFORE server.close() so the HTTP server
    // doesn't hang waiting for long-lived connections to end.
    sseBroker.stop();

    try {
      await server.close();
    } catch {
      // ignore close errors
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
