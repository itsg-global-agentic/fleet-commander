// =============================================================================
// MCP Tool: fleet_add_project
// =============================================================================
// Registers a new project (git repository) in Fleet Commander.
//
// Input:  { repoPath: string, name?: string, githubRepo?: string, maxActiveTeams?: number, model?: string }
// Output: JSON project record
//
// Service method: ProjectService.createProject(data)
// =============================================================================

import path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getProjectService } from '../../services/project-service.js';
import { ServiceError } from '../../services/service-error.js';

/**
 * Registers the `fleet_add_project` tool on the given MCP server.
 *
 * This tool accepts a repository path and optional metadata, creating
 * a new project record with auto-detected GitHub repo and hook installation.
 */
export function registerAddProjectTool(server: McpServer): void {
  server.tool(
    'fleet_add_project',
    'Registers a new git repository as a Fleet Commander project, optionally specifying model and adaptive-reasoning effort level',
    {
      repoPath: z.string().describe('Absolute path to the git repository'),
      name: z.string().optional().describe('Project display name (defaults to directory name)'),
      githubRepo: z.string().optional().describe('GitHub repo in owner/name format (auto-detected if omitted)'),
      maxActiveTeams: z.number().optional().describe('Maximum concurrent active teams (default 5)'),
      model: z.string().optional().describe('Claude model to use for this project'),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional()
        .describe('Adaptive-reasoning effort level (Opus 4.7+). xhigh/max are Opus-4.7-only.'),
    },
    async ({ repoPath, name, githubRepo, maxActiveTeams, model, effort }) => {
      try {
        const service = getProjectService();
        const project = await service.createProject({
          name: name ?? path.basename(repoPath),
          repoPath,
          githubRepo,
          maxActiveTeams,
          model,
          effort,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(project, null, 2),
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
