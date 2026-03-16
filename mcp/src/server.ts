#!/usr/bin/env node
/**
 * Fleet Status MCP Server
 *
 * A minimal stdio-based MCP server that exposes a single tool: `fleet_status`.
 * Agent teams call this tool to see how the Claude Fleet Commander dashboard
 * perceives them — preventing hallucination by providing objective, external data.
 *
 * Architecture:
 *
 *   Agent (in worktree) --stdio--> MCP Server --HTTP--> Dashboard API
 *                                     |
 *                                     +--fallback--> gh CLI + git + signal files
 *
 * The server is launched per Claude Code session via .mcp.json or .claude/settings.json.
 * It auto-detects the team ID from the worktree name / git branch.
 *
 * Configuration (env vars):
 *   FLEET_SERVER_URL  - Dashboard HTTP endpoint (default: http://localhost:4680)
 *   FLEET_TEAM_ID     - Override team ID auto-detection
 *   FLEET_TIMEOUT_MS  - HTTP timeout in ms (default: 5000)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DashboardClient } from "./dashboard-client.js";
import { detectTeamId } from "./detect-team.js";
import type { FleetStatusResponse, DashboardError } from "./types.js";

// ─── Configuration ────────────────────────────────────────────────────

const FLEET_SERVER_URL = process.env.FLEET_SERVER_URL || "http://localhost:4680";
const FLEET_TIMEOUT_MS = parseInt(process.env.FLEET_TIMEOUT_MS || "5000", 10);

// ─── MCP Server Setup ─────────────────────────────────────────────────

const server = new McpServer({
  name: "fleet-status",
  version: "1.0.0",
});

const client = new DashboardClient(FLEET_SERVER_URL, FLEET_TIMEOUT_MS);

// ─── Tool: fleet_status ───────────────────────────────────────────────

server.tool(
  "fleet_status",
  `Check this team's status as seen by the Claude Fleet Commander dashboard.

Returns objective data about:
- Team status (queued/launching/running/stuck/idle/done/failed)
- Issue state and PR state (including CI check results)
- Duration, session count, estimated cost
- PM messages directed at this team
- Current workflow state (analyzing/implementing/reviewing/pr/done)

Use this to:
- Verify your team's status before creating a PR
- Check if the PM sent a message or instruction
- See if the dashboard considers you "stuck"
- Get objective CI status instead of guessing

The team ID is auto-detected from the worktree/branch name.
Pass team_id explicitly only if auto-detection fails.`,
  {
    team_id: z
      .string()
      .optional()
      .describe(
        'Team identifier, e.g. "kea-763". Auto-detected from worktree/branch if omitted.'
      ),
  },
  async ({ team_id }): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
    // 1. Resolve team ID
    const resolvedTeamId = detectTeamId(team_id);

    if (!resolvedTeamId) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                error: "Cannot detect team ID",
                code: "TEAM_NOT_FOUND",
                suggestion:
                  'Pass team_id explicitly (e.g. "kea-763"), or set FLEET_TEAM_ID env var, or run from a worktree directory.',
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // 2. Fetch status
    const result = await client.getTeamStatus(resolvedTeamId);

    // 3. Format response
    const isError = "error" in result;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// ─── Start Server ─────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server is now running, communicating via stdin/stdout
}

main().catch((err) => {
  console.error("Fleet MCP Server failed to start:", err);
  process.exit(1);
});
