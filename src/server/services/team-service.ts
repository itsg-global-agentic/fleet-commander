// =============================================================================
// Fleet Commander — Team Service
// =============================================================================
// Manages team operations: launch, batch launch, detail assembly, status,
// timeline, export, messaging, phase setting, and alert acknowledgment.
// Owns all business logic, DB calls, SSE broadcasts, and filesystem ops.
// =============================================================================

import fs from 'fs';
import path from 'path';
import { getTeamManager } from './team-manager.js';
import { getIssueFetcher } from './issue-fetcher.js';
import { githubPoller } from './github-poller.js';
import { getDatabase } from '../db.js';
import { sseBroker } from './sse-broker.js';
import config from '../config.js';
import type { TeamPhase, IssueDependencyInfo, PaginatedResponse, TeamDashboardRow } from '../../shared/types.js';
import { buildTimeline } from '../utils/build-timeline.js';
import { ServiceError, validationError, notFoundError, conflictError, projectNotReadyError } from './service-error.js';
import { getProjectService } from './project-service.js';
import { formatIssueKey } from '../../shared/issue-provider.js';

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
      `[TeamService] Dependency check failed for issue #${issueNumber}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class TeamService {
  /**
   * Launch a single team for an issue. Checks dependencies (unless force=true),
   * tracks blocked issues for resolution detection, and delegates to TeamManager.
   *
   * @param params - Launch parameters
   * @returns The launched team record
   * @throws ServiceError with code VALIDATION for invalid input
   * @throws ServiceError with code CONFLICT if blocked by dependencies or already active
   */
  async launchTeam(params: {
    projectId: number;
    issueNumber: number;
    issueKey?: string;
    issueTitle?: string;
    prompt?: string;
    headless?: boolean;
    force?: boolean;
    queue?: boolean;
  }): Promise<unknown> {
    const { projectId, issueNumber, issueKey, issueTitle, prompt, headless, force, queue } = params;

    if (!projectId || typeof projectId !== 'number' || projectId < 1) {
      throw validationError('projectId is required and must be a positive integer');
    }

    // issueKey takes precedence; issueNumber required only when issueKey is absent
    if (!issueKey && (!issueNumber || typeof issueNumber !== 'number' || issueNumber < 1)) {
      throw validationError('issueNumber is required (and must be a positive integer) when issueKey is not provided');
    }

    // Project readiness check -- block launch if install health checks fail
    if (!force) {
      const projectService = getProjectService();
      const readiness = projectService.getProjectReadiness(projectId);
      if (!readiness.ready) {
        throw projectNotReadyError(
          `Project is not ready for launch: ${readiness.errors.join('; ')}`,
        );
      }
    }

    // Dependency check -- block launch if unresolved dependencies exist
    if (!force && issueNumber > 0) {
      const depInfo = await checkDependencies(projectId, issueNumber);
      if (depInfo && !depInfo.resolved) {
        const blockerNumbers = depInfo.blockedBy
          .filter((b) => b.state === 'open')
          .map((b) => b.number);

        // Queue mode: queue the team with blocker metadata instead of rejecting
        if (queue) {
          githubPoller.trackBlockedIssue(projectId, issueNumber, blockerNumbers);
          const manager = getTeamManager();
          return await manager.queueTeamWithBlockers(
            projectId, issueNumber, blockerNumbers, issueTitle, headless, prompt, issueKey,
          );
        }

        githubPoller.trackBlockedIssue(projectId, issueNumber, blockerNumbers);

        const displayKey = issueKey ?? `#${issueNumber}`;
        throw new ServiceError(
          `Issue ${displayKey} is blocked by ${depInfo.openCount} unresolved dependency${depInfo.openCount !== 1 ? 'ies' : ''}`,
          'BLOCKED_BY_DEPENDENCIES',
          409,
        );
      }
    }

    // If queue was requested but no dependencies exist, just launch normally
    const manager = getTeamManager();
    return await manager.launch(projectId, issueNumber, issueTitle, prompt, headless, force, issueKey);
  }

  /**
   * Launch multiple teams in a batch. Checks dependencies for each issue,
   * launching unblocked issues and queuing blocked ones (both intra-batch
   * and external blockers) via queueTeamWithBlockers for automatic
   * resolution-triggered launch.
   *
   * @param params - Batch launch parameters
   * @returns Object with launched teams and any queued teams
   * @throws ServiceError with code VALIDATION for invalid input
   */
  async launchBatch(params: {
    projectId: number;
    issues: Array<{ number: number; title?: string; issueKey?: string }>;
    prompt?: string;
    delayMs?: number;
    headless?: boolean;
  }): Promise<{ launched: unknown[]; queued?: Array<{ issueNumber: number; team: unknown; blockedBy: number[] }> }> {
    const { projectId, issues, prompt, delayMs, headless } = params;

    if (!projectId || typeof projectId !== 'number' || projectId < 1) {
      throw validationError('projectId is required and must be a positive integer');
    }

    if (!issues || !Array.isArray(issues) || issues.length === 0) {
      throw validationError('issues array is required and must not be empty');
    }

    for (const issue of issues) {
      if (!issue.number || typeof issue.number !== 'number' || issue.number < 1) {
        throw validationError(`Invalid issue number: ${JSON.stringify(issue)}`);
      }
    }

    // Project readiness check -- block batch launch if install health checks fail
    const projectService = getProjectService();
    const readiness = projectService.getProjectReadiness(projectId);
    if (!readiness.ready) {
      throw projectNotReadyError(
        `Project is not ready for launch: ${readiness.errors.join('; ')}`,
      );
    }

    // Dependency check for batch launch — separate launchable from queueable
    const launchable: Array<{ number: number; title?: string }> = [];
    const queueable: Array<{ issue: { number: number; title?: string }; blockerNumbers: number[] }> = [];

    for (const issue of issues) {
      const depInfo = await checkDependencies(projectId, issue.number);
      if (depInfo && !depInfo.resolved) {
        const openBlockerNumbers = depInfo.blockedBy
          .filter((b) => b.state === 'open')
          .map((b) => b.number);

        // Permissive fallback: if we have unresolved deps but no valid open
        // blocker numbers, treat as launchable rather than blocking forever
        if (openBlockerNumbers.length === 0) {
          launchable.push(issue);
        } else {
          queueable.push({ issue, blockerNumbers: openBlockerNumbers });
        }
      } else {
        launchable.push(issue);
      }
    }

    // Launch unblocked issues
    const manager = getTeamManager();
    const teams = launchable.length > 0
      ? await manager.launchBatch(projectId, launchable, prompt, delayMs, headless)
      : [];

    // Queue blocked issues with blocker metadata for auto-launch on resolution
    let queued: Array<{ issueNumber: number; team: unknown; blockedBy: number[] }> | undefined;

    if (queueable.length > 0) {
      queued = [];
      for (const { issue, blockerNumbers } of queueable) {
        try {
          githubPoller.trackBlockedIssue(projectId, issue.number, blockerNumbers);
          const team = await manager.queueTeamWithBlockers(
            projectId, issue.number, blockerNumbers, issue.title, headless, prompt,
          );
          queued.push({ issueNumber: issue.number, team, blockedBy: blockerNumbers });
        } catch (err: unknown) {
          // Log and continue — don't stop the batch for individual queue failures
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[TeamService] Batch queue failed for issue #${issue.number}: ${msg}`,
          );
        }
      }
      if (queued.length === 0) {
        queued = undefined;
      }
    }

    return {
      launched: teams,
      queued,
    };
  }

  /**
   * Assemble a full TeamDetail response with project info, duration,
   * PR detail, recent events, and output tail.
   *
   * @param teamId - The team ID
   * @returns Full team detail object
   * @throws ServiceError with code NOT_FOUND if team doesn't exist
   */
  getTeamDetail(teamId: number): unknown {
    const db = getDatabase();
    const team = db.getTeam(teamId);
    if (!team) {
      throw notFoundError(`Team ${teamId} not found`);
    }

    // Look up project to get model and GitHub repo
    let projectModel: string | null = null;
    let projectGithubRepo: string | null = null;
    if (team.projectId) {
      const project = db.getProject(team.projectId);
      if (project) {
        projectModel = project.model ?? null;
        projectGithubRepo = project.githubRepo ?? null;
      }
    }

    // Compute duration & idle in minutes
    // For completed teams (done/failed), cap at stopped_at rather than growing forever
    const launchedAt = team.launchedAt ? new Date(team.launchedAt) : null;
    const now = new Date();
    const endTime = team.stoppedAt ? new Date(team.stoppedAt) : now;
    const durationMin = launchedAt
      ? Math.round((endTime.getTime() - launchedAt.getTime()) / 60_000)
      : 0;

    const lastEventAt = team.lastEventAt ? new Date(team.lastEventAt) : null;
    const idleMin = lastEventAt
      ? Math.round((endTime.getTime() - lastEventAt.getTime()) / 60_000 * 10) / 10
      : null;

    // Pull request detail
    let prDetail = null;
    if (team.prNumber) {
      const pr = db.getPullRequest(team.prNumber);
      if (pr) {
        let checks: Array<{ name: string; status: string; conclusion: string | null }> = [];
        if (pr.checksJson) {
          try {
            checks = JSON.parse(pr.checksJson);
          } catch {
            // Malformed JSON -- leave empty
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

    return {
      id: team.id,
      issueNumber: team.issueNumber,
      issueTitle: team.issueTitle,
      issueKey: team.issueKey,
      issueProvider: team.issueProvider,
      model: projectModel,
      githubRepo: projectGithubRepo,
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
  }

  /**
   * Get compact team status with pending commands (MCP-compatible).
   * Supports lookup by integer ID or worktree name.
   *
   * @param idOrWorktree - Team ID (number) or worktree name (string)
   * @returns Compact status object with pending commands
   * @throws ServiceError with code NOT_FOUND if team doesn't exist
   */
  getTeamStatus(idOrWorktree: string): unknown {
    const db = getDatabase();
    const teamId = parseInt(idOrWorktree, 10);

    let team;
    if (!isNaN(teamId) && teamId > 0) {
      team = db.getTeam(teamId);
    }
    if (!team) {
      team = db.getTeamByWorktree(idOrWorktree);
    }
    if (!team) {
      throw notFoundError(`Team ${idOrWorktree} not found`);
    }

    const pendingCommands = db.getPendingCommands(team.id);
    const latestMessage = pendingCommands.length > 0 ? pendingCommands[0].message : null;

    return {
      id: team.id,
      issueNumber: team.issueNumber,
      issueKey: team.issueKey,
      issueProvider: team.issueProvider,
      worktreeName: team.worktreeName,
      status: team.status,
      phase: team.phase,
      pid: team.pid,
      prNumber: team.prNumber,
      lastEventAt: team.lastEventAt,
      pm_message: latestMessage,
      pending_commands: pendingCommands.map((c) => ({
        id: c.id,
        message: c.message,
        createdAt: c.createdAt,
      })),
    };
  }

  /**
   * Build a unified timeline merging stream events and hook events.
   *
   * @param teamId - The team ID
   * @param limit - Maximum number of timeline entries (default 500)
   * @returns Timeline entries
   * @throws ServiceError with code NOT_FOUND if team doesn't exist
   */
  getTeamTimeline(teamId: number, limit = 500): unknown {
    const db = getDatabase();
    const team = db.getTeam(teamId);
    if (!team) {
      throw notFoundError(`Team ${teamId} not found`);
    }

    const manager = getTeamManager();
    const streamEvents = manager.getParsedEvents(teamId);
    const hookEvents = db.getEventsByTeam(teamId, 500);

    return buildTimeline(streamEvents, hookEvents, teamId, limit);
  }

  /**
   * Export team logs in JSON or plain text format.
   *
   * @param teamId - The team ID
   * @param format - Export format ('json' or 'txt', default 'json')
   * @returns Export data object or plain text string
   * @throws ServiceError with code NOT_FOUND if team doesn't exist
   */
  exportTeam(teamId: number, format = 'json'): { data: unknown; contentType: string; filename: string } {
    const db = getDatabase();
    const team = db.getTeam(teamId);
    if (!team) {
      throw notFoundError(`Team ${teamId} not found`);
    }

    const events = db.getEventsByTeam(teamId);
    const manager = getTeamManager();
    const streamEvents = manager.getParsedEvents(teamId);
    const outputLines = manager.getOutput(teamId);

    if (format === 'txt') {
      let text = `# Team ${team.worktreeName} - Export\n`;
      text += `Issue: ${formatIssueKey(team.issueKey ?? String(team.issueNumber), team.issueProvider)} ${team.issueTitle ?? ''}\n`;
      text += `Status: ${team.status}\n`;
      text += `Launched: ${team.launchedAt ?? 'N/A'}\n\n`;
      text += `## Stream Events\n`;
      for (const e of streamEvents) {
        text += `[${e.timestamp ?? ''}] ${e.type} ${summarize(e as unknown as Record<string, unknown>)}\n`;
      }
      text += `\n## Raw Output\n`;
      text += outputLines.join('\n');

      return {
        data: text,
        contentType: 'text/plain',
        filename: `${team.worktreeName}-export.txt`,
      };
    }

    return {
      data: { team, events, streamEvents, output: outputLines },
      contentType: 'application/json',
      filename: `${team.worktreeName}-export.json`,
    };
  }

  /**
   * Send a PM message to a running team. Writes a .fleet-pm-message file,
   * inserts a command record in the DB, and attempts stdin delivery.
   *
   * @param teamId - The team ID
   * @param message - The message text to send
   * @returns Command record with delivery status
   * @throws ServiceError with code NOT_FOUND if team doesn't exist
   * @throws ServiceError with code VALIDATION if message is empty
   */
  sendMessage(teamId: number, message: string): { command: unknown; delivered: boolean } {
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      throw validationError('message is required and must be a non-empty string');
    }

    const db = getDatabase();
    const team = db.getTeam(teamId);
    if (!team) {
      throw notFoundError(`Team ${teamId} not found`);
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
      console.warn(`[TeamService] Failed to write .fleet-pm-message file: ${fsMsg}`);
      // Continue anyway -- the command record is still useful
    }

    // Insert command row in the database
    const command = db.insertCommand({
      teamId,
      message: message.trim(),
    });

    // Try to deliver via stdin pipe
    const manager = getTeamManager();
    const delivered = manager.sendMessage(teamId, message.trim(), 'user');
    if (delivered) {
      db.markCommandDelivered(command.id);
      db.updateTeamSilent(teamId, { lastEventAt: new Date().toISOString() });
    }

    return { command, delivered };
  }

  /**
   * Set the phase of a team (e.g. 'analyzing', 'implementing', 'reviewing').
   * Broadcasts SSE event for phase change.
   *
   * @param teamId - The team ID
   * @param phase - The new phase
   * @param reason - Optional reason for the phase change
   * @returns Updated team record
   * @throws ServiceError with code NOT_FOUND if team doesn't exist
   * @throws ServiceError with code VALIDATION if phase is invalid
   * @throws ServiceError with code CONFLICT if team is in terminal status
   */
  setPhase(teamId: number, phase: TeamPhase, reason?: string): unknown {
    const validPhases: TeamPhase[] = [
      'init', 'analyzing', 'implementing', 'reviewing', 'pr', 'done', 'blocked',
    ];
    if (!phase || !validPhases.includes(phase)) {
      throw validationError(
        `phase is required and must be one of: ${validPhases.join(', ')}`,
      );
    }

    const db = getDatabase();
    const team = db.getTeam(teamId);
    if (!team) {
      throw notFoundError(`Team ${teamId} not found`);
    }

    if (['done', 'failed'].includes(team.status)) {
      throw conflictError(
        `Cannot set phase on a ${team.status} team. Use restart to reactivate.`,
      );
    }

    const previousPhase = team.phase;
    const updated = db.updateTeam(teamId, { phase });

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

    return updated;
  }

  /**
   * Acknowledge a stuck or failed team alert. Transitions stuck->idle
   * or failed->done and broadcasts SSE event.
   *
   * @param teamId - The team ID
   * @returns Updated team record
   * @throws ServiceError with code NOT_FOUND if team doesn't exist
   * @throws ServiceError with code VALIDATION if team is not stuck or failed
   */
  acknowledgeAlert(teamId: number): unknown {
    const db = getDatabase();
    const team = db.getTeam(teamId);
    if (!team) {
      throw notFoundError(`Team ${teamId} not found`);
    }

    if (team.status !== 'stuck' && team.status !== 'failed') {
      throw validationError(
        `Team ${teamId} is not stuck or failed (current status: ${team.status})`,
      );
    }

    const previousStatus = team.status;
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

    sseBroker.broadcast(
      'team_status_changed',
      {
        team_id: teamId,
        status: newStatus,
        previous_status: previousStatus,
      },
      teamId,
    );

    return updated;
  }

  /**
   * Stop a single team by ID.
   *
   * @param teamId - The team ID
   * @returns The stopped team record
   * @throws ServiceError with code VALIDATION if teamId is invalid
   * @throws ServiceError with code NOT_FOUND if team doesn't exist
   */
  async stopTeam(teamId: number): Promise<unknown> {
    if (isNaN(teamId) || teamId < 1) {
      throw validationError('Invalid team ID');
    }

    const manager = getTeamManager();
    return await manager.stop(teamId);
  }

  /**
   * Stop all active teams.
   *
   * @returns Array of stopped team records
   */
  async stopAll(): Promise<unknown[]> {
    const manager = getTeamManager();
    return await manager.stopAll();
  }

  /**
   * Force-launch a queued team, bypassing normal queue ordering.
   *
   * @param teamId - The team ID
   * @returns The launched team record
   * @throws ServiceError with code VALIDATION if teamId is invalid
   * @throws ServiceError with code NOT_FOUND if team doesn't exist
   * @throws ServiceError with code CONFLICT if team is not queued
   */
  async forceLaunch(teamId: number): Promise<unknown> {
    if (isNaN(teamId) || teamId < 1) {
      throw validationError('Invalid team ID');
    }

    const manager = getTeamManager();
    return await manager.forceLaunch(teamId);
  }

  /**
   * Resume a stopped team.
   *
   * @param teamId - The team ID
   * @returns The resumed team record
   * @throws ServiceError with code VALIDATION if teamId is invalid
   * @throws ServiceError with code NOT_FOUND if team doesn't exist
   * @throws ServiceError with code CONFLICT if team is completed
   */
  async resumeTeam(teamId: number): Promise<unknown> {
    if (isNaN(teamId) || teamId < 1) {
      throw validationError('Invalid team ID');
    }

    const db = getDatabase();
    const existingTeam = db.getTeam(teamId);
    if (existingTeam && existingTeam.status === 'done') {
      throw conflictError('Cannot resume a completed team');
    }

    const manager = getTeamManager();
    return await manager.resume(teamId);
  }

  /**
   * Restart a team (stop and re-launch).
   *
   * @param teamId - The team ID
   * @param prompt - Optional new prompt for the restart
   * @returns The restarted team record
   * @throws ServiceError with code VALIDATION if teamId is invalid
   * @throws ServiceError with code NOT_FOUND if team doesn't exist
   * @throws ServiceError with code CONFLICT if team is completed
   */
  async restartTeam(teamId: number, prompt?: string): Promise<unknown> {
    if (isNaN(teamId) || teamId < 1) {
      throw validationError('Invalid team ID');
    }

    const db = getDatabase();
    const existingTeam = db.getTeam(teamId);
    if (existingTeam && existingTeam.status === 'done') {
      throw conflictError('Cannot restart a completed team');
    }

    const manager = getTeamManager();
    return await manager.restart(teamId, prompt);
  }

  /**
   * List all teams with dashboard data, with optional pagination.
   *
   * @param pagination - Optional limit/offset for paginated results
   * @returns Paginated response with team dashboard records, or full array when no pagination
   */
  listTeams(pagination?: { limit?: number; offset?: number }): PaginatedResponse<TeamDashboardRow> | TeamDashboardRow[] {
    const db = getDatabase();

    // When called without pagination args (internal callers), return bare array
    if (!pagination) {
      return db.getTeamDashboard();
    }

    const data = db.getTeamDashboard(pagination);
    const total = db.getTeamDashboardCount();
    return {
      data,
      total,
      limit: pagination.limit ?? data.length,
      offset: pagination.offset ?? 0,
    };
  }

  /**
   * Get the rolling output buffer for a team.
   *
   * @param teamId - The team ID
   * @param lines - Optional max lines to return
   * @returns Object with teamId, lines array, and count
   * @throws ServiceError with code VALIDATION if teamId is invalid
   * @throws ServiceError with code NOT_FOUND if team doesn't exist
   */
  getOutput(teamId: number, lines?: number): { teamId: number; lines: string[]; count: number } {
    if (isNaN(teamId) || teamId < 1) {
      throw validationError('Invalid team ID');
    }

    const db = getDatabase();
    const team = db.getTeam(teamId);
    if (!team) {
      throw notFoundError(`Team ${teamId} not found`);
    }

    const manager = getTeamManager();
    const output = manager.getOutput(teamId, lines);

    return {
      teamId,
      lines: output,
      count: output.length,
    };
  }

  /**
   * Get parsed NDJSON stream events from Claude Code for a team.
   *
   * @param teamId - The team ID
   * @returns Array of parsed stream events
   * @throws ServiceError with code VALIDATION if teamId is invalid
   * @throws ServiceError with code NOT_FOUND if team doesn't exist
   */
  getStreamEvents(teamId: number): unknown[] {
    if (isNaN(teamId) || teamId < 1) {
      throw validationError('Invalid team ID');
    }

    const db = getDatabase();
    const team = db.getTeam(teamId);
    if (!team) {
      throw notFoundError(`Team ${teamId} not found`);
    }

    const manager = getTeamManager();
    return manager.getParsedEvents(teamId);
  }

  /**
   * Get hook events for a team, with optional pagination.
   *
   * @param teamId - The team ID
   * @param limit - Maximum number of events to return (default 500)
   * @param offset - Number of events to skip (default 0)
   * @returns Paginated response with events
   * @throws ServiceError with code VALIDATION if teamId is invalid
   * @throws ServiceError with code NOT_FOUND if team doesn't exist
   */
  getEvents(teamId: number, limit = 500, offset = 0): PaginatedResponse<unknown> {
    if (isNaN(teamId) || teamId < 1) {
      throw validationError('Invalid team ID');
    }

    const db = getDatabase();
    const team = db.getTeam(teamId);
    if (!team) {
      throw notFoundError(`Team ${teamId} not found`);
    }

    const data = db.getEventsByTeam(teamId, limit, offset);
    const total = db.getEventsByTeamCount(teamId);
    return { data, total, limit, offset };
  }

  /**
   * Get team member roster derived from events.
   *
   * @param teamId - The team ID
   * @returns Roster data
   * @throws ServiceError with code VALIDATION if teamId is invalid
   * @throws ServiceError with code NOT_FOUND if team doesn't exist
   */
  getRoster(teamId: number): unknown {
    if (isNaN(teamId) || teamId < 1) {
      throw validationError('Invalid team ID');
    }

    const db = getDatabase();
    const team = db.getTeam(teamId);
    if (!team) {
      throw notFoundError(`Team ${teamId} not found`);
    }

    return db.getTeamRoster(teamId);
  }

  /**
   * Get state transition history for a team.
   *
   * @param teamId - The team ID
   * @returns Array of transitions
   * @throws ServiceError with code VALIDATION if teamId is invalid
   * @throws ServiceError with code NOT_FOUND if team doesn't exist
   */
  getTransitions(teamId: number): unknown[] {
    if (isNaN(teamId) || teamId < 1) {
      throw validationError('Invalid team ID');
    }

    const db = getDatabase();
    const team = db.getTeam(teamId);
    if (!team) {
      throw notFoundError(`Team ${teamId} not found`);
    }

    return db.getTransitions(teamId);
  }

  /**
   * Get agent messages for a team.
   *
   * @param teamId - The team ID
   * @param limit - Optional max messages to return
   * @returns Array of agent messages
   * @throws ServiceError with code VALIDATION if teamId is invalid
   * @throws ServiceError with code NOT_FOUND if team doesn't exist
   */
  getMessages(teamId: number, limit?: number): unknown[] {
    if (isNaN(teamId) || teamId < 1) {
      throw validationError('Invalid team ID');
    }

    const db = getDatabase();
    const team = db.getTeam(teamId);
    if (!team) {
      throw notFoundError(`Team ${teamId} not found`);
    }

    return db.getAgentMessages(teamId, limit);
  }

  /**
   * Get aggregated message counts for a team.
   *
   * @param teamId - The team ID
   * @returns Message summary
   * @throws ServiceError with code VALIDATION if teamId is invalid
   * @throws ServiceError with code NOT_FOUND if team doesn't exist
   */
  getMessageSummary(teamId: number): unknown {
    if (isNaN(teamId) || teamId < 1) {
      throw validationError('Invalid team ID');
    }

    const db = getDatabase();
    const team = db.getTeam(teamId);
    if (!team) {
      throw notFoundError(`Team ${teamId} not found`);
    }

    return db.getAgentMessageSummary(teamId);
  }

  /**
   * Get tasks for a team.
   *
   * @param teamId - The team ID
   * @returns Array of team tasks
   * @throws ServiceError with code VALIDATION if teamId is invalid
   * @throws ServiceError with code NOT_FOUND if team doesn't exist
   */
  getTasks(teamId: number): unknown[] {
    if (isNaN(teamId) || teamId < 1) {
      throw validationError('Invalid team ID');
    }

    const db = getDatabase();
    const team = db.getTeam(teamId);
    if (!team) {
      throw notFoundError(`Team ${teamId} not found`);
    }

    return db.getTeamTasks(teamId);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: TeamService | null = null;

/**
 * Get the singleton TeamService instance.
 *
 * @returns TeamService singleton
 */
export function getTeamService(): TeamService {
  if (!_instance) {
    _instance = new TeamService();
  }
  return _instance;
}
