#!/usr/bin/env node

// Fleet Commander MCP Server entry point.
//
// Starts the MCP server over stdio transport. This process communicates via
// JSON-RPC over stdin/stdout — all logging goes to stderr.
//
// Usage:
//   node bin/fleet-commander-mcp.js
//
// Or via .mcp.json:
//   { "mcpServers": { "fleet-commander": { "command": "node", "args": ["bin/fleet-commander-mcp.js"] } } }

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Point FLEET_COMMANDER_ROOT at the package root (one level up from bin/)
if (!process.env['FLEET_COMMANDER_ROOT']) {
  process.env['FLEET_COMMANDER_ROOT'] = path.resolve(__dirname, '..');
}

// Import and start the MCP server
const { startMcpServer } = await import('../dist/server/mcp/index.js');
await startMcpServer();
