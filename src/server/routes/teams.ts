// =============================================================================
// Fleet Commander — Team Routes (CRUD + lifecycle + intervention)
// =============================================================================
// Fastify plugin that registers all team-related API endpoints:
// launch, stop, resume, restart, batch-launch, stop-all, list, detail, output,
// export, send-message, set-phase, acknowledge.
// =============================================================================

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import fs from 'fs';
import path from 'path';
import { getTeamManager } from '../services/team-manager.js';
import { getIssueFetcher } from '../services/issue-fetcher.js';
import { githubPoller } from '../services/github-poller.js';
import { getDatabase } from '../db.js';
import { sseBroker } from '../services/sse-broker.js';
import config from '../config.js';
import type { TeamPhase, IssueDependencyInfo } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Request body / param interfaces
// ---------------------------------------------------------------------------

interface LaunchBody {
  projectId: number;
  issueNumber: number;
  issueTitle?: string;
  prompt?: string;
  headless?: boolean;
  force?: boolean;
}

interface LaunchBatchBody {
  projectId: number;
  issues: Array<{ number: number; title?: string }>;
  prompt?: string;
  delayMs?: number;
  headless?: boolean;
}

interface RestartBody {
  prompt?: string;
}

interface TeamIdParams {
  id: string;
}

interface OutputQuerystring {
  lines?: string;
}

interface ExportQuerystring {
  format?: string;
}

interface SendMessageBody {
  message: string;
}

interface SetPhaseBody {
  phase: TeamPhase;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Produce a short one-line summary of a stream event for text export. */
function summarize(e: Record<string, unknown>): string {
  if (typeof e.message === 'string') return e.message;
  if (typeof e.tool === 'string') return `tool:${e.tool}`;
  if (typeof e.content === 'string') return e.content.slice(0, 120);
  return '';
}

// ---------------------------------------------------------------------------
// Dependency check helper
// ---------------------------------------------------------------------------

/**
 * Check whether an issue has unresolved dependencies.
 * Returns the dependency info, or null if dependencies cannot be determined
 * (which is treated as "no blockers" -- permissive fallback).
 */
async function checkDependencies(projectId: number, issueNumber: number): Promise<IssueDependencyInfo | null> {
  try {
    const fetcher = getIssueFetcher();
    return await fetcher.fetchDependenciesForIssue(projectId, issueNumber);
  } catch (err) {
    console.error(
      `[Teams] Dependency check failed for issue #${issueNumber}:`,
      err instanceof Error ? err.message : err
    );
    // Permissive fallback: if we can't check, allow launch
    return null;
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const teamsRoutes: FastifyPluginCallback = (
  fastify: FastifyInstance,
  _opts: Record<string, unknown>,
  done: (err?: Error) => void,
) => {
  // -------------------------------------------------------------------------
  // POST /api/teams/launch — launch a new team
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/teams/launch',
    async (
      request: FastifyRequest<{ Body: LaunchBody }>,
      reply: FastifyReply,
    ) => {
      try {
        const { projectId, issueNumber, issueTitle, prompt, headless, force } = request.body;

        if (!projectId || typeof projectId !== 'number' || projectId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'projectId is required and must be a positive integer',
          });
        }

        if (!issueNumber || typeof issueNumber !== 'number' || issueNumber < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'issueNumber is required and must be a positive integer',
          });
        }

        // Dependency check -- block launch if unresolved dependencies exist
        if (!force) {
          const depInfo = await checkDependencies(projectId, issueNumber);
          if (depInfo && !depInfo.resolved) {
            // Track for resolution detection in the poller
            const blockerNumbers = depInfo.blockedBy
              .filter((b) => b.state === 'open')
              .map((b) => b.number);
            githubPoller.trackBlockedIssue(projectId, issueNumber, blockerNumbers);

            return reply.code(409).send({
              error: 'Blocked by Dependencies',
              message: `Issue #${issueNumber} is blocked by ${depInfo.openCount} unresolved dependency${depInfo.openCount !== 1 ? 'ies' : ''}`,
              dependencies: depInfo,
              hint: 'Set force: true to bypass dependency check',
            });
          }
        }

        const manager = getTeamManager();
        const team = await manager.launch(projectId, issueNumber, issueTitle, prompt, headless, force);
        return reply.code(201).send(team);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        if (message.includes('already active')) {
          return reply.code(409).send({ error: 'Conflict', message });
        }

        request.log.error(err, 'Failed to launch team');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/teams/launch-batch — launch multiple teams
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/teams/launch-batch',
    async (
      request: FastifyRequest<{ Body: LaunchBatchBody }>,
      reply: FastifyReply,
    ) => {
      try {
        const { projectId, issues, prompt, delayMs, headless } = request.body;

        if (!projectId || typeof projectId !== 'number' || projectId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'projectId is required and must be a positive integer',
          });
        }

        if (!issues || !Array.isArray(issues) || issues.length === 0) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'issues array is required and must not be empty',
          });
        }

        // Validate each issue entry
        for (const issue of issues) {
          if (!issue.number || typeof issue.number !== 'number' || issue.number < 1) {
            return reply.code(400).send({
              error: 'Bad Request',
              message: `Invalid issue number: ${JSON.stringify(issue)}`,
            });
          }
        }

        // Dependency check for batch launch: check each issue, separate blocked from launchable
        const blocked: Array<{ issueNumber: number; dependencies: IssueDependencyInfo }> = [];
        const launchable: Array<{ number: number; title?: string }> = [];

        // Build set of issue numbers in this batch for intra-batch ordering
        const batchNumbers = new Set(issues.map((i) => i.number));

        for (const issue of issues) {
          const depInfo = await checkDependencies(projectId, issue.number);
          if (depInfo && !depInfo.resolved) {
            // Check if all open blockers are in this same batch (intra-batch dependency)
            const allBlockersInBatch = depInfo.blockedBy
              .filter((b) => b.state === 'open')
              .every((b) => batchNumbers.has(b.number));

            if (allBlockersInBatch) {
              // Defer: will be launched after its blockers (handled by ordering)
              launchable.push(issue);
            } else {
              blocked.push({ issueNumber: issue.number, dependencies: depInfo });
            }
          } else {
            launchable.push(issue);
          }
        }

        const manager = getTeamManager();
        const teams = launchable.length > 0
          ? await manager.launchBatch(projectId, launchable, prompt, delayMs, headless)
          : [];

        // Return launched teams plus any blocked issues
        const response = {
          launched: teams,
          blocked: blocked.length > 0 ? blocked : undefined,
        };
        return reply.code(201).send(response);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        request.log.error(err, 'Failed to launch batch');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/teams/stop-all — stop all active teams
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/teams/stop-all',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const manager = getTeamManager();
        const teams = await manager.stopAll();
        return reply.code(200).send(teams);
      } catch (err: unknown) {
        request.log.error(err, 'Failed to stop all teams');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/teams/:id/stop — stop a team
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/teams/:id/stop',
    async (
      request: FastifyRequest<{ Params: TeamIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        if (isNaN(teamId) || teamId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid team ID',
          });
        }

        const manager = getTeamManager();
        const team = await manager.stop(teamId);
        return reply.code(200).send(team);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        if (message.includes('not found')) {
          return reply.code(404).send({ error: 'Not Found', message });
        }

        request.log.error(err, 'Failed to stop team');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/teams/:id/resume — resume a stopped team
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/teams/:id/resume',
    async (
      request: FastifyRequest<{ Params: TeamIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        if (isNaN(teamId) || teamId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid team ID',
          });
        }

        const manager = getTeamManager();
        const team = await manager.resume(teamId);
        return reply.code(200).send(team);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        if (message.includes('not found')) {
          return reply.code(404).send({ error: 'Not Found', message });
        }
        if (message.includes('no longer exists')) {
          return reply.code(410).send({ error: 'Gone', message });
        }

        request.log.error(err, 'Failed to resume team');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/teams/:id/restart — restart a team
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/teams/:id/restart',
    async (
      request: FastifyRequest<{ Params: TeamIdParams; Body: RestartBody }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        if (isNaN(teamId) || teamId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid team ID',
          });
        }

        const { prompt } = request.body || {};
        const manager = getTeamManager();
        const team = await manager.restart(teamId, prompt);
        return reply.code(200).send(team);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        if (message.includes('not found')) {
          return reply.code(404).send({ error: 'Not Found', message });
        }

        request.log.error(err, 'Failed to restart team');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams — list all teams with dashboard data
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const db = getDatabase();
        const dashboard = db.getTeamDashboard();
        return reply.code(200).send(dashboard);
      } catch (err: unknown) {
        _request.log.error(err, 'Failed to list teams');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams/:id — full team detail (assembles TeamDetail shape)
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams/:id',
    async (
      request: FastifyRequest<{ Params: TeamIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        if (isNaN(teamId) || teamId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid team ID',
          });
        }

        const db = getDatabase();
        const team = db.getTeam(teamId);
        if (!team) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Team ${teamId} not found`,
          });
        }

        // Look up project to get model
        let projectModel: string | null = null;
        if (team.projectId) {
          const project = db.getProject(team.projectId);
          if (project) {
            projectModel = project.model ?? null;
          }
        }

        // Compute duration & idle in minutes
        const launchedAt = team.launchedAt ? new Date(team.launchedAt) : null;
        const now = new Date();
        const durationMin = launchedAt
          ? Math.round((now.getTime() - launchedAt.getTime()) / 60_000)
          : 0;

        const lastEventAt = team.lastEventAt ? new Date(team.lastEventAt) : null;
        const idleMin = lastEventAt
          ? Math.round((now.getTime() - lastEventAt.getTime()) / 60_000 * 10) / 10
          : null;

        // Pull request detail (if linked)
        let prDetail = null;
        if (team.prNumber) {
          const pr = db.getPullRequest(team.prNumber);
          if (pr) {
            // Parse CI checks from JSON
            let checks: Array<{ name: string; status: string; conclusion: string | null }> = [];
            if (pr.checksJson) {
              try {
                checks = JSON.parse(pr.checksJson);
              } catch {
                // Malformed JSON — leave empty
              }
            }

            prDetail = {
              number: pr.prNumber,
              state: pr.state,
              mergeStatus: pr.mergeStatus,
              ciStatus: pr.ciStatus,
              ciFailCount: pr.ciFailCount,
              checks,
              autoMerge: pr.autoMerge,
            };
          }
        }

        // Recent events
        const recentEvents = db.getEventsByTeam(teamId, 20);

        // Output tail
        const manager = getTeamManager();
        const outputLines = manager.getOutput(teamId, 50);
        const outputTail = outputLines.length > 0 ? outputLines.join('\n') : null;

        // Assemble full TeamDetail response
        const detail = {
          id: team.id,
          issueNumber: team.issueNumber,
          issueTitle: team.issueTitle,
          model: projectModel,
          status: team.status,
          phase: team.phase,
          pid: team.pid,
          sessionId: team.sessionId,
          worktreeName: team.worktreeName,
          branchName: team.branchName,
          prNumber: team.prNumber,
          launchedAt: team.launchedAt,
          stoppedAt: team.stoppedAt,
          lastEventAt: team.lastEventAt,
          durationMin,
          idleMin,
          totalInputTokens: team.totalInputTokens,
          totalOutputTokens: team.totalOutputTokens,
          totalCacheCreationTokens: team.totalCacheCreationTokens,
          totalCacheReadTokens: team.totalCacheReadTokens,
          totalCostUsd: team.totalCostUsd,
          pr: prDetail,
          recentEvents,
          outputTail,
        };

        return reply.code(200).send(detail);
      } catch (err: unknown) {
        request.log.error(err, 'Failed to get team');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams/:id/status — compact status (MCP-compatible)
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams/:id/status',
    async (
      request: FastifyRequest<{ Params: TeamIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const db = getDatabase();
        const idParam = request.params.id;
        const teamId = parseInt(idParam, 10);

        // Support both integer IDs and worktree names (MCP sends worktree name)
        let team;
        if (!isNaN(teamId) && teamId > 0) {
          team = db.getTeam(teamId);
        }
        if (!team) {
          team = db.getTeamByWorktree(idParam);
        }
        if (!team) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Team ${idParam} not found`,
          });
        }

        // Fetch pending PM commands for this team
        const pendingCommands = db.getPendingCommands(team.id);
        const latestMessage = pendingCommands.length > 0 ? pendingCommands[0].message : null;

        // Compact MCP-compatible format
        return reply.code(200).send({
          id: team.id,
          issueNumber: team.issueNumber,
          worktreeName: team.worktreeName,
          status: team.status,
          phase: team.phase,
          pid: team.pid,
          prNumber: team.prNumber,
          lastEventAt: team.lastEventAt,
          pm_message: latestMessage,
          pending_commands: pendingCommands.map(c => ({
            id: c.id,
            message: c.message,
            createdAt: c.createdAt,
          })),
        });
      } catch (err: unknown) {
        request.log.error(err, 'Failed to get team status');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams/:id/output — rolling output buffer
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams/:id/output',
    async (
      request: FastifyRequest<{ Params: TeamIdParams; Querystring: OutputQuerystring }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        if (isNaN(teamId) || teamId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid team ID',
          });
        }

        const db = getDatabase();
        const team = db.getTeam(teamId);
        if (!team) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Team ${teamId} not found`,
          });
        }

        const linesParam = (request.query as OutputQuerystring).lines;
        const lines = linesParam ? parseInt(linesParam, 10) : undefined;

        const manager = getTeamManager();
        const output = manager.getOutput(teamId, lines);

        return reply.code(200).send({
          teamId,
          lines: output,
          count: output.length,
        });
      } catch (err: unknown) {
        request.log.error(err, 'Failed to get team output');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams/:id/stream-events — parsed NDJSON stream events from Claude Code
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams/:id/stream-events',
    async (
      request: FastifyRequest<{ Params: TeamIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        if (isNaN(teamId) || teamId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid team ID',
          });
        }

        const db = getDatabase();
        const team = db.getTeam(teamId);
        if (!team) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Team ${teamId} not found`,
          });
        }

        const manager = getTeamManager();
        const events = manager.getParsedEvents(teamId);
        return reply.code(200).send(events);
      } catch (err: unknown) {
        request.log.error(err, 'Failed to get team stream events');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams/:id/export — download team logs as file
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams/:id/export',
    async (
      request: FastifyRequest<{ Params: TeamIdParams; Querystring: ExportQuerystring }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        if (isNaN(teamId) || teamId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid team ID',
          });
        }

        const db = getDatabase();
        const team = db.getTeam(teamId);
        if (!team) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Team ${teamId} not found`,
          });
        }

        const format = (request.query as ExportQuerystring).format ?? 'json';
        const events = db.getEventsByTeam(teamId);
        const manager = getTeamManager();
        const streamEvents = manager.getParsedEvents(teamId);
        const outputLines = manager.getOutput(teamId);

        if (format === 'txt') {
          // Plain text format
          let text = `# Team ${team.worktreeName} - Export\n`;
          text += `Issue: #${team.issueNumber} ${team.issueTitle ?? ''}\n`;
          text += `Status: ${team.status}\n`;
          text += `Launched: ${team.launchedAt ?? 'N/A'}\n\n`;
          text += `## Stream Events\n`;
          for (const e of streamEvents) {
            text += `[${e.timestamp ?? ''}] ${e.type} ${summarize(e as unknown as Record<string, unknown>)}\n`;
          }
          text += `\n## Raw Output\n`;
          text += outputLines.join('\n');

          reply.header('Content-Type', 'text/plain');
          reply.header('Content-Disposition', `attachment; filename="${team.worktreeName}-export.txt"`);
          return text;
        }

        // JSON format (default)
        reply.header('Content-Type', 'application/json');
        reply.header('Content-Disposition', `attachment; filename="${team.worktreeName}-export.json"`);
        return { team, events, streamEvents, output: outputLines };
      } catch (err: unknown) {
        request.log.error(err, 'Failed to export team logs');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams/:id/events — events for this team
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams/:id/events',
    async (
      request: FastifyRequest<{ Params: TeamIdParams; Querystring: { limit?: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        if (isNaN(teamId) || teamId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid team ID',
          });
        }

        const db = getDatabase();
        const team = db.getTeam(teamId);
        if (!team) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Team ${teamId} not found`,
          });
        }

        const limitParam = (request.query as { limit?: string }).limit;
        const limit = limitParam ? parseInt(limitParam, 10) : 100;

        const events = db.getEventsByTeam(teamId, limit);
        return reply.code(200).send(events);
      } catch (err: unknown) {
        request.log.error(err, 'Failed to get team events');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/teams/:id/send-message — send a PM message to a team
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/teams/:id/send-message',
    async (
      request: FastifyRequest<{ Params: TeamIdParams; Body: SendMessageBody }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        if (isNaN(teamId) || teamId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid team ID',
          });
        }

        const { message } = request.body || {};
        if (!message || typeof message !== 'string' || message.trim().length === 0) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'message is required and must be a non-empty string',
          });
        }

        const db = getDatabase();
        const team = db.getTeam(teamId);
        if (!team) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Team ${teamId} not found`,
          });
        }

        // Resolve worktree path from the team's project
        let worktreePath: string;
        if (team.projectId) {
          const project = db.getProject(team.projectId);
          worktreePath = project
            ? path.join(project.repoPath, config.worktreeDir, team.worktreeName)
            : path.join(config.worktreeDir, team.worktreeName);
        } else {
          worktreePath = path.join(config.worktreeDir, team.worktreeName);
        }
        const messagePath = path.join(worktreePath, '.fleet-pm-message');

        try {
          fs.writeFileSync(messagePath, message.trim(), 'utf-8');
        } catch (fsErr: unknown) {
          const fsMsg = fsErr instanceof Error ? fsErr.message : String(fsErr);
          request.log.warn({ worktreePath, error: fsMsg }, 'Failed to write .fleet-pm-message file');
          // Continue anyway — the command record is still useful
        }

        // Insert command row in the database
        const command = db.insertCommand({
          teamId,
          message: message.trim(),
        });

        // Try to deliver via stdin pipe (direct delivery to running process)
        const manager = getTeamManager();
        const delivered = manager.sendMessage(teamId, message.trim(), 'user');
        if (delivered) {
          db.markCommandDelivered(command.id);
          request.log.info(`[Teams] Message delivered to team ${teamId} via stdin`);
        }

        return reply.code(201).send({
          ...command,
          // Override status if delivered via stdin
          ...(delivered ? { status: 'delivered' as const, deliveredAt: new Date().toISOString() } : {}),
        });
      } catch (err: unknown) {
        request.log.error(err, 'Failed to send message to team');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/teams/:id/set-phase — manually set team phase
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/teams/:id/set-phase',
    async (
      request: FastifyRequest<{ Params: TeamIdParams; Body: SetPhaseBody }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        if (isNaN(teamId) || teamId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid team ID',
          });
        }

        const { phase, reason } = request.body || {};

        const validPhases: TeamPhase[] = [
          'init', 'analyzing', 'implementing', 'reviewing', 'pr', 'done', 'blocked',
        ];
        if (!phase || !validPhases.includes(phase)) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: `phase is required and must be one of: ${validPhases.join(', ')}`,
          });
        }

        const db = getDatabase();
        const team = db.getTeam(teamId);
        if (!team) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Team ${teamId} not found`,
          });
        }

        // Guard: cannot change phase on a terminal-status team
        if (['done', 'failed'].includes(team.status)) {
          return reply.code(409).send({
            error: 'Conflict',
            message: `Cannot set phase on a ${team.status} team. Use restart to reactivate.`,
          });
        }

        const previousPhase = team.phase;
        const updated = db.updateTeam(teamId, { phase });

        // Broadcast SSE event for phase change
        sseBroker.broadcast(
          'team_status_changed',
          {
            team_id: teamId,
            status: team.status,
            previous_status: team.status,
            phase,
            previous_phase: previousPhase,
            reason: reason ?? undefined,
          },
          teamId,
        );

        return reply.code(200).send(updated);
      } catch (err: unknown) {
        request.log.error(err, 'Failed to set team phase');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams/:id/roster — team member roster derived from events
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams/:id/roster',
    async (
      request: FastifyRequest<{ Params: TeamIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        if (isNaN(teamId) || teamId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid team ID',
          });
        }

        const db = getDatabase();
        const team = db.getTeam(teamId);
        if (!team) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Team ${teamId} not found`,
          });
        }

        const roster = db.getTeamRoster(teamId);
        return reply.code(200).send(roster);
      } catch (err: unknown) {
        request.log.error(err, 'Failed to get team roster');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams/:id/transitions — state transition history
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams/:id/transitions',
    async (
      request: FastifyRequest<{ Params: TeamIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        if (isNaN(teamId) || teamId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid team ID',
          });
        }

        const db = getDatabase();
        const team = db.getTeam(teamId);
        if (!team) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Team ${teamId} not found`,
          });
        }

        const transitions = db.getTransitions(teamId);
        return reply.code(200).send(transitions);
      } catch (err: unknown) {
        request.log.error(err, 'Failed to get team transitions');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/teams/:id/acknowledge — clear stuck/failed alert
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/teams/:id/acknowledge',
    async (
      request: FastifyRequest<{ Params: TeamIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        if (isNaN(teamId) || teamId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid team ID',
          });
        }

        const db = getDatabase();
        const team = db.getTeam(teamId);
        if (!team) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Team ${teamId} not found`,
          });
        }

        // Only acknowledge stuck or failed teams
        if (team.status !== 'stuck' && team.status !== 'failed') {
          return reply.code(400).send({
            error: 'Bad Request',
            message: `Team ${teamId} is not stuck or failed (current status: ${team.status})`,
          });
        }

        const previousStatus = team.status;

        // Transition stuck -> idle (so it can be re-evaluated), failed -> done
        const newStatus = team.status === 'stuck' ? 'idle' : 'done';
        db.insertTransition({
          teamId,
          fromStatus: previousStatus,
          toStatus: newStatus,
          trigger: 'pm_action',
          reason: previousStatus === 'stuck' ? 'PM acknowledged stuck alert' : 'PM acknowledged failed alert',
        });
        const updated = db.updateTeam(teamId, {
          status: newStatus,
          lastEventAt: new Date().toISOString(),
        });

        // Broadcast status change
        sseBroker.broadcast(
          'team_status_changed',
          {
            team_id: teamId,
            status: newStatus,
            previous_status: previousStatus,
          },
          teamId,
        );

        return reply.code(200).send(updated);
      } catch (err: unknown) {
        request.log.error(err, 'Failed to acknowledge team alert');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams/:id/messages — agent messages for this team
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams/:id/messages',
    async (
      request: FastifyRequest<{ Params: TeamIdParams; Querystring: { limit?: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        if (isNaN(teamId) || teamId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid team ID',
          });
        }

        const db = getDatabase();
        const team = db.getTeam(teamId);
        if (!team) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Team ${teamId} not found`,
          });
        }

        const limitParam = (request.query as { limit?: string }).limit;
        const limit = limitParam ? parseInt(limitParam, 10) : undefined;

        const messages = db.getAgentMessages(teamId, limit);
        return reply.code(200).send(messages);
      } catch (err: unknown) {
        request.log.error(err, 'Failed to get agent messages');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/teams/:id/messages/summary — aggregated message counts
  // -------------------------------------------------------------------------
  fastify.get(
    '/api/teams/:id/messages/summary',
    async (
      request: FastifyRequest<{ Params: TeamIdParams }>,
      reply: FastifyReply,
    ) => {
      try {
        const teamId = parseInt(request.params.id, 10);
        if (isNaN(teamId) || teamId < 1) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Invalid team ID',
          });
        }

        const db = getDatabase();
        const team = db.getTeam(teamId);
        if (!team) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `Team ${teamId} not found`,
          });
        }

        const summary = db.getAgentMessageSummary(teamId);
        return reply.code(200).send(summary);
      } catch (err: unknown) {
        request.log.error(err, 'Failed to get agent message summary');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  done();
};

export default teamsRoutes;
