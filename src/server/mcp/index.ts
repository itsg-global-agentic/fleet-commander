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
import { getDatabase, closeDatabase } from '../db.js';
import { sseBroker } from '../services/sse-broker.js';
import { getIssueFetcher } from '../services/issue-fetcher.js';
import { stuckDetector } from '../services/stuck-detector.js';
import { githubPoller } from '../services/github-poller.js';
import { usagePoller } from '../services/usage-tracker.js';
import { recoverOnStartup } from '../services/startup-recovery.js';
import { DEFAULT_MESSAGE_TEMPLATES } from '../../shared/message-templates.js';
import config from '../config.js';
import { getPackageVersion } from '../utils/version.js';
import { registerSystemHealthTool } from './tools/system-health.js';
import { registerGetTeamTimelineTool } from './tools/get-team-timeline.js';
import { registerListIssuesTool } from './tools/list-issues.js';
import { registerListProjectsTool } from './tools/list-projects.js';
import { registerAddProjectTool } from './tools/add-project.js';
import { registerGetUsageTool } from './tools/get-usage.js';
import { registerListTeamsTool } from './tools/list-teams.js';
import { registerGetTeamTool } from './tools/get-team.js';
import { registerStopTeamTool } from './tools/stop-team.js';
import { registerRestartTeamTool } from './tools/restart-team.js';
import { registerSendMessageTool } from './tools/send-message.js';
import { registerLaunchTeamTool } from './tools/launch-team.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  registerGetTeamTimelineTool(mcpServer);
  registerListIssuesTool(mcpServer);
  registerListProjectsTool(mcpServer);
  registerAddProjectTool(mcpServer);
  registerGetUsageTool(mcpServer);
  registerListTeamsTool(mcpServer);
  registerGetTeamTool(mcpServer);
  registerStopTeamTool(mcpServer);
  registerRestartTeamTool(mcpServer);
  registerSendMessageTool(mcpServer);
  registerLaunchTeamTool(mcpServer);

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
