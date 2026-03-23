import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import eventsRoutes from './routes/events.js';
import streamRoutes from './routes/stream.js';
import issueRoutes from './routes/issues.js';
import teamsRoutes from './routes/teams.js';
import systemRoutes from './routes/system.js';
import usageRoutes from './routes/usage.js';
import prsRoutes from './routes/prs.js';
import projectsRoutes from './routes/projects.js';
import projectGroupsRoutes from './routes/project-groups.js';
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
import { resolveClaudePath } from './utils/resolve-claude-path.js';
import { getTeamManager } from './services/team-manager.js';
import { DEFAULT_MESSAGE_TEMPLATES } from '../shared/message-templates.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const server = Fastify({
    logger: { level: config.logLevel },
    forceCloseConnections: true,
  });

  // Centralized error handler
  server.setErrorHandler(errorHandler);

  await server.register(cors, { origin: true });

  // API routes
  await server.register(eventsRoutes);
  await server.register(streamRoutes);
  await server.register(issueRoutes);
  await server.register(teamsRoutes);
  await server.register(systemRoutes);
  await server.register(usageRoutes);
  await server.register(prsRoutes);
  await server.register(projectsRoutes);
  await server.register(projectGroupsRoutes);
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
  const db = getDatabase(config.dbPath);
  db.initDefaultTemplates(
    DEFAULT_MESSAGE_TEMPLATES.map((t) => ({ id: t.id, template: t.template }))
  );

  // Recover state from before restart (reconcile PIDs, detect orphan worktrees)
  await recoverOnStartup();

  // ---------------------------------------------------------------------------
  // Startup diagnostics: agent teams config + Claude CLI version
  // ---------------------------------------------------------------------------
  try {
    server.log.info(`Agent Teams: ${config.enableAgentTeams ? 'enabled' : 'disabled'} (FLEET_ENABLE_AGENT_TEAMS)`);

    const claudePath = resolveClaudePath();
    const versionOutput = execSync(`"${claudePath}" --version`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
    // Parse version number from output (e.g. "claude 2.1.32" or just "2.1.32")
    const versionMatch = versionOutput.match(/(\d+\.\d+\.\d+)/);
    if (versionMatch) {
      const version = versionMatch[1];
      server.log.info(`Claude CLI version: ${version}`);
      // Check minimum version for agent teams support (2.1.32)
      const [major, minor, patch] = version.split('.').map(Number);
      const meetsMinimum =
        major > 2 ||
        (major === 2 && minor > 1) ||
        (major === 2 && minor === 1 && patch >= 32);
      if (!meetsMinimum && config.enableAgentTeams) {
        server.log.warn(`Claude CLI ${version} may not support agent teams (minimum 2.1.32)`);
      }
    } else {
      server.log.warn(`Could not parse Claude CLI version from: ${versionOutput}`);
    }
  } catch (err: unknown) {
    server.log.warn(`Claude CLI version check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

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

  await server.listen({ port: config.port, host: config.host });
  server.log.info(`Fleet Commander server listening on ${config.host}:${config.port}`);

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

    // Kill all child processes immediately so their stdio streams don't
    // keep the event loop alive. This is the fast-path for server shutdown.
    try {
      getTeamManager().killAll();
    } catch {
      // Ignore errors — best-effort cleanup
    }

    // server.close() triggers the onClose hook which stops SSE broker,
    // pollers, and closes the database. forceCloseConnections: true
    // ensures open SSE sockets are destroyed immediately.
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
