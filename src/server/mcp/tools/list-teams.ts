// =============================================================================
// MCP Tool: fleet_list_teams
// =============================================================================
// Returns all teams with dashboard data, with optional filtering by project
// and/or status.
//
// Input:  { projectId?: number, status?: string }
// Output: JSON array of team dashboard records
//
// Service method: TeamService.listTeams()
// =============================================================================

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getTeamService } from '../../services/team-service.js';
import type { TeamDashboardRow } from '../../../shared/types.js';

/**
 * Registers the `fleet_list_teams` tool on the given MCP server.
 *
 * This tool returns all teams with dashboard data. Optionally filters
 * by projectId and/or status.
 */
export function registerListTeamsTool(server: McpServer): void {
  server.tool(
    'fleet_list_teams',
    'Returns all teams with dashboard data, optionally filtered by project and/or status',
    {
      projectId: z.number().optional().describe('Filter teams by project ID'),
      status: z.string().optional().describe('Filter teams by status (e.g. running, idle, stuck, done, failed)'),
    },
    async ({ projectId, status }) => {
      const service = getTeamService();
      const result = service.listTeams();
      // listTeams() without pagination args returns a bare array
      const allTeams: TeamDashboardRow[] = Array.isArray(result) ? result : result.data;
      let teams: TeamDashboardRow[] = allTeams;

      if (projectId !== undefined) {
        teams = teams.filter((t) => t.projectId === projectId);
      }

      if (status !== undefined) {
        teams = teams.filter((t) => t.status === status);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(teams, null, 2),
          },
        ],
      };
    },
  );
}
