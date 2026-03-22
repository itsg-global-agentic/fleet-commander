// =============================================================================
// MCP Tool: fleet_system_health
// =============================================================================
// Returns a fleet health summary with counts by status and phase.
//
// Input:  (none)
// Output: JSON HealthSummary { totalTeams, activeTeams, stuckOrIdle, byStatus, byPhase }
//
// Service method: DiagnosticsService.getHealthSummary()
// =============================================================================

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDiagnosticsService } from '../../services/diagnostics-service.js';

/**
 * Registers the `fleet_system_health` tool on the given MCP server.
 *
 * This is a zero-argument tool that returns the current fleet health summary
 * including team counts by status and phase.
 */
export function registerSystemHealthTool(server: McpServer): void {
  server.tool(
    'fleet_system_health',
    'Returns a fleet health summary with team counts by status and phase',
    async () => {
      const diagnostics = getDiagnosticsService();
      const summary = diagnostics.getHealthSummary();

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    },
  );
}
