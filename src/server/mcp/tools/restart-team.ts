// =============================================================================
// MCP Tool: fleet_restart_team
// =============================================================================
// Restarts a stopped or failed team by ID.
//
// Input:  { teamId: number }
// Output: JSON result from TeamService.restartTeam
//
// Service method: TeamService.restartTeam(teamId)
// =============================================================================

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getTeamService } from '../../services/team-service.js';
import { ServiceError } from '../../services/service-error.js';

/**
 * Registers the `fleet_restart_team` tool on the given MCP server.
 *
 * This tool restarts a stopped or failed team identified by its numeric team ID.
 */
export function registerRestartTeamTool(server: McpServer): void {
  server.tool(
    'fleet_restart_team',
    'Restarts a stopped or failed team by its numeric ID',
    {
      teamId: z.number().describe('Numeric ID of the team to restart'),
    },
    async ({ teamId }) => {
      try {
        const service = getTeamService();
        const result = await service.restartTeam(teamId);

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
