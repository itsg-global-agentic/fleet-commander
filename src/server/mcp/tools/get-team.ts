// =============================================================================
// MCP Tool: fleet_get_team
// =============================================================================
// Returns full detail for a single team including project info, duration,
// PR detail, recent events, and output tail.
//
// Input:  { teamId: number }
// Output: JSON team detail object
//
// Service method: TeamService.getTeamDetail(teamId)
// =============================================================================

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getTeamService } from '../../services/team-service.js';
import { ServiceError } from '../../services/service-error.js';

/**
 * Registers the `fleet_get_team` tool on the given MCP server.
 *
 * This tool accepts a team ID and returns the full team detail including
 * project info, duration, PR detail, recent events, and output tail.
 */
export function registerGetTeamTool(server: McpServer): void {
  server.tool(
    'fleet_get_team',
    'Returns full detail for a single team including project info, PR, events, and output',
    {
      teamId: z.number().describe('The team ID to get details for'),
    },
    async ({ teamId }) => {
      try {
        const service = getTeamService();
        const detail = service.getTeamDetail(teamId);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(detail, null, 2),
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
