// =============================================================================
// MCP Tool: fleet_launch_team
// =============================================================================
// Launches a new agent team for a GitHub issue.
//
// Input:  { projectId: number, issueNumber: number, headless?: boolean, force?: boolean }
// Output: JSON result from TeamService.launchTeam
//
// Service method: TeamService.launchTeam(params)
// =============================================================================

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getTeamService } from '../../services/team-service.js';
import { ServiceError } from '../../services/service-error.js';

/**
 * Registers the `fleet_launch_team` tool on the given MCP server.
 *
 * This tool launches a new agent team for an issue within a project.
 * Accepts either issueNumber (GitHub) or issueKey (any provider).
 * When issueKey is provided, it takes precedence over issueNumber.
 */
export function registerLaunchTeamTool(server: McpServer): void {
  server.tool(
    'fleet_launch_team',
    'Launches a new agent team for an issue within a project. Supports GitHub issue numbers and generic issue keys (e.g. Jira PROJ-123).',
    {
      projectId: z.number().describe('Numeric ID of the project to launch the team in'),
      issueNumber: z.number().optional().describe('Issue number (required for GitHub, optional when issueKey is provided)'),
      issueKey: z.string().optional().describe('Universal issue key (e.g. "42" for GitHub, "PROJ-123" for Jira). Takes precedence over issueNumber.'),
      headless: z.boolean().optional().describe('Run without a visible terminal window'),
      force: z.boolean().optional().describe('Bypass dependency checks and force launch'),
    },
    async ({ projectId, issueNumber, issueKey, headless, force }) => {
      try {
        // Derive issueNumber from issueKey if not provided.
        // For Jira keys like "PROJ-123", parseInt yields NaN -- use 0 instead.
        // For purely numeric keys like "42", derive the number normally.
        const numericKey = issueKey ? Number(issueKey) : NaN;
        const effectiveIssueNumber = issueNumber ?? (Number.isInteger(numericKey) && numericKey > 0 ? numericKey : 0);
        if (!effectiveIssueNumber && !issueKey) {
          return {
            content: [{ type: 'text' as const, text: 'Either issueNumber or issueKey must be provided' }],
            isError: true,
          };
        }

        const service = getTeamService();
        const result = await service.launchTeam({ projectId, issueNumber: effectiveIssueNumber, issueKey, headless, force });

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
