// =============================================================================
// MCP Tool: fleet_list_projects
// =============================================================================
// Returns all registered projects with team counts and install status.
//
// Input:  (none)
// Output: JSON array of project summaries
//
// Service method: ProjectService.listProjects()
// =============================================================================

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProjectService } from '../../services/project-service.js';
import { ServiceError } from '../../services/service-error.js';

/**
 * Registers the `fleet_list_projects` tool on the given MCP server.
 *
 * This is a zero-argument tool that returns all registered projects
 * with their team counts and hook install status.
 */
export function registerListProjectsTool(server: McpServer): void {
  server.tool(
    'fleet_list_projects',
    'Returns all registered projects with team counts and install status',
    async () => {
      try {
        const service = getProjectService();
        const projects = service.listProjects();

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(projects, null, 2),
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
