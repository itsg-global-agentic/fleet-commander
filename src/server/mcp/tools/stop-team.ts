// =============================================================================
// MCP Tool: fleet_stop_team
// =============================================================================
// Stops a running team by ID.
//
// Input:  { teamId: number }
// Output: JSON result from TeamService.stopTeam
//
// Service method: TeamService.stopTeam(teamId)
// =============================================================================

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getTeamService } from '../../services/team-service.js';
import { ServiceError } from '../../services/service-error.js';

/**
 * Registers the `fleet_stop_team` tool on the given MCP server.
 *
 * This tool stops a running team identified by its numeric team ID.
 */
export function registerStopTeamTool(server: McpServer): void {
  server.tool(
    'fleet_stop_team',
    'Stops a running team by its numeric ID',
    {
      teamId: z.number().describe('Numeric ID of the team to stop'),
    },
    async ({ teamId }) => {
      try {
        const service = getTeamService();
        const result = await service.stopTeam(teamId);

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
