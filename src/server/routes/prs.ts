// =============================================================================
// Fleet Commander — PR Management Routes
// =============================================================================
// Fastify plugin for pull request endpoints: list, detail, refresh poller,
// enable/disable auto-merge, and update branch.
//
// All GitHub operations use the `gh` CLI (never Octokit) per project conventions.
// gh CLI errors are caught and returned as structured JSON responses.
// Successful mutation actions broadcast SSE events so the dashboard updates
// in real time.
// =============================================================================

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import { execSync } from 'child_process';
import { getDatabase } from '../db.js';
import config from '../config.js';
import { githubPoller } from '../services/github-poller.js';
import { sseBroker } from '../services/sse-broker.js';

// ---------------------------------------------------------------------------
// Request param interfaces
// ---------------------------------------------------------------------------

interface PRNumberParams {
  number: string;
}

// ---------------------------------------------------------------------------
// Helper: parse and validate PR number from route params
// ---------------------------------------------------------------------------

function parsePRNumber(raw: string): number | null {
  const n = parseInt(raw, 10);
  return isNaN(n) || n < 1 ? null : n;
}

// ---------------------------------------------------------------------------
// Helper: execute a gh CLI command, returning { ok, stdout?, error? }
// ---------------------------------------------------------------------------

interface GHResult {
  ok: boolean;
  stdout?: string;
  error?: string;
}

function execGH(command: string): GHResult {
  try {
    const stdout = execSync(command, {
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, stdout };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Try to extract stderr from the ExecSyncError
    let stderr = message;
    if (err && typeof err === 'object' && 'stderr' in err) {
      const rawStderr = (err as { stderr: string | Buffer }).stderr;
      stderr = typeof rawStderr === 'string' ? rawStderr : rawStderr.toString('utf-8');
    }
    return { ok: false, error: stderr.trim() || message };
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const prsRoutes: FastifyPluginCallback = (
  fastify: FastifyInstance,
  _opts: Record<string, unknown>,
  done: (err?: Error) => void,
) => {
  // -------------------------------------------------------------------------
  // GET /api/prs — list all tracked PRs
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/prs',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const db = getDatabase();
        const prs = db.getAllPullRequests();
        return reply.code(200).send(prs);
      } catch (err: unknown) {
        _request.log.error(err, 'Failed to list PRs');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/prs/:number — single PR detail with checks_json parsed
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/prs/:number',
    async (
      request: FastifyRequest<{ Params: PRNumberParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const prNumber = parsePRNumber(request.params.number);
        if (!prNumber) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid PR number',
          });
        }

        const db = getDatabase();
        const pr = db.getPullRequest(prNumber);
        if (!pr) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `PR #${prNumber} not found`,
          });
        }

        // Parse checks_json into a proper array for the client
        let checks: unknown[] = [];
        if (pr.checksJson) {
          try {
            checks = JSON.parse(pr.checksJson);
          } catch {
            // If checks_json is malformed, return it as-is
            checks = [];
          }
        }

        return reply.code(200).send({
          ...pr,
          checks,
        });
      } catch (err: unknown) {
        request.log.error(err, 'Failed to get PR detail');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/prs/refresh — trigger immediate GitHub poller poll
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/prs/refresh',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        githubPoller.poll();
        return reply.code(200).send({
          ok: true,
          message: 'GitHub poller poll triggered',
        });
      } catch (err: unknown) {
        request.log.error(err, 'Failed to trigger poller refresh');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/prs/:number/enable-auto-merge — enable auto-merge via gh CLI
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/prs/:number/enable-auto-merge',
    async (
      request: FastifyRequest<{ Params: PRNumberParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const prNumber = parsePRNumber(request.params.number);
        if (!prNumber) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid PR number',
          });
        }

        const result = execGH(
          `gh pr merge ${prNumber} --auto --squash --repo ${config.githubRepo}`,
        );

        if (!result.ok) {
          request.log.warn(
            { prNumber, error: result.error },
            'gh pr merge --auto failed',
          );
          return reply.code(502).send({
            error: 'GitHub CLI Error',
            message: `Failed to enable auto-merge for PR #${prNumber}`,
            details: result.error,
          });
        }

        // Update the database record
        const db = getDatabase();
        const pr = db.getPullRequest(prNumber);
        if (pr) {
          db.updatePullRequest(prNumber, { autoMerge: true });
        }

        // Broadcast SSE event
        sseBroker.broadcast(
          'pr_updated',
          {
            pr_number: prNumber,
            team_id: pr?.teamId ?? 0,
            action: 'auto_merge_enabled',
            auto_merge: true,
          },
          pr?.teamId ?? undefined,
        );

        return reply.code(200).send({
          ok: true,
          message: `Auto-merge enabled for PR #${prNumber}`,
          output: result.stdout?.trim() ?? '',
        });
      } catch (err: unknown) {
        request.log.error(err, 'Failed to enable auto-merge');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/prs/:number/disable-auto-merge — disable auto-merge via gh CLI
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/prs/:number/disable-auto-merge',
    async (
      request: FastifyRequest<{ Params: PRNumberParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const prNumber = parsePRNumber(request.params.number);
        if (!prNumber) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid PR number',
          });
        }

        const result = execGH(
          `gh pr merge ${prNumber} --disable-auto --repo ${config.githubRepo}`,
        );

        if (!result.ok) {
          request.log.warn(
            { prNumber, error: result.error },
            'gh pr merge --disable-auto failed',
          );
          return reply.code(502).send({
            error: 'GitHub CLI Error',
            message: `Failed to disable auto-merge for PR #${prNumber}`,
            details: result.error,
          });
        }

        // Update the database record
        const db = getDatabase();
        const pr = db.getPullRequest(prNumber);
        if (pr) {
          db.updatePullRequest(prNumber, { autoMerge: false });
        }

        // Broadcast SSE event
        sseBroker.broadcast(
          'pr_updated',
          {
            pr_number: prNumber,
            team_id: pr?.teamId ?? 0,
            action: 'auto_merge_disabled',
            auto_merge: false,
          },
          pr?.teamId ?? undefined,
        );

        return reply.code(200).send({
          ok: true,
          message: `Auto-merge disabled for PR #${prNumber}`,
          output: result.stdout?.trim() ?? '',
        });
      } catch (err: unknown) {
        request.log.error(err, 'Failed to disable auto-merge');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/prs/:number/update-branch — update PR branch via GitHub API
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/prs/:number/update-branch',
    async (
      request: FastifyRequest<{ Params: PRNumberParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const prNumber = parsePRNumber(request.params.number);
        if (!prNumber) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid PR number',
          });
        }

        const result = execGH(
          `gh api repos/${config.githubRepo}/pulls/${prNumber}/update-branch -X PUT`,
        );

        if (!result.ok) {
          request.log.warn(
            { prNumber, error: result.error },
            'gh api update-branch failed',
          );
          return reply.code(502).send({
            error: 'GitHub CLI Error',
            message: `Failed to update branch for PR #${prNumber}`,
            details: result.error,
          });
        }

        // Broadcast SSE event
        const db = getDatabase();
        const pr = db.getPullRequest(prNumber);

        sseBroker.broadcast(
          'pr_updated',
          {
            pr_number: prNumber,
            team_id: pr?.teamId ?? 0,
            action: 'branch_updated',
          },
          pr?.teamId ?? undefined,
        );

        return reply.code(200).send({
          ok: true,
          message: `Branch updated for PR #${prNumber}`,
          output: result.stdout?.trim() ?? '',
        });
      } catch (err: unknown) {
        request.log.error(err, 'Failed to update PR branch');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  done();
};

export default prsRoutes;
