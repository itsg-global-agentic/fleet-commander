// =============================================================================
// Fleet Commander -- Issue Routes (REST endpoints for issue hierarchy)
// =============================================================================
// Registered as a Fastify plugin. Provides endpoints for:
//   GET  /api/issues           — full hierarchy tree (cached)
//   GET  /api/issues/next      — suggest next issue to work on
//   GET  /api/issues/available — issues with no active team
//   GET  /api/issues/:number   — single issue detail
//   POST /api/issues/refresh   — force re-fetch from GitHub
// =============================================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getIssueFetcher } from '../services/issue-fetcher.js';
import { getDatabase } from '../db.js';

// ---------------------------------------------------------------------------
// Helper: get issue numbers for all active teams from the database
// ---------------------------------------------------------------------------

function getActiveTeamIssueNumbers(): number[] {
  try {
    const db = getDatabase();
    const activeTeams = db.getActiveTeams();
    return activeTeams.map((t) => t.issueNumber);
  } catch (err) {
    console.error('[IssueRoutes] Failed to get active teams:', err instanceof Error ? err.message : err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fastify plugin
// ---------------------------------------------------------------------------

async function issueRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /api/issues — Full hierarchy tree (cached)
   * Returns the complete issue tree enriched with active team info.
   */
  server.get('/api/issues', async (_request: FastifyRequest, _reply: FastifyReply) => {
    const fetcher = getIssueFetcher();
    const issues = fetcher.getIssues();

    // Deep clone to avoid mutating the cache when enriching
    const cloned = structuredClone(issues);
    fetcher.enrichWithTeamInfo(cloned);

    return {
      tree: cloned,
      cachedAt: fetcher.getCachedAt(),
      count: countIssues(cloned),
    };
  });

  /**
   * GET /api/issues/next — Suggest next issue to work on
   * Returns the highest-priority Ready issue with no active team.
   */
  server.get('/api/issues/next', async (_request: FastifyRequest, _reply: FastifyReply) => {
    const fetcher = getIssueFetcher();
    const activeIssues = getActiveTeamIssueNumbers();
    const nextIssue = fetcher.getNextIssue(activeIssues);

    if (!nextIssue) {
      return {
        issue: null,
        reason: 'No available Ready issues found without an active team',
      };
    }

    // Enrich the single issue with team info
    const cloned = structuredClone(nextIssue);
    fetcher.enrichWithTeamInfo([cloned]);

    return {
      issue: cloned,
      reason: 'Highest priority Ready issue with no active team',
    };
  });

  /**
   * GET /api/issues/available — Issues with no active team
   * Returns all open leaf issues that have no team currently working on them.
   */
  server.get('/api/issues/available', async (_request: FastifyRequest, _reply: FastifyReply) => {
    const fetcher = getIssueFetcher();
    const activeIssues = getActiveTeamIssueNumbers();
    const available = fetcher.getAvailableIssues(activeIssues);

    // Enrich with team info (should all be null, but for consistency)
    const cloned = structuredClone(available);
    fetcher.enrichWithTeamInfo(cloned);

    return {
      issues: cloned,
      count: cloned.length,
    };
  });

  /**
   * GET /api/issues/:number — Single issue detail
   * Returns a single issue from the cache, enriched with team info.
   */
  server.get<{ Params: { number: string } }>(
    '/api/issues/:number',
    async (request: FastifyRequest<{ Params: { number: string } }>, reply: FastifyReply) => {
      const issueNumber = parseInt(request.params.number, 10);

      if (isNaN(issueNumber) || issueNumber <= 0) {
        return reply.status(400).send({
          error: 'Invalid issue number',
          message: 'Issue number must be a positive integer',
        });
      }

      const fetcher = getIssueFetcher();
      const issue = fetcher.getIssue(issueNumber);

      if (!issue) {
        return reply.status(404).send({
          error: 'Issue not found',
          message: `Issue #${issueNumber} not found in cache. Try POST /api/issues/refresh first.`,
        });
      }

      // Deep clone and enrich
      const cloned = structuredClone(issue);
      fetcher.enrichWithTeamInfo([cloned]);

      return cloned;
    }
  );

  /**
   * POST /api/issues/refresh — Force re-fetch from GitHub
   * Clears the cache and re-fetches the full hierarchy.
   */
  server.post('/api/issues/refresh', async (_request: FastifyRequest, _reply: FastifyReply) => {
    const fetcher = getIssueFetcher();
    const issues = fetcher.refresh();

    // Enrich the fresh data
    const cloned = structuredClone(issues);
    fetcher.enrichWithTeamInfo(cloned);

    return {
      refreshedAt: fetcher.getCachedAt(),
      issueCount: countIssues(cloned),
      tree: cloned,
    };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count total issues in a tree (recursive).
 */
function countIssues(tree: Array<{ children: Array<unknown> }>): number {
  let count = 0;
  const walk = (nodes: Array<{ children?: Array<unknown> }>): void => {
    for (const node of nodes) {
      count++;
      if (node.children && Array.isArray(node.children)) {
        walk(node.children as Array<{ children?: Array<unknown> }>);
      }
    }
  };
  walk(tree);
  return count;
}

export default issueRoutes;
