// =============================================================================
// Fleet Commander — MCP Server Entry Point
// =============================================================================
// Standalone MCP server process that exposes Fleet Commander tools over the
// Model Context Protocol via stdio transport. This does NOT start the Fastify
// HTTP server — it only initializes the database, starts required services,
// and connects the MCP server to stdin/stdout.
//
// All logging goes to stderr since stdout is reserved for MCP JSON-RPC.
// =============================================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'fs';
import path from 'path';
import { getDatabase, closeDatabase } from '../db.js';
import { sseBroker } from '../services/sse-broker.js';
import { getIssueFetcher } from '../services/issue-fetcher.js';
import { stuckDetector } from '../services/stuck-detector.js';
import { githubPoller } from '../services/github-poller.js';
import { usagePoller } from '../services/usage-tracker.js';
import { recoverOnStartup } from '../services/startup-recovery.js';
import { DEFAULT_MESSAGE_TEMPLATES } from '../../shared/message-templates.js';
import config from '../config.js';
import { registerSystemHealthTool } from './tools/system-health.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read version from package.json */
function getPackageVersion(): string {
  try {
    const pkgPath = path.join(config.fleetCommanderRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Log to stderr (stdout is reserved for MCP JSON-RPC protocol) */
function log(message: string): void {
  process.stderr.write(`[fleet-commander-mcp] ${message}\n`);
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

export async function startMcpServer(): Promise<void> {
  const version = getPackageVersion();

  // Create the MCP server
  const mcpServer = new McpServer({
    name: 'fleet-commander',
    version,
  });

  // Register all tools
  registerSystemHealthTool(mcpServer);

  // Initialize database
  const db = getDatabase();
  db.initDefaultTemplates(
    DEFAULT_MESSAGE_TEMPLATES.map((t) => ({ id: t.id, template: t.template })),
  );
  log('Database initialized');

  // Recover state from before restart
  await recoverOnStartup();
  log('Startup recovery complete');

  // Start background services
  sseBroker.start(config.sseHeartbeatMs);
  const issueFetcher = getIssueFetcher();
  issueFetcher.start();
  stuckDetector.start();
  githubPoller.start();
  usagePoller.start();
  log('All services started');

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  log(`Fleet Commander MCP server v${version} running on stdio`);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log(`Received ${signal}, shutting down...`);
    usagePoller.stop();
    githubPoller.stop();
    stuckDetector.stop();
    issueFetcher.stop();
    sseBroker.stop();
    await mcpServer.close();
    closeDatabase();
    log('All services stopped, database closed');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
