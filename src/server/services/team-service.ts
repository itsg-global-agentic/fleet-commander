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
import type { TeamPhase, IssueDependencyInfo } from '../../shared/types.js';
import { buildTimeline } from '../utils/build-timeline.js';
import { ServiceError, validationError, notFoundError, conflictError } from './service-error.js';

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
    issueTitle?: string;
    prompt?: string;
    headless?: boolean;
    force?: boolean;
  }): Promise<unknown> {
    const { projectId, issueNumber, issueTitle, prompt, headless, force } = params;

    if (!projectId || typeof projectId !== 'number' || projectId < 1) {
      throw validationError('projectId is required and must be a positive integer');
    }

    if (!issueNumber || typeof issueNumber !== 'number' || issueNumber < 1) {
      throw validationError('issueNumber is required and must be a positive integer');
    }

    // Dependency check -- block launch if unresolved dependencies exist
    if (!force) {
      const depInfo = await checkDependencies(projectId, issueNumber);
      if (depInfo && !depInfo.resolved) {
        const blockerNumbers = depInfo.blockedBy
          .filter((b) => b.state === 'open')
          .map((b) => b.number);
        githubPoller.trackBlockedIssue(projectId, issueNumber, blockerNumbers);

        throw new ServiceError(
          `Issue #${issueNumber} is blocked by ${depInfo.openCount} unresolved dependency${depInfo.openCount !== 1 ? 'ies' : ''}`,
          'BLOCKED_BY_DEPENDENCIES',
          409,
        );
      }
    }

    const manager = getTeamManager();
    return await manager.launch(projectId, issueNumber, issueTitle, prompt, headless, force);
  }

  /**
   * Launch multiple teams in a batch. Checks dependencies for each issue,
   * separating blocked from launchable issues. Intra-batch dependencies
   * are allowed (deferred to queue ordering).
   *
   * @param params - Batch launch parameters
   * @returns Object with launched teams and any blocked issues
   * @throws ServiceError with code VALIDATION for invalid input
   */
  async launchBatch(params: {
    projectId: number;
    issues: Array<{ number: number; title?: string }>;
    prompt?: string;
    delayMs?: number;
    headless?: boolean;
  }): Promise<{ launched: unknown[]; blocked?: Array<{ issueNumber: number; dependencies: IssueDependencyInfo }> }> {
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

    // Dependency check for batch launch
    const blocked: Array<{ issueNumber: number; dependencies: IssueDependencyInfo }> = [];
    const launchable: Array<{ number: number; title?: string }> = [];
    const batchNumbers = new Set(issues.map((i) => i.number));

    for (const issue of issues) {
      const depInfo = await checkDependencies(projectId, issue.number);
      if (depInfo && !depInfo.resolved) {
        const allBlockersInBatch = depInfo.blockedBy
          .filter((b) => b.state === 'open')
          .every((b) => batchNumbers.has(b.number));

        if (allBlockersInBatch) {
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

    return {
      launched: teams,
      blocked: blocked.length > 0 ? blocked : undefined,
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
    const launchedAt = team.launchedAt ? new Date(team.launchedAt) : null;
    const now = new Date();
    const durationMin = launchedAt
      ? Math.round((now.getTime() - launchedAt.getTime()) / 60_000)
      : 0;

    const lastEventAt = team.lastEventAt ? new Date(team.lastEventAt) : null;
    const idleMin = lastEventAt
      ? Math.round((now.getTime() - lastEventAt.getTime()) / 60_000 * 10) / 10
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
      text += `Issue: #${team.issueNumber} ${team.issueTitle ?? ''}\n`;
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
      db.updateTeam(teamId, { lastEventAt: new Date().toISOString() });
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
   * List all teams with dashboard data.
   *
   * @returns Array of team dashboard records
   */
  listTeams(): unknown[] {
    const db = getDatabase();
    return db.getTeamDashboard();
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
   * Get hook events for a team.
   *
   * @param teamId - The team ID
   * @param limit - Maximum number of events to return (default 100)
   * @returns Array of events
   * @throws ServiceError with code VALIDATION if teamId is invalid
   * @throws ServiceError with code NOT_FOUND if team doesn't exist
   */
  getEvents(teamId: number, limit = 100): unknown[] {
    if (isNaN(teamId) || teamId < 1) {
      throw validationError('Invalid team ID');
    }

    const db = getDatabase();
    const team = db.getTeam(teamId);
    if (!team) {
      throw notFoundError(`Team ${teamId} not found`);
    }

    return db.getEventsByTeam(teamId, limit);
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
