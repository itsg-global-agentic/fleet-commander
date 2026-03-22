// =============================================================================
// MCP Tool: fleet_send_message
// =============================================================================
// Sends a message to a running team's Claude Code session via stdin.
//
// Input:  { teamId: number, message: string }
// Output: JSON { command, delivered }
//
// Service method: TeamService.sendMessage(teamId, message)
// =============================================================================

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getTeamService } from '../../services/team-service.js';
import { ServiceError } from '../../services/service-error.js';

/**
 * Registers the `fleet_send_message` tool on the given MCP server.
 *
 * This tool sends a text message to a running team's Claude Code session
 * via the stdin pipe.
 */
export function registerSendMessageTool(server: McpServer): void {
  server.tool(
    'fleet_send_message',
    'Sends a message to a running team\'s Claude Code session via stdin',
    {
      teamId: z.number().describe('Numeric ID of the team to message'),
      message: z.string().describe('The message text to send to the team'),
    },
    async ({ teamId, message }) => {
      try {
        const service = getTeamService();
        const result = service.sendMessage(teamId, message);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        if (err instanceof ServiceError) {
          return {
            content: [{ type: 'text' as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  );
}
