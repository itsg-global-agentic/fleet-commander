// =============================================================================
// Fleet Commander — Team Manager Service (Spawn / Stop / Resume)
// =============================================================================
// Manages Claude Code agent processes: creates git worktrees, copies FC files
// (hooks, agents, guides, prompts, settings), spawns child processes, captures
// output, and handles lifecycle transitions.
//
// Per-project: launch() accepts a projectId and resolves repo path, github
// repo, and worktree naming from the project record in the database.
// =============================================================================

import { execSync, exec as execCallback, ChildProcess } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import type { Writable } from 'stream';
import config from '../config.js';
import { getDatabase } from '../db.js';
import { sseBroker } from './sse-broker.js';
import type { StreamEvent } from './sse-broker.js';
import { spawnHeadless, spawnInteractive } from '../utils/cc-spawn.js';
import type { Team, Project } from '../../shared/types.js';
import { getUsageZone } from './usage-tracker.js';
import { resolveMessage } from '../utils/resolve-message.js';
import { CircularBuffer } from '../utils/circular-buffer.js';
import { getHookFiles as getManifestHookFiles, getAgentFiles as getManifestAgentFiles, getGuideFiles as getManifestGuideFiles, getWorkflowFile } from '../utils/fc-manifest.js';
import { classifyAgentRole, shouldAdvancePhase } from './event-collector.js';
import type { TeamPhase } from '../../shared/types.js';
import { isValidGithubRepo } from '../utils/exec-gh.js';

const execAsync = promisify(execCallback);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_OUTPUT_LINES = config.outputBufferLines;
const MAX_PARSED_EVENTS = 1000;

// ---------------------------------------------------------------------------
// summarizeEvent — short text summary for console logging
// ---------------------------------------------------------------------------

function summarizeEvent(event: StreamEvent): string {
  switch (event.type) {
    case 'assistant': {
      const content = (event.message as any)?.content;
      if (Array.isArray(content)) {
        const text = content.find((c: any) => c.type === 'text')?.text ?? '';
        return text.substring(0, 100) + (text.length > 100 ? '...' : '');
      }
      return '';
    }
    case 'tool_use': {
      const tool = (event as any).tool;
      return `${tool?.name ?? 'unknown'}`;
    }
    case 'tool_result':
      return 'completed';
    case 'result':
      return 'session complete';
    default:
      return event.type;
  }
}

// ---------------------------------------------------------------------------
// TeamManager
// ---------------------------------------------------------------------------

interface TokenCounter {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export class TeamManager {
  private outputBuffers: Map<number, CircularBuffer<string>> = new Map();
  private childProcesses: Map<number, ChildProcess> = new Map();
  private stdinPipes: Map<number, Writable> = new Map();
  private parsedEvents: Map<number, StreamEvent[]> = new Map();
  private tokenCounters: Map<number, TokenCounter> = new Map();
  private _processingQueue = new Set<number>();
  private shutdownTimers: Map<number, NodeJS.Timeout> = new Map();

  /**
   * Per-team map of tool_use_id -> agent name.
   * When the TL spawns a subagent via the "Agent" or "Task" tool, the tool_use
   * content block's `id` becomes the `parent_tool_use_id` on subsequent
   * assistant events from that subagent. We extract the agent name from the
   * tool input (e.g. `input.name` = "dev") and store it here so every stream
   * event can be tagged with the originating agent name.
   */
  private agentMaps: Map<number, Map<string, string>> = new Map();

  /** Teams currently in extended thinking — tracked in-memory only */
  readonly thinkingTeams: Set<number> = new Set();
  /** Timestamp when thinking started for each team (for duration tracking) */
  private thinkingStartTimes: Map<number, number> = new Map();
  /** Content block index of the active thinking block per team */
  private thinkingBlockIndex: Map<number, number> = new Map();
  /** Timestamp of last meaningful stdout stream event per team (hook fallback) */
  private lastStreamAt: Map<number, number> = new Map();

  // -------------------------------------------------------------------------
  // syncWithOrigin — fetch + pull before creating a worktree
  // -------------------------------------------------------------------------

  /**
   * Sync local repo with origin before creating a worktree.
   * Returns the number of commits the local default branch was behind origin.
   */
  private async syncWithOrigin(repoPath: string, teamId: number): Promise<number> {
    let commitsBehind = 0;
    try {
      // Fetch latest from origin
      await execAsync('git fetch origin', {
        cwd: repoPath,
        timeout: 30000,
      });

      // Detect default branch
      let defaultBranch = 'main';
      try {
        const { stdout } = await execAsync('git symbolic-ref refs/remotes/origin/HEAD', {
          cwd: repoPath,
          timeout: 5000,
        });
        defaultBranch = stdout.trim().replace(/^refs\/remotes\/origin\//, '');
      } catch {
        // Fallback to 'main'
      }

      // Count commits behind
      try {
        const { stdout } = await execAsync(`git rev-list --count HEAD..origin/${defaultBranch}`, {
          cwd: repoPath,
          timeout: 5000,
        });
        commitsBehind = parseInt(stdout.trim(), 10) || 0;
      } catch {
        // Non-fatal
      }

      // Pull to sync local default branch
      if (commitsBehind > 0) {
        console.log(`[TeamManager] Local is ${commitsBehind} commits behind origin/${defaultBranch}, pulling...`);
        try {
          await execAsync(`git pull origin ${defaultBranch} --ff-only`, {
            cwd: repoPath,
            timeout: 30000,
          });
          console.log(`[TeamManager] Pulled ${commitsBehind} commits from origin/${defaultBranch}`);
        } catch (pullErr) {
          console.warn(`[TeamManager] Fast-forward pull failed, trying merge:`, pullErr instanceof Error ? pullErr.message : String(pullErr));
          // If ff-only fails, don't force — just warn
        }
      } else {
        console.log(`[TeamManager] Repo is up to date with origin/${defaultBranch}`);
      }

      // Inject a log event into the team's session log
      const syncEvent: StreamEvent = {
        type: 'fc',
        subtype: 'origin_sync',
        agentName: '__fc__',
        timestamp: new Date().toISOString(),
        message: {
          content: [{
            type: 'text',
            text: commitsBehind > 0
              ? `Synced with origin/${defaultBranch}: pulled ${commitsBehind} commit(s)`
              : `Up to date with origin/${defaultBranch}`,
          }],
        },
      };
      const events = this.parsedEvents.get(teamId);
      if (events) events.push(syncEvent);
      sseBroker.broadcast('team_output', { team_id: teamId, event: syncEvent }, teamId);

    } catch (err) {
      console.error(`[TeamManager] Failed to sync with origin:`, err instanceof Error ? err.message : String(err));
    }
    return commitsBehind;
  }

  // -------------------------------------------------------------------------
  // launch — create worktree, copy hooks, spawn Claude Code
  // -------------------------------------------------------------------------

  async launch(
    projectId: number,
    issueNumber: number,
    issueTitle?: string,
    prompt?: string,
    headless?: boolean,
    force?: boolean,
  ): Promise<Team> {
    const db = getDatabase();

    // Look up project to get repo_path, github_repo, name
    const project = db.getProject(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    console.log(`[TeamManager] Launch started: project=${project.name} issue=#${issueNumber}`);

    // Usage gate: if in red zone and not forced, queue instead of launching
    if (!force && getUsageZone() === 'red') {
      console.log(`[TeamManager] Usage zone is RED — queueing team for issue #${issueNumber}`);
      return this.queueTeam(db, project, projectId, issueNumber, issueTitle, headless, prompt);
    }

    // Check active team limit before proceeding
    const activeCount = db.getActiveTeamCountByProject(projectId);
    if (activeCount >= project.maxActiveTeams) {
      // Queue this team instead of launching
      return this.queueTeam(db, project, projectId, issueNumber, issueTitle, headless, prompt);
    }

    // If no title provided, fetch from GitHub
    if (!issueTitle && project.githubRepo && isValidGithubRepo(project.githubRepo)) {
      try {
        const { stdout } = await execAsync(
          `gh issue view ${issueNumber} --repo "${project.githubRepo}" --json title --jq .title`,
          { timeout: 10000 },
        );
        const result = stdout.trim();
        if (result) {
          issueTitle = result;
          console.log(`[TeamManager] Fetched issue title from GitHub: "${issueTitle}"`);
        }
      } catch {
        // GitHub fetch failed, use fallback
        issueTitle = `Issue #${issueNumber}`;
        console.log(`[TeamManager] GitHub title fetch failed, using fallback: "${issueTitle}"`);
      }
    } else if (!issueTitle) {
      issueTitle = `Issue #${issueNumber}`;
    }

    // Derive worktree naming from project
    const { worktreeName, branchName, worktreeRelPath, worktreeAbsPath } =
      this.deriveWorktreeNames(project, issueNumber);

    // Check if a team already exists for this worktree name
    const existing = db.getTeamByWorktree(worktreeName);
    let relaunchTeamId: number | null = null;

    if (existing) {
      if (['running', 'launching', 'idle', 'stuck', 'queued'].includes(existing.status)) {
        throw new Error(`Team already active for issue ${issueNumber} (status: ${existing.status})`);
      }
      if (existing.status === 'done') {
        throw new Error(`Team already completed for issue ${issueNumber} — completed teams cannot be relaunched`);
      }
      // Terminal state (failed) — reuse the existing team record
      relaunchTeamId = existing.id;
    }

    // ── Step 1: Insert or reuse team record in DB (status: queued) ──
    // Team appears in FleetGrid immediately at this point.
    const now = new Date().toISOString();
    let team: Team;

    if (relaunchTeamId !== null) {
      // Relaunch: reset the existing terminal team record
      console.log(`[TeamManager] Relaunching existing team record: id=${relaunchTeamId}, worktree=${worktreeName}`);
      const prevTeam = db.getTeam(relaunchTeamId);
      db.updateTeam(relaunchTeamId, {
        status: 'queued',
        phase: 'init',
        pid: null,
        sessionId: null,
        issueTitle: issueTitle ?? null,
        headless: headless !== false,
        launchedAt: now,
        stoppedAt: null,
        lastEventAt: null,
      });
      db.insertTransition({
        teamId: relaunchTeamId,
        fromStatus: prevTeam?.status ?? 'failed',
        toStatus: 'queued',
        trigger: 'pm_action',
        reason: 'Relaunched by PM',
      });
      team = db.getTeam(relaunchTeamId)!;
    } else {
      // Fresh launch: insert new team record
      console.log(`[TeamManager] Inserting team record: worktree=${worktreeName}, branch=${branchName}`);
      team = db.insertTeam({
        projectId,
        issueNumber,
        issueTitle: issueTitle ?? null,
        worktreeName,
        branchName,
        status: 'queued',
        phase: 'init',
        headless: headless !== false,
        launchedAt: now,
      });
    }

    console.log(`[TeamManager] Team queued: id=${team.id}, status=queued, relaunch=${relaunchTeamId !== null}`);

    // Broadcast immediately so the team appears in the grid right away
    this.broadcastSnapshot();

    // Sync with origin before creating worktree
    await this.syncWithOrigin(project.repoPath, team.id);

    // ── Step 2: Create git worktree in the PROJECT's repo ──
    const worktreeOk = await this.createWorktree(
      project.repoPath, worktreeRelPath, worktreeAbsPath, branchName, team.id, 'queued',
    );
    if (!worktreeOk) {
      throw new Error(`Failed to create worktree for team ${team.id}`);
    }

    console.log(`[TeamManager] Worktree created: ${worktreeName} at ${worktreeAbsPath}`);

    // Update team status to launching now that worktree exists
    db.insertTransition({
      teamId: team.id,
      fromStatus: 'queued',
      toStatus: 'launching',
      trigger: 'system',
      reason: 'Worktree created, spawning Claude Code process',
    });
    db.updateTeam(team.id, { status: 'launching' });
    this.broadcastSnapshot();

    // ── Step 3: Copy hook scripts and settings into worktree ──
    this.copyFCFiles(worktreeAbsPath);

    // ── Step 4: Spawn Claude Code process ──
    const resolvedPrompt = prompt || this.resolvePromptFromFile(project, issueNumber);
    const isHeadless = headless !== false;

    if (!isHeadless && process.platform === 'win32') {
      // ── Interactive mode (Windows): open Claude Code in a new terminal ──
      await this.launchInteractive(team, project, worktreeAbsPath, resolvedPrompt);
      return db.getTeam(team.id)!;
    }

    // ── Headless mode (default): spawn in background, capture output ──
    const child = spawnHeadless({
      mode: 'headless',
      worktreeName,
      cwd: project.repoPath,
      model: project.model,
      resume: false,
      fleetContext: { teamId: worktreeName, projectId, githubRepo: project.githubRepo ?? '' },
    });

    const pid = child.pid;
    if (pid === undefined) {
      console.error(`[TeamManager] ERROR: spawn failed for team ${team.id}: no PID returned`);
      db.insertTransition({
        teamId: team.id,
        fromStatus: 'launching',
        toStatus: 'failed',
        trigger: 'system',
        reason: 'Spawn failed: no PID returned',
      });
      db.updateTeam(team.id, { status: 'failed', stoppedAt: new Date().toISOString() });
      this.broadcastSnapshot();
      throw new Error('Failed to spawn Claude Code process — no PID returned');
    }

    console.log(`[TeamManager] Process spawned: PID ${pid} (headless=${isHeadless})`);
    db.updateTeam(team.id, { pid });
    this.broadcastSnapshot();
    this.childProcesses.set(team.id, child);

    this.setupStdinAndOutput(team.id, child, resolvedPrompt);
    this.attachProcessHandlers(team.id, child);

    sseBroker.broadcast(
      'team_launched',
      { team_id: team.id, issue_number: issueNumber, project_id: projectId },
      team.id,
    );

    return db.getTeam(team.id)!;
  }

  // -------------------------------------------------------------------------
  // stop — kill process tree
  // -------------------------------------------------------------------------

  async stop(teamId: number): Promise<Team> {
    const db = getDatabase();
    const team = db.getTeam(teamId);
    if (!team) {
      throw new Error(`Team ${teamId} not found`);
    }

    // Cancel any pending merge-shutdown timer for this team
    const pendingTimer = this.shutdownTimers.get(teamId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.shutdownTimers.delete(teamId);
    }

    // Queued teams have no process — just cancel them directly
    if (team.status === 'queued') {
      db.insertTransition({
        teamId,
        fromStatus: 'queued',
        toStatus: 'failed',
        trigger: 'pm_action',
        reason: 'PM stopped queued team',
      });
      db.updateTeam(teamId, { status: 'failed', stoppedAt: new Date().toISOString() });
      this.broadcastSnapshot();
      return db.getTeam(teamId)!;
    }

    // Try graceful shutdown via stdin.end() first — closing stdin signals
    // Claude Code to finish its current work and exit cleanly.
    const stdin = this.stdinPipes.get(teamId);
    if (stdin && !stdin.destroyed) {
      try {
        stdin.end();
        console.log(`[TeamManager] Sent stdin EOF to team ${teamId} for graceful shutdown`);
        // Give the process 5 seconds to finish gracefully before force-killing
        await new Promise(resolve => setTimeout(resolve, 5000));
      } catch {
        // stdin.end() failed — fall through to force kill
      }
    }
    this.stdinPipes.delete(teamId);

    // Force kill if still running — re-read from DB to get fresh PID
    // (the process may have exited during the 5s grace period)
    const freshTeam = db.getTeam(teamId);
    if (freshTeam?.pid) {
      this.killProcess(freshTeam.pid);
    }

    // Flush counters/events before purging (they read from maps)
    this.flushTokenCounters(teamId);
    this.persistParsedEvents(teamId);
    this.purgeTeamMaps(teamId);

    // Re-read to get the latest status (process exit handler may have already updated it)
    const stopTeam = db.getTeam(teamId);
    if (stopTeam && !['done', 'failed'].includes(stopTeam.status)) {
      db.insertTransition({
        teamId,
        fromStatus: stopTeam.status,
        toStatus: 'failed',
        trigger: 'pm_action',
        reason: 'PM stopped team',
      });
    }

    const updated = db.updateTeam(teamId, {
      status: 'failed',
      pid: null,
      stoppedAt: new Date().toISOString(),
    });

    sseBroker.broadcast(
      'team_stopped',
      { team_id: teamId },
      teamId,
    );

    this.broadcastSnapshot();

    // Process queue when a slot frees up
    if (team.projectId) {
      this.processQueue(team.projectId).catch((err) => {
        console.error(`[TeamManager] processQueue error after stop:`, err);
      });
    }

    return updated!;
  }

  // -------------------------------------------------------------------------
  // resume — re-spawn with --resume flag in existing worktree
  // -------------------------------------------------------------------------

  async resume(teamId: number): Promise<Team> {
    const db = getDatabase();
    const team = db.getTeam(teamId);
    if (!team) {
      throw new Error(`Team ${teamId} not found`);
    }

    if (team.status === 'done') {
      throw new Error('Cannot resume a completed team');
    }

    // Resolve project for repo path and queue limit check
    if (!team.projectId) {
      throw new Error(`Team ${teamId} has no project`);
    }
    const project = db.getProject(team.projectId);
    if (!project) {
      throw new Error(`Project for team ${teamId} not found (projectId: ${team.projectId})`);
    }

    // Check queue limit — if too many teams are active, queue the resume instead
    const activeCount = db.getActiveTeamCountByProject(team.projectId);
    if (activeCount >= project.maxActiveTeams) {
      db.insertTransition({
        teamId,
        fromStatus: team.status,
        toStatus: 'queued',
        trigger: 'pm_action',
        reason: `Resume queued (${activeCount}/${project.maxActiveTeams} active)`,
      });
      db.updateTeam(teamId, { status: 'queued' });
      console.log(`[TeamManager] Resume queued for team ${teamId} (${activeCount}/${project.maxActiveTeams} active)`);
      this.broadcastSnapshot();
      return db.getTeam(teamId)!;
    }

    // Verify worktree still exists
    const worktreeAbsPath = path.join(
      project.repoPath, config.worktreeDir, team.worktreeName,
    );
    if (!fs.existsSync(worktreeAbsPath)) {
      throw new Error(`Worktree ${team.worktreeName} no longer exists at ${worktreeAbsPath}`);
    }

    // Update status to launching
    db.insertTransition({
      teamId,
      fromStatus: team.status,
      toStatus: 'launching',
      trigger: 'pm_action',
      reason: 'PM resumed team',
    });
    db.updateTeam(teamId, {
      status: 'launching',
      launchedAt: new Date().toISOString(),
      stoppedAt: null,
    });

    // Resume: headless mode with --resume flag (always stream-json)
    const child = spawnHeadless({
      mode: 'headless',
      worktreeName: team.worktreeName,
      cwd: project.repoPath,
      model: project.model,
      resume: true,
      fleetContext: { teamId: team.worktreeName, projectId: project.id, githubRepo: project.githubRepo ?? '' },
    });

    const pid = child.pid;
    if (pid === undefined) {
      console.error(`[TeamManager] ERROR: spawn failed for team ${teamId}: no PID returned`);
      db.insertTransition({
        teamId,
        fromStatus: 'launching',
        toStatus: 'failed',
        trigger: 'system',
        reason: 'Spawn failed: no PID returned',
      });
      db.updateTeam(teamId, { status: 'failed', stoppedAt: new Date().toISOString() });
      this.broadcastSnapshot();
      throw new Error('Failed to spawn Claude Code process — no PID returned');
    }

    console.log(`[TeamManager] Resume process spawned: PID ${pid}`);
    db.updateTeam(teamId, { pid });
    this.broadcastSnapshot();
    this.childProcesses.set(teamId, child);

    // Resume: no initial prompt — just set up stdin and output capture
    this.setupStdinAndOutput(teamId, child);
    this.attachProcessHandlers(teamId, child);

    sseBroker.broadcast(
      'team_launched',
      { team_id: teamId, issue_number: team.issueNumber },
      teamId,
    );

    this.broadcastSnapshot();

    return db.getTeam(teamId)!;
  }

  // -------------------------------------------------------------------------
  // restart — stop then launch
  // -------------------------------------------------------------------------

  async restart(teamId: number, prompt?: string): Promise<Team> {
    const db = getDatabase();
    const team = db.getTeam(teamId);
    if (!team) {
      throw new Error(`Team ${teamId} not found`);
    }

    if (team.status === 'done') {
      throw new Error('Cannot restart a completed team');
    }

    // Stop if running or queued
    if (['launching', 'running', 'idle', 'stuck', 'queued'].includes(team.status)) {
      await this.stop(teamId);
    }

    // Re-launch with the team's project
    const projectId = team.projectId;
    if (!projectId) {
      throw new Error(`Team ${teamId} has no projectId — cannot restart`);
    }

    return this.launch(projectId, team.issueNumber, team.issueTitle ?? undefined, prompt);
  }

  // -------------------------------------------------------------------------
  // stopAll — stop all running teams
  // -------------------------------------------------------------------------

  async stopAll(): Promise<Team[]> {
    // Clear any pending merge-shutdown timers before force-stopping
    this.clearShutdownTimers();

    const db = getDatabase();
    const activeTeams = db.getActiveTeams();
    const results: Team[] = [];

    for (const team of activeTeams) {
      try {
        const stopped = await this.stop(team.id);
        results.push(stopped);
      } catch {
        // Log but continue stopping other teams
        results.push(team);
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // killAll — immediately kill all child processes (server shutdown fast-path)
  // -------------------------------------------------------------------------

  /**
   * Immediately kill all tracked child processes without waiting for graceful
   * shutdown. This is the fast-path used during server shutdown (Ctrl+C) to
   * ensure the Node.js event loop can exit promptly.
   *
   * Unlike stopAll(), this method:
   * - Does NOT wait for graceful stdin EOF / 5s timeout per team
   * - Does NOT update the database or broadcast SSE events
   * - DOES unref all stdio streams so they don't keep the event loop alive
   */
  killAll(): void {
    // Clear any pending merge-shutdown timers
    this.clearShutdownTimers();

    for (const [teamId, child] of this.childProcesses) {
      try {
        // Destroy stdio streams so they stop holding the event loop
        if (child.stdin && !child.stdin.destroyed) {
          child.stdin.destroy();
        }
        if (child.stdout) {
          child.stdout.destroy();
        }
        if (child.stderr) {
          child.stderr.destroy();
        }

        // Kill the process tree
        if (child.pid) {
          this.killProcess(child.pid);
        }

        // Unref the child process itself so it doesn't block exit
        child.unref();
      } catch {
        // Ignore errors during shutdown — best-effort cleanup
      }
    }

    // Clear all tracking maps
    this.childProcesses.clear();
    this.stdinPipes.clear();
    this.outputBuffers.clear();
    this.parsedEvents.clear();
    this.tokenCounters.clear();
    this.agentMaps.clear();
    this.lastStreamAt.clear();
    this.thinkingTeams.clear();
    this.thinkingStartTimes.clear();
    this.thinkingBlockIndex.clear();
  }

  // -------------------------------------------------------------------------
  // queueTeam — insert a team with 'queued' status without spawning
  // -------------------------------------------------------------------------

  private async queueTeam(
    db: ReturnType<typeof getDatabase>,
    project: NonNullable<ReturnType<ReturnType<typeof getDatabase>['getProject']>>,
    projectId: number,
    issueNumber: number,
    issueTitle?: string,
    headless?: boolean,
    prompt?: string,
  ): Promise<Team> {
    // Fetch title from GitHub if needed
    if (!issueTitle && project.githubRepo && isValidGithubRepo(project.githubRepo)) {
      try {
        const { stdout } = await execAsync(
          `gh issue view ${issueNumber} --repo "${project.githubRepo}" --json title --jq .title`,
          { timeout: 10000 },
        );
        const result = stdout.trim();
        if (result) issueTitle = result;
      } catch {
        issueTitle = `Issue #${issueNumber}`;
      }
    } else if (!issueTitle) {
      issueTitle = `Issue #${issueNumber}`;
    }

    const { worktreeName, branchName } = this.deriveWorktreeNames(project, issueNumber);

    // Check for existing team
    const existing = db.getTeamByWorktree(worktreeName);
    if (existing) {
      if (['running', 'launching', 'idle', 'stuck', 'queued'].includes(existing.status)) {
        throw new Error(`Team already active for issue ${issueNumber} (status: ${existing.status})`);
      }
      if (existing.status === 'done') {
        throw new Error(`Team already completed for issue ${issueNumber} — completed teams cannot be relaunched`);
      }
      // Terminal state (failed) — reuse the existing team record as queued
      const now = new Date().toISOString();
      db.updateTeam(existing.id, {
        status: 'queued',
        phase: 'init',
        pid: null,
        sessionId: null,
        issueTitle: issueTitle ?? null,
        customPrompt: prompt ?? null,
        headless: headless !== false,
        launchedAt: now,
        stoppedAt: null,
        lastEventAt: null,
      });
      db.insertTransition({
        teamId: existing.id,
        fromStatus: existing.status,
        toStatus: 'queued',
        trigger: 'pm_action',
        reason: 'Re-queued by PM (queue path)',
      });
      const team = db.getTeam(existing.id)!;
      const activeCount = db.getActiveTeamCountByProject(projectId);
      console.log(`[TeamManager] Team ${team.id} queued (${activeCount}/${project.maxActiveTeams} active, headless=${team.headless})`);
      this.broadcastSnapshot();
      return team;
    }

    // Fresh insert with queued status
    const now = new Date().toISOString();
    const team = db.insertTeam({
      projectId,
      issueNumber,
      issueTitle: issueTitle ?? null,
      worktreeName,
      branchName,
      status: 'queued',
      phase: 'init',
      customPrompt: prompt ?? null,
      headless: headless !== false,
      launchedAt: now,
    });
    db.insertTransition({
      teamId: team.id,
      fromStatus: 'queued',
      toStatus: 'queued',
      trigger: 'pm_action',
      reason: 'Team created and queued',
    });

    const activeCount = db.getActiveTeamCountByProject(projectId);
    console.log(`[TeamManager] Team ${team.id} queued (${activeCount}/${project.maxActiveTeams} active)`);
    this.broadcastSnapshot();
    return team;
  }

  // -------------------------------------------------------------------------
  // queueTeamWithBlockers — queue a team with explicit blocker metadata
  // -------------------------------------------------------------------------

  /**
   * Queue a team that has unresolved dependencies, storing the blocker
   * issue numbers in the `blocked_by_json` column. This allows the GitHub
   * poller to detect when blockers are resolved and trigger queue processing.
   *
   * Similar to queueTeam() but stores blocker metadata in the DB for
   * persistence across server restarts.
   */
  async queueTeamWithBlockers(
    projectId: number,
    issueNumber: number,
    blockerNumbers: number[],
    issueTitle?: string,
    headless?: boolean,
    prompt?: string,
  ): Promise<Team> {
    const db = getDatabase();
    const project = db.getProject(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    // Fetch title from GitHub if needed
    if (!issueTitle && project.githubRepo && isValidGithubRepo(project.githubRepo)) {
      try {
        const { stdout } = await execAsync(
          `gh issue view ${issueNumber} --repo "${project.githubRepo}" --json title --jq .title`,
          { timeout: 10000 },
        );
        const result = stdout.trim();
        if (result) issueTitle = result;
      } catch {
        issueTitle = `Issue #${issueNumber}`;
      }
    } else if (!issueTitle) {
      issueTitle = `Issue #${issueNumber}`;
    }

    const { worktreeName, branchName } = this.deriveWorktreeNames(project, issueNumber);
    const blockedByJson = JSON.stringify(blockerNumbers);

    // Check for existing team
    const existing = db.getTeamByWorktree(worktreeName);
    if (existing) {
      if (['running', 'launching', 'idle', 'stuck', 'queued'].includes(existing.status)) {
        throw new Error(`Team already active for issue ${issueNumber} (status: ${existing.status})`);
      }
      if (existing.status === 'done') {
        throw new Error(`Team already completed for issue ${issueNumber} — completed teams cannot be relaunched`);
      }
      // Terminal state (failed) — reuse the existing team record as queued
      const now = new Date().toISOString();
      db.updateTeam(existing.id, {
        status: 'queued',
        phase: 'init',
        pid: null,
        sessionId: null,
        issueTitle: issueTitle ?? null,
        customPrompt: prompt ?? null,
        headless: headless !== false,
        blockedByJson,
        launchedAt: now,
        stoppedAt: null,
        lastEventAt: null,
      });
      db.insertTransition({
        teamId: existing.id,
        fromStatus: existing.status,
        toStatus: 'queued',
        trigger: 'pm_action',
        reason: `Queued with blockers: ${blockerNumbers.map(n => '#' + n).join(', ')}`,
      });
      const team = db.getTeam(existing.id)!;
      console.log(`[TeamManager] Team ${team.id} queued with blockers ${blockedByJson}`);
      this.broadcastSnapshot();
      return team;
    }

    // Fresh insert with queued status and blocker metadata
    const now = new Date().toISOString();
    const team = db.insertTeam({
      projectId,
      issueNumber,
      issueTitle: issueTitle ?? null,
      worktreeName,
      branchName,
      status: 'queued',
      phase: 'init',
      customPrompt: prompt ?? null,
      headless: headless !== false,
      blockedByJson,
      launchedAt: now,
    });
    db.insertTransition({
      teamId: team.id,
      fromStatus: 'queued',
      toStatus: 'queued',
      trigger: 'pm_action',
      reason: `Team created and queued with blockers: ${blockerNumbers.map(n => '#' + n).join(', ')}`,
    });

    console.log(`[TeamManager] Team ${team.id} queued with blockers ${blockedByJson}`);
    this.broadcastSnapshot();
    return team;
  }

  // -------------------------------------------------------------------------
  // forceLaunch — bypass usage gate and slot limits to launch a queued team
  // -------------------------------------------------------------------------

  async forceLaunch(teamId: number): Promise<Team> {
    const db = getDatabase();
    const team = db.getTeam(teamId);
    if (!team) {
      throw new Error(`Team ${teamId} not found`);
    }

    if (team.status !== 'queued') {
      throw new Error(`Team ${teamId} is not queued (current status: ${team.status})`);
    }

    const projectId = team.projectId;
    if (!projectId) {
      throw new Error(`Team ${teamId} has no project ID`);
    }

    const project = db.getProject(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    // Log a warning if this exceeds maxActiveTeams
    const activeCount = db.getActiveTeamCountByProject(projectId);
    if (activeCount >= project.maxActiveTeams) {
      console.warn(
        `[TeamManager] Force-launching team ${teamId} exceeds maxActiveTeams (${activeCount}/${project.maxActiveTeams})`,
      );
    }

    // Insert transition and update status BEFORE calling launchQueued,
    // since launchQueued's guard at the top accepts both 'queued' and 'launching'.
    db.insertTransition({
      teamId,
      fromStatus: 'queued',
      toStatus: 'launching',
      trigger: 'pm_action',
      reason: 'PM force-launched team',
    });
    db.updateTeam(teamId, { status: 'launching' });
    this.broadcastSnapshot();

    // Delegate to the existing private launch method
    await this.launchQueued(team);

    return db.getTeam(teamId)!;
  }

  // -------------------------------------------------------------------------
  // processQueue — dequeue and launch teams when slots free up
  // -------------------------------------------------------------------------

  async processQueue(projectId: number): Promise<void> {
    // Guard against concurrent processQueue calls for the same project
    if (this._processingQueue.has(projectId)) return;
    this._processingQueue.add(projectId);

    // Track whether any teams were actually launched — used by re-drain to
    // avoid an infinite loop when all queued teams are blocked by dependencies.
    let launchedCount = 0;

    try {
      const db = getDatabase();
      const project = db.getProject(projectId);
      if (!project) return;

      // Usage gate: do not dequeue if in red zone
      if (getUsageZone() === 'red') {
        console.log(`[TeamManager] processQueue blocked — usage zone is RED`);
        return;
      }

      const activeCount = db.getActiveTeamCountByProject(projectId);
      const available = project.maxActiveTeams - activeCount;
      if (available <= 0) return;

      const queued = db.getQueuedTeamsByProject(projectId);

      // Filter queued teams by dependency status — only launch unblocked teams
      const toDequeue = await this.filterUnblockedTeams(queued, available, projectId);
      launchedCount = toDequeue.length;

      for (const team of toDequeue) {
        console.log(`[TeamManager] Dequeuing team ${team.id} (${team.worktreeName})`);
        // Mark as launching BEFORE releasing the guard, so concurrent calls
        // see this team as active (counted towards the active limit).
        db.insertTransition({
          teamId: team.id,
          fromStatus: 'queued',
          toStatus: 'launching',
          trigger: 'system',
          reason: 'Slot available, dequeuing team',
        });
        db.updateTeam(team.id, { status: 'launching' });
        try {
          await this.launchQueued(team);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[TeamManager] Failed to dequeue team ${team.id}: ${msg}`);
        }
      }
    } finally {
      this._processingQueue.delete(projectId);

      // Re-drain: if a concurrent processQueue call was dropped by the guard
      // while we were awaiting launchQueued, there may still be queued teams
      // with available slots. Schedule a re-check via setImmediate to break
      // the call stack and let the new call acquire the guard cleanly.
      // Only re-drain if we actually launched at least one team — otherwise
      // all remaining queued teams are blocked by dependencies and re-draining
      // would cause an infinite loop.
      if (launchedCount > 0) {
        const db = getDatabase();
        const project = db.getProject(projectId);
        if (project) {
          const activeCount = db.getActiveTeamCountByProject(projectId);
          const queued = db.getQueuedTeamsByProject(projectId);
          if (queued.length > 0 && activeCount < project.maxActiveTeams) {
            setImmediate(() => {
              this.processQueue(projectId).catch((err) => {
                console.error(`[TeamManager] processQueue re-drain error:`, err);
              });
            });
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // filterUnblockedTeams — check dependencies for queued teams
  // -------------------------------------------------------------------------

  /**
   * Filter queued teams to only include those with no open dependencies.
   * Teams with open dependencies are logged and tracked in the GitHubPoller
   * for auto-launch when dependencies resolve.
   *
   * If a circular dependency is detected, the team is treated as unblocked
   * to avoid deadlocking the queue.
   *
   * Uses the IssueFetcher's cached data when available, falling back to
   * fresh API calls. If the dependency check fails entirely, the team is
   * treated as unblocked (permissive fallback).
   */
  private async filterUnblockedTeams(
    queued: Team[],
    available: number,
    projectId: number,
  ): Promise<Team[]> {
    const unblocked: Team[] = [];

    // Dynamic imports to avoid circular dependencies
    let getIssueFetcher: (() => import('./issue-fetcher.js').IssueFetcher) | null = null;
    let detectCircularDeps: ((n: number, deps: Map<number, number[]>) => number[] | null) | null = null;
    let githubPollerModule: typeof import('./github-poller.js') | null = null;

    try {
      const issueFetcherMod = await import('./issue-fetcher.js');
      getIssueFetcher = issueFetcherMod.getIssueFetcher;
      detectCircularDeps = issueFetcherMod.detectCircularDependencies;
    } catch (err) {
      console.error('[TeamManager] Failed to import issue-fetcher for dependency check:', err);
      // Permissive fallback: if we can't check deps, allow all queued teams
      return queued.slice(0, available);
    }

    try {
      githubPollerModule = await import('./github-poller.js');
    } catch (err) {
      console.error('[TeamManager] Failed to import github-poller for blocked tracking:', err);
    }

    const fetcher = getIssueFetcher();

    for (const team of queued) {
      if (unblocked.length >= available) break;

      try {
        const deps = await fetcher.fetchDependenciesForIssue(projectId, team.issueNumber);

        // Permissive fallback: if fetch returns null, treat as unblocked
        if (!deps || deps.resolved) {
          unblocked.push(team);
          continue;
        }

        // Has open dependencies — check for circular dependencies
        const openDeps = deps.blockedBy.filter((d) => d.state === 'open');

        if (detectCircularDeps && openDeps.length > 0) {
          // Build a local dependency graph for cycle detection
          const depGraph = new Map<number, number[]>();
          depGraph.set(team.issueNumber, openDeps.map((d) => d.number));

          // Add the open deps' own dependencies (if we can fetch them)
          for (const dep of openDeps) {
            try {
              const subDeps = await fetcher.fetchDependenciesForIssue(projectId, dep.number);
              if (subDeps && subDeps.blockedBy.length > 0) {
                depGraph.set(dep.number, subDeps.blockedBy.filter((d) => d.state === 'open').map((d) => d.number));
              }
            } catch {
              // Can't fetch sub-deps — skip (cycle detection will still work for direct cycles)
            }
          }

          const cycle = detectCircularDeps(team.issueNumber, depGraph);
          if (cycle) {
            console.warn(
              `[TeamManager] Circular dependency detected for team ${team.id} (issue #${team.issueNumber}): ` +
              `${cycle.map((n) => '#' + n).join(' -> ')} — treating as unblocked to avoid deadlock`
            );
            unblocked.push(team);
            continue;
          }
        }

        // Genuinely blocked — log and track for auto-launch on resolution
        console.log(
          `[TeamManager] Skipping team ${team.id} (issue #${team.issueNumber}) — ` +
          `blocked by open deps: ${openDeps.map((d) => '#' + d.number).join(', ')}`
        );

        if (githubPollerModule) {
          githubPollerModule.githubPoller.trackBlockedIssue(
            projectId,
            team.issueNumber,
            openDeps.map((d) => d.number),
          );
        }
      } catch (err) {
        // Permissive fallback: if dependency check fails, allow the team to launch
        console.error(
          `[TeamManager] Dependency check failed for team ${team.id} (issue #${team.issueNumber}), ` +
          `allowing launch: ${err instanceof Error ? err.message : String(err)}`
        );
        unblocked.push(team);
      }
    }

    return unblocked;
  }

  // -------------------------------------------------------------------------
  // launchQueued — spawn a team that was previously queued
  // -------------------------------------------------------------------------

  private async launchQueued(team: Team): Promise<void> {
    const db = getDatabase();

    // Re-check status to avoid racing with other dequeue calls
    // processQueue pre-sets status to 'launching' before calling us,
    // so we must accept both 'queued' and 'launching'.
    const fresh = db.getTeam(team.id);
    if (!fresh || (fresh.status !== 'queued' && fresh.status !== 'launching')) return;

    const projectId = team.projectId;
    if (!projectId) {
      console.error(`[TeamManager] Queued team ${team.id} has no projectId`);
      return;
    }

    const project = db.getProject(projectId);
    if (!project) {
      console.error(`[TeamManager] Project ${projectId} not found for queued team ${team.id}`);
      return;
    }

    const worktreeAbsPath = path.join(project.repoPath, config.worktreeDir, team.worktreeName);
    const worktreeRelPath = path.posix.join(config.worktreeDir, team.worktreeName);
    const branchName = team.branchName ?? `worktree-${team.worktreeName}`;

    // Sync with origin before creating worktree
    await this.syncWithOrigin(project.repoPath, team.id);

    // ── Step 1: Create git worktree ──
    const worktreeOk = await this.createWorktree(
      project.repoPath, worktreeRelPath, worktreeAbsPath, branchName, team.id, 'launching',
    );
    if (!worktreeOk) return;

    console.log(`[TeamManager] Worktree created for dequeued team: ${team.worktreeName}`);

    // Clear blocker metadata now that the team is being launched
    db.updateTeam(team.id, { status: 'launching', blockedByJson: null });
    this.broadcastSnapshot();

    // ── Step 2: Copy hooks and settings ──
    this.copyFCFiles(worktreeAbsPath);

    // ── Step 3: Spawn Claude Code ──
    const resolvedPrompt = team.customPrompt || this.resolvePromptFromFile(project, team.issueNumber);
    const isHeadless = team.headless;

    if (!isHeadless && process.platform === 'win32') {
      // ── Interactive mode (Windows): open Claude Code in a new terminal ──
      await this.launchInteractive(team, project, worktreeAbsPath, resolvedPrompt);
      return;
    }

    // ── Headless mode (default): spawn in background, capture output ──
    const child = spawnHeadless({
      mode: 'headless',
      worktreeName: team.worktreeName,
      cwd: project.repoPath,
      model: project.model,
      resume: false,
      fleetContext: { teamId: team.worktreeName, projectId, githubRepo: project.githubRepo ?? '' },
    });

    const pid = child.pid;
    if (pid === undefined) {
      console.error(`[TeamManager] ERROR: spawn failed for dequeued team ${team.id}: no PID returned`);
      db.insertTransition({
        teamId: team.id,
        fromStatus: 'launching',
        toStatus: 'failed',
        trigger: 'system',
        reason: 'Spawn failed: no PID returned',
      });
      db.updateTeam(team.id, { status: 'failed', stoppedAt: new Date().toISOString() });
      this.broadcastSnapshot();
      return;
    }

    console.log(`[TeamManager] Dequeued team ${team.id} spawned: PID ${pid} (headless=${isHeadless})`);
    db.updateTeam(team.id, { pid });
    this.broadcastSnapshot();
    this.childProcesses.set(team.id, child);

    this.setupStdinAndOutput(team.id, child, resolvedPrompt);
    this.attachProcessHandlers(team.id, child);

    sseBroker.broadcast(
      'team_launched',
      { team_id: team.id, issue_number: team.issueNumber, project_id: projectId },
      team.id,
    );
  }

  // -------------------------------------------------------------------------
  // getOutput — return rolling buffer content
  // -------------------------------------------------------------------------

  getOutput(teamId: number, lines?: number): string[] {
    const buffer = this.outputBuffers.get(teamId);
    if (!buffer) {
      return [];
    }

    if (lines && lines > 0 && lines < buffer.length) {
      return buffer.last(lines);
    }

    return buffer.toArray();
  }

  // -------------------------------------------------------------------------
  // getParsedEvents — return parsed NDJSON stream events
  // -------------------------------------------------------------------------

  getParsedEvents(teamId: number): StreamEvent[] {
    // Check in-memory buffer first (for running teams)
    const inMemory = this.parsedEvents.get(teamId);
    if (inMemory && inMemory.length > 0) {
      return inMemory;
    }

    // Fall back to persisted events in DB (for done/failed/restarted teams)
    try {
      const db = getDatabase();
      const json = db.getStreamEvents(teamId);
      if (json) {
        return JSON.parse(json) as StreamEvent[];
      }
    } catch (err) {
      console.error(`[TeamManager] Failed to load persisted stream events for team ${teamId}:`, err);
    }

    return [];
  }

  // -------------------------------------------------------------------------
  // Stdout activity tracking (hook fallback for #446)
  // -------------------------------------------------------------------------

  /**
   * Return the timestamp of the last meaningful stdout stream event for a team.
   * Used by stuck-detector as a fallback when hook events are missing.
   */
  getLastStreamAt(teamId: number): number | undefined {
    return this.lastStreamAt.get(teamId);
  }

  /**
   * Sync stdout activity timestamps to the DB's last_event_at column.
   * Called periodically by stuck-detector before evaluating teams.
   * Only updates when stdout activity is more recent than the existing value.
   */
  syncStreamActivityToDb(): void {
    const db = getDatabase();
    for (const [teamId, lastTs] of this.lastStreamAt) {
      const team = db.getTeam(teamId);
      if (!team || ['done', 'failed'].includes(team.status)) continue;
      const lastEventMs = team.lastEventAt ? new Date(team.lastEventAt).getTime() : 0;
      if (lastTs > lastEventMs) {
        db.updateTeam(teamId, { lastEventAt: new Date(lastTs).toISOString() });
      }
    }
  }

  /**
   * Persist the in-memory parsed events for a team to the database.
   * Called before clearing the in-memory buffer on process exit/stop.
   */
  private persistParsedEvents(teamId: number): void {
    const events = this.parsedEvents.get(teamId);
    if (!events || events.length === 0) return;

    try {
      const db = getDatabase();
      db.upsertStreamEvents(teamId, JSON.stringify(events));
    } catch (err) {
      console.error(`[TeamManager] Failed to persist stream events for team ${teamId}:`, err);
    }
  }

  // -------------------------------------------------------------------------
  // sendMessage — deliver a PM message to a running team via stdin
  // -------------------------------------------------------------------------

  sendMessage(teamId: number, message: string, source: 'user' | 'fc' = 'fc', subtype?: string): boolean {
    const stdin = this.stdinPipes.get(teamId);
    if (!stdin || stdin.destroyed) return false;

    try {
      this.writeStdinMessage(stdin, message);
      console.log(`[TeamManager] Message sent to team ${teamId}: ${message.substring(0, 100)}`);

      // Inject a synthetic event into parsedEvents so it appears in the
      // Session Log alongside assistant responses (issue #5).
      // 'user' = manual PM message, 'fc' = automated Fleet Commander message.
      // 'subtype' distinguishes FC message categories for visual differentiation.
      const syntheticEvent: StreamEvent = {
        type: source,
        agentName: source === 'user' ? '__pm__' : '__fc__',
        timestamp: new Date().toISOString(),
        message: { content: [{ type: 'text', text: message }] },
        ...(subtype ? { subtype } : {}),
      };
      const events = this.parsedEvents.get(teamId);
      if (events) {
        events.push(syntheticEvent);
        while (events.length > MAX_PARSED_EVENTS) {
          events.shift();
        }
      }
      sseBroker.broadcast('team_output', { team_id: teamId, event: syntheticEvent }, teamId);

      return true;
    } catch (err) {
      console.error(`[TeamManager] Failed to send message to team ${teamId}:`, err);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // getStdinPipe — expose stdin pipe for external graceful shutdown
  // -------------------------------------------------------------------------

  getStdinPipe(teamId: number): Writable | undefined {
    return this.stdinPipes.get(teamId);
  }

  // -------------------------------------------------------------------------
  // gracefulShutdown — notify TL of merge, wait grace period, then kill
  // -------------------------------------------------------------------------

  /**
   * Gracefully shut down a team after its PR is merged.
   * 1. Send pr_merged_shutdown message to TL via stdin
   * 2. Wait graceMs for the process to exit on its own
   * 3. If still alive: close stdin, wait 10s, then force kill
   *
   * Race-condition safe: the process exit handler already does cleanup,
   * so all timer callbacks re-check childProcesses.has() before acting.
   */
  gracefulShutdown(teamId: number, prNumber: number, graceMs: number): void {
    // Clear any existing shutdown timer for this team
    const existing = this.shutdownTimers.get(teamId);
    if (existing) {
      clearTimeout(existing);
      this.shutdownTimers.delete(teamId);
    }

    // Step 1: Send the shutdown message via stdin
    const msg = resolveMessage('pr_merged_shutdown', {
      PR_NUMBER: String(prNumber),
    });
    if (msg) {
      this.sendMessage(teamId, msg, 'fc', 'pr_merged_shutdown');
    }
    console.log(`[TeamManager] Graceful shutdown initiated for team ${teamId} (PR #${prNumber}, grace=${graceMs}ms)`);

    // Step 2: Set grace period timer
    const graceTimer = setTimeout(() => {
      this.shutdownTimers.delete(teamId);

      // Re-check: process may have exited during grace period
      if (!this.childProcesses.has(teamId)) {
        console.log(`[TeamManager] Team ${teamId} already exited during grace period`);
        return;
      }

      console.log(`[TeamManager] Grace period expired for team ${teamId} — closing stdin`);

      // Step 3: Close stdin to signal CC to finish
      const stdin = this.stdinPipes.get(teamId);
      if (stdin && !stdin.destroyed) {
        try {
          stdin.end();
        } catch {
          // stdin.end() failed — proceed to force kill
        }
      }
      this.stdinPipes.delete(teamId);

      // Step 4: Wait 10s then force kill if still alive
      const killTimer = setTimeout(() => {
        if (!this.childProcesses.has(teamId)) {
          console.log(`[TeamManager] Team ${teamId} exited after stdin close`);
          return;
        }

        console.log(`[TeamManager] Force-killing team ${teamId} after merge shutdown`);
        const db = getDatabase();
        const team = db.getTeam(teamId);
        if (team?.pid) {
          this.killProcess(team.pid);
        }

        // Clean up maps — the exit handler may also fire, but
        // purgeTeamMaps is idempotent
        this.flushTokenCounters(teamId);
        this.persistParsedEvents(teamId);
        this.purgeTeamMaps(teamId);

        // Set stoppedAt and broadcast
        if (team && !team.stoppedAt) {
          db.updateTeam(teamId, {
            pid: null,
            stoppedAt: new Date().toISOString(),
          });
        }
        sseBroker.broadcast('team_stopped', { team_id: teamId }, teamId);
      }, 10_000);
      if (killTimer.unref) killTimer.unref();
    }, graceMs);

    if (graceTimer.unref) graceTimer.unref();
    this.shutdownTimers.set(teamId, graceTimer);
  }

  /**
   * Clear all active shutdown timers. Called during server shutdown
   * to prevent dangling timers.
   */
  clearShutdownTimers(): void {
    for (const [teamId, timer] of this.shutdownTimers) {
      clearTimeout(timer);
    }
    this.shutdownTimers.clear();
  }

  // -------------------------------------------------------------------------
  // writeStdinMessage — low-level: write an SDKUserMessage JSON line to stdin
  // -------------------------------------------------------------------------

  private writeStdinMessage(stdin: Writable, content: string): void {
    const msg = {
      type: 'user',
      session_id: '',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    };
    stdin.write(JSON.stringify(msg) + '\n');
  }

  // -------------------------------------------------------------------------
  // resolvePromptFromFile — read prompt from project's prompt file on disk
  // -------------------------------------------------------------------------

  /**
   * Read the project's prompt file and replace {{ISSUE_NUMBER}} placeholder.
   * Fallback chain: project prompt file > prompts/default-prompt.md > hardcoded default.
   */
  private resolvePromptFromFile(project: Project, issueNumber: number): string {
    if (project.promptFile) {
      const absPath = path.join(config.fleetCommanderRoot, project.promptFile);
      if (fs.existsSync(absPath)) {
        try {
          const template = fs.readFileSync(absPath, 'utf-8');
          const resolved = template.replace(/\{\{ISSUE_NUMBER\}\}/g, String(issueNumber));
          console.log(`[TeamManager] Resolved prompt from file: ${project.promptFile}`);
          return resolved;
        } catch (err: unknown) {
          console.warn(`[TeamManager] Failed to read prompt file ${absPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        console.warn(`[TeamManager] Prompt file not found: ${absPath}`);
      }
    }

    // Fall back to default-prompt.md
    const defaultPath = path.join(config.fleetCommanderRoot, 'prompts', 'default-prompt.md');
    if (fs.existsSync(defaultPath)) {
      try {
        const template = fs.readFileSync(defaultPath, 'utf-8');
        const resolved = template.replace(/\{\{ISSUE_NUMBER\}\}/g, String(issueNumber));
        console.log(`[TeamManager] Resolved prompt from default: prompts/default-prompt.md`);
        return resolved;
      } catch {
        // Fall through to hardcoded fallback
      }
    }

    // Hardcoded fallback (should not normally be reached)
    const fallback = `Read the ENTIRE file .claude/prompts/fleet-workflow.md before taking any actions.\nYou are the TL. There is NO coordinator — you orchestrate the Diamond team directly.\nPhase 0: Spawn fleet-planner. Wait for plan. Phase 1: Spawn fleet-dev WITH the planner's plan. Wait for ready. Phase 2: Spawn fleet-reviewer. Dev and reviewer communicate p2p. Planner stays alive for p2p questions.\nIssue: #${issueNumber}`;
    console.log(`[TeamManager] Using hardcoded fallback prompt`);
    return fallback;
  }

  // -------------------------------------------------------------------------
  // launchBatch — launch multiple teams with optional stagger delay
  // -------------------------------------------------------------------------

  async launchBatch(
    projectId: number,
    issues: Array<{ number: number; title?: string }>,
    prompt?: string,
    delayMs?: number,
    headless?: boolean,
  ): Promise<Team[]> {
    const results: Team[] = [];
    const delay = delayMs ?? 2000; // default 2-second stagger

    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i]!;
      try {
        const team = await this.launch(projectId, issue.number, issue.title, prompt, headless);
        results.push(team);
      } catch (err: unknown) {
        // Log error and continue — don't stop the batch
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[TeamManager] Batch launch failed at issue #${issue.number} (${i + 1}/${issues.length}): ${msg}`,
        );
      }

      // Stagger delay between launches (skip after last)
      if (i < issues.length - 1 && delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    return results;
  }

  /**
   * Launch a Claude Code process in interactive mode (Windows terminal).
   * Delegates to the unified cc-spawn module which writes a temp .cmd
   * launcher file, eliminating cmd.exe quoting issues with prompt text.
   */
  private async launchInteractive(
    team: Team,
    project: Project,
    worktreeAbsPath: string,
    prompt: string,
  ): Promise<void> {
    const db = getDatabase();

    await spawnInteractive({
      mode: 'interactive',
      worktreeName: team.worktreeName,
      cwd: worktreeAbsPath,
      model: project.model,
      prompt,
      windowTitle: `Team ${team.worktreeName}`,
      fleetContext: { teamId: team.worktreeName, projectId: team.projectId!, githubRepo: project.githubRepo ?? '' },
    });

    console.log(`[TeamManager] Interactive window opened for team ${team.id} (worktree: ${team.worktreeName})`);

    db.insertTransition({
      teamId: team.id,
      fromStatus: 'launching',
      toStatus: 'running',
      trigger: 'system',
      reason: 'Interactive terminal window opened',
    });
    db.updateTeam(team.id, { status: 'running' });
    this.broadcastSnapshot();

    sseBroker.broadcast(
      'team_launched',
      { team_id: team.id, issue_number: team.issueNumber, project_id: team.projectId! },
      team.id,
    );
  }

  /**
   * Attach exit and error handlers to a child process.
   * These handlers clean up maps, transition the team to done/failed,
   * broadcast SSE events, and trigger queue processing.
   */
  private attachProcessHandlers(teamId: number, child: ChildProcess): void {
    const db = getDatabase();

    child.on('exit', (code, signal) => {
      console.log(`[TeamManager] Process exited for team ${teamId} (code=${code}, signal=${signal})`);
      this.flushTokenCounters(teamId);
      this.persistParsedEvents(teamId);
      this.purgeTeamMaps(teamId);

      const currentTeam = db.getTeam(teamId);
      if (!currentTeam) return;

      if (['launching', 'running', 'idle', 'stuck'].includes(currentTeam.status)) {
        const exitStatus = (code === 0) ? 'done' : 'failed';
        db.insertTransition({
          teamId,
          fromStatus: currentTeam.status,
          toStatus: exitStatus,
          trigger: 'system',
          reason: code === 0
            ? 'Process exited normally (code 0)'
            : `Process exited with code ${code}${signal ? `, signal ${signal}` : ''}`,
        });
        db.updateTeam(teamId, {
          status: exitStatus,
          pid: null,
          stoppedAt: new Date().toISOString(),
        });

        sseBroker.broadcast('team_stopped', { team_id: teamId }, teamId);
        this.broadcastSnapshot();
      }

      if (currentTeam.projectId) {
        this.processQueue(currentTeam.projectId).catch((err) => {
          console.error(`[TeamManager] processQueue error after team exit:`, err);
        });
      }
    });

    child.on('error', (err) => {
      console.error(`[TeamManager] ERROR: process error for team ${teamId}:`, err.message);
      this.flushTokenCounters(teamId);
      this.persistParsedEvents(teamId);
      this.purgeTeamMaps(teamId);

      const currentTeam = db.getTeam(teamId);
      if (!currentTeam) return;

      if (['launching', 'running', 'idle', 'stuck'].includes(currentTeam.status)) {
        db.insertTransition({
          teamId,
          fromStatus: currentTeam.status,
          toStatus: 'failed',
          trigger: 'system',
          reason: `Process error: ${err.message.slice(0, 200)}`,
        });
        db.updateTeam(teamId, {
          status: 'failed',
          pid: null,
          stoppedAt: new Date().toISOString(),
        });

        sseBroker.broadcast('team_stopped', { team_id: teamId }, teamId);
        this.broadcastSnapshot();
      }

      if (currentTeam.projectId) {
        this.processQueue(currentTeam.projectId).catch((queueErr) => {
          console.error(`[TeamManager] processQueue error after team error:`, queueErr);
        });
      }
    });
  }

  /**
   * Store the stdin pipe, send the initial prompt (if provided), set up
   * output capture, and broadcast the initial FC event in the session log.
   */
  private setupStdinAndOutput(
    teamId: number,
    child: ChildProcess,
    prompt?: string,
  ): void {
    if (child.stdin) {
      this.stdinPipes.set(teamId, child.stdin);

      if (prompt) {
        this.writeStdinMessage(child.stdin, prompt);
        console.log(`[TeamManager] Initial prompt sent via stdin for team ${teamId}`);
      }
    }

    this.initOutputBuffer(teamId);
    this.captureOutput(teamId, child);

    if (prompt && child.stdin) {
      const initEvent: StreamEvent = {
        type: 'fc',
        subtype: 'initial_prompt',
        agentName: '__fc__',
        timestamp: new Date().toISOString(),
        message: { content: [{ type: 'text', text: prompt }] },
      };
      const evts = this.parsedEvents.get(teamId);
      if (evts) evts.push(initEvent);
      sseBroker.broadcast('team_output', { team_id: teamId, event: initEvent }, teamId);
    }
  }

  /**
   * Create a git worktree with -b fallback. On failure, transitions team
   * to 'failed' and broadcasts snapshot.
   * Returns true on success, false on failure.
   */
  private async createWorktree(
    repoPath: string,
    worktreeRelPath: string,
    worktreeAbsPath: string,
    branchName: string,
    teamId: number,
    fromStatus: 'queued' | 'launching',
  ): Promise<boolean> {
    if (fs.existsSync(worktreeAbsPath)) return true;

    try {
      await execAsync(
        `git -C "${repoPath}" worktree add "${worktreeRelPath}" -b "${branchName}"`,
      );
      return true;
    } catch {
      // Branch may already exist — try without -b
      try {
        await execAsync(
          `git -C "${repoPath}" worktree add "${worktreeRelPath}" "${branchName}"`,
        );
        return true;
      } catch (err2: unknown) {
        const msg = err2 instanceof Error ? err2.message : String(err2);
        console.error(`[TeamManager] ERROR: Worktree creation failed for team ${teamId}: ${msg}`);
        const db = getDatabase();
        db.insertTransition({
          teamId,
          fromStatus,
          toStatus: 'failed',
          trigger: 'system',
          reason: `Worktree creation failed: ${msg.slice(0, 200)}`,
        });
        db.updateTeam(teamId, { status: 'failed', stoppedAt: new Date().toISOString() });
        this.broadcastSnapshot();
        return false;
      }
    }
  }

  /**
   * Copy all FC-managed files into a worktree directory:
   * hooks, settings.json, agents, guides, and workflow prompt.
   * Uses the fc-manifest module as single source of truth for file lists.
   */
  private copyFCFiles(worktreeAbsPath: string): void {
    const claudeDir = path.join(worktreeAbsPath, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    // ── 1. Copy hook scripts ──
    const hookSrcDir = config.fcHooksDir;
    const hookDestDir = path.join(worktreeAbsPath, config.hookDir);
    fs.mkdirSync(hookDestDir, { recursive: true });

    if (fs.existsSync(hookSrcDir)) {
      const hookFiles = getManifestHookFiles();
      for (const file of hookFiles) {
        const src = path.join(hookSrcDir, file);
        if (!fs.existsSync(src)) continue;
        const dest = path.join(hookDestDir, file);
        fs.copyFileSync(src, dest);
        if (process.platform !== 'win32') {
          fs.chmodSync(dest, 0o755);
        }
      }
    }

    // ── 2. Generate settings.json from example ──
    const settingsExamplePath = path.join(hookSrcDir, 'settings.json.example');
    const settingsDestPath = path.join(claudeDir, 'settings.json');
    if (fs.existsSync(settingsExamplePath)) {
      fs.copyFileSync(settingsExamplePath, settingsDestPath);
    }

    // ── 3. Copy agent templates ──
    const agentsSrcDir = config.fcAgentsDir;
    const agentsDestDir = path.join(claudeDir, 'agents');
    if (fs.existsSync(agentsSrcDir)) {
      fs.mkdirSync(agentsDestDir, { recursive: true });
      const agentFiles = getManifestAgentFiles();
      for (const file of agentFiles) {
        const src = path.join(agentsSrcDir, file);
        if (!fs.existsSync(src)) continue;
        const dest = path.join(agentsDestDir, file);
        fs.copyFileSync(src, dest);
      }
    }

    // ── 4. Copy guide templates ──
    const guidesSrcDir = config.fcGuidesDir;
    const guidesDestDir = path.join(claudeDir, 'guides');
    if (fs.existsSync(guidesSrcDir)) {
      fs.mkdirSync(guidesDestDir, { recursive: true });
      const guideFiles = getManifestGuideFiles();
      for (const file of guideFiles) {
        const src = path.join(guidesSrcDir, file);
        if (!fs.existsSync(src)) continue;
        const dest = path.join(guidesDestDir, file);
        fs.copyFileSync(src, dest);
      }
    }

    // ── 5. Copy workflow prompt ──
    const workflowSrc = config.fcWorkflowTemplate;
    const promptsDestDir = path.join(claudeDir, 'prompts');
    if (fs.existsSync(workflowSrc)) {
      fs.mkdirSync(promptsDestDir, { recursive: true });
      const workflowDest = path.join(promptsDestDir, getWorkflowFile());
      fs.copyFileSync(workflowSrc, workflowDest);
    }

    // ── 6. Ensure plan.md and review.md are gitignored ──
    const gitignorePath = path.join(worktreeAbsPath, '.gitignore');
    let gitignoreContent = '';
    if (fs.existsSync(gitignorePath)) {
      gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
    }
    const lines = gitignoreContent.split('\n').map(l => l.trim());
    const toAdd: string[] = [];
    if (!lines.includes('plan.md')) toAdd.push('plan.md');
    if (!lines.includes('review.md')) toAdd.push('review.md');
    if (toAdd.length > 0) {
      const suffix = gitignoreContent.length > 0 && !gitignoreContent.endsWith('\n') ? '\n' : '';
      fs.writeFileSync(gitignorePath, gitignoreContent + suffix + toAdd.join('\n') + '\n', 'utf-8');
    }

    console.log(`[TeamManager] FC files copied to worktree (hooks, settings, agents, guides, prompt)`);
  }

  /**
   * Derive worktree naming from a project and issue number.
   */
  private deriveWorktreeNames(project: Project, issueNumber: number): {
    slug: string;
    worktreeName: string;
    branchName: string;
    worktreeRelPath: string;
    worktreeAbsPath: string;
  } {
    const slug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const worktreeName = `${slug}-${issueNumber}`;
    const branchName = `worktree-${slug}-${issueNumber}`;
    const worktreeRelPath = path.posix.join(config.worktreeDir, worktreeName);
    const worktreeAbsPath = path.join(project.repoPath, config.worktreeDir, worktreeName);
    return { slug, worktreeName, branchName, worktreeRelPath, worktreeAbsPath };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Broadcast a full team dashboard snapshot to all SSE clients.
   * Called after any team state change so the Fleet Grid refreshes.
   */
  private broadcastSnapshot(): void {
    try {
      const db = getDatabase();
      const dashboard = db.getTeamDashboard();
      sseBroker.broadcast('snapshot', { teams: dashboard });
    } catch (err) {
      console.error('[TeamManager] Failed to broadcast snapshot:', err);
    }
  }

  private initOutputBuffer(teamId: number): void {
    this.outputBuffers.set(teamId, new CircularBuffer<string>(MAX_OUTPUT_LINES));
  }

  private captureOutput(teamId: number, child: ChildProcess): void {
    const buffer = this.outputBuffers.get(teamId);
    if (!buffer) return;

    // Resolve the worktree name for log prefixes
    const db = getDatabase();
    const team = db.getTeam(teamId);
    const logPrefix = team ? team.worktreeName : `team-${teamId}`;

    // Initialize parsed events buffer for this team
    if (!this.parsedEvents.has(teamId)) {
      this.parsedEvents.set(teamId, []);
    }
    const events = this.parsedEvents.get(teamId)!;

    // Initialize agent map for tracking tool_use_id -> agent name
    if (!this.agentMaps.has(teamId)) {
      this.agentMaps.set(teamId, new Map());
    }
    const agentMap = this.agentMaps.get(teamId)!;

    // Initialize token counter (seed from DB for restarts)
    if (!this.tokenCounters.has(teamId)) {
      const existingTeam = db.getTeam(teamId);
      this.tokenCounters.set(teamId, {
        inputTokens: existingTeam?.totalInputTokens ?? 0,
        outputTokens: existingTeam?.totalOutputTokens ?? 0,
        cacheCreationTokens: existingTeam?.totalCacheCreationTokens ?? 0,
        cacheReadTokens: existingTeam?.totalCacheReadTokens ?? 0,
        costUsd: existingTeam?.totalCostUsd ?? 0,
      });
    }

    // Partial line buffer for handling chunks that split across data events
    let stdoutPartial = '';

    // stdout: NDJSON from --output-format stream-json
    if (child.stdout) {
      child.stdout.on('data', (data: Buffer) => {
        const text = stdoutPartial + data.toString('utf-8');
        const lines = text.split('\n');

        // Last element may be incomplete — save it for next chunk
        stdoutPartial = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // Store raw line in output buffer (O(1) circular overwrite)
          buffer.push(line);

          // Try to parse as JSON (NDJSON from stream-json output)
          try {
            const event: StreamEvent = JSON.parse(trimmed);
            console.log(`[CC:${logPrefix}] ${event.type}: ${summarizeEvent(event)}`);

            // Skip CC-echoed "user" events — sendMessage() and
            // setupStdinAndOutput() already inject properly-labeled
            // synthetic events (type 'user' or 'fc') into parsedEvents.
            // The CC echo is redundant and would misattribute automated
            // FC messages as PM ("You") messages in the Session Log.
            if (event.type === 'user') continue;

            // Detect thinking start/stop from content_block_start/stop events
            // (must run before the buffer-skip below so thinking state is tracked)
            this.detectThinking(teamId, event);

            // content_block_start/delta/stop events are high-frequency partial
            // message fragments emitted by --include-partial-messages.  They are
            // only needed for thinking detection (above) and must NOT be stored
            // in the parsedEvents buffer — they would flood the event cap
            // and evict meaningful session log entries.
            if (event.type === 'content_block_start' || event.type === 'content_block_delta' || event.type === 'content_block_stop' || event.type === 'stream_event') {
              continue;
            }

            // ----- Agent name resolution -----
            // 1. Learn agent names: when the TL's assistant event contains
            //    a tool_use content block for "Agent" or "Task", record the
            //    mapping from tool_use_id -> agent name.
            const ev = event as Record<string, unknown>;
            if (event.type === 'assistant') {
              const msg = ev.message as Record<string, unknown> | undefined;
              const content = msg?.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (
                    block &&
                    typeof block === 'object' &&
                    (block as Record<string, unknown>).type === 'tool_use'
                  ) {
                    const toolBlock = block as Record<string, unknown>;
                    const toolName = toolBlock.name as string | undefined;
                    const toolId = toolBlock.id as string | undefined;
                    if (toolId && (toolName === 'Agent' || toolName === 'Task' || toolName === 'dispatch_agent')) {
                      const input = toolBlock.input as Record<string, unknown> | undefined;
                      const agentName = (input?.agent_name ?? input?.name ?? 'subagent') as string;
                      agentMap.set(toolId, agentName.toLowerCase());
                    }

                    // Stdout fallback: extract tasks from TodoWrite tool_use blocks
                    if (toolName === 'TodoWrite') {
                      try {
                        const input = toolBlock.input as Record<string, unknown> | undefined;
                        const todos = input?.todos as Array<Record<string, unknown>> | undefined;
                        if (Array.isArray(todos)) {
                          const db = getDatabase();
                          for (const todo of todos) {
                            const taskId = (todo.id ?? `stdout-${toolId}-${todos.indexOf(todo)}`) as string;
                            const subject = (todo.content ?? todo.title ?? todo.subject ?? 'Untitled task') as string;
                            const status = (todo.status ?? 'pending') as string;
                            // Derive owner from parent_tool_use_id if available
                            const parentId = (ev.parent_tool_use_id as string | null | undefined) ?? null;
                            const owner = parentId ? (agentMap.get(parentId) ?? 'team-lead') : 'team-lead';

                            const task = db.upsertTeamTask({
                              teamId,
                              taskId,
                              subject,
                              status,
                              owner,
                            });
                            sseBroker.broadcast('task_updated', {
                              team_id: teamId,
                              task_id: task.taskId,
                              subject: task.subject,
                              status: task.status,
                              owner: task.owner,
                            }, teamId);
                          }
                        }
                      } catch {
                        // Non-critical — task extraction failure should not break stream parsing
                      }
                    }
                  }
                }
              }
            }

            // 2. Resolve the agent name for this event
            const parentToolUseId = (ev.parent_tool_use_id as string | null | undefined) ?? null;
            let resolvedAgentName: string;
            if (event.type === 'user' || event.type === 'fc') {
              resolvedAgentName = 'team-lead';
            } else if (parentToolUseId) {
              resolvedAgentName = agentMap.get(parentToolUseId) ?? 'subagent';
            } else {
              resolvedAgentName = 'team-lead';
            }

            // 3. Extract description and lastToolName from system/task_progress
            let description: string | undefined;
            let lastToolName: string | undefined;
            if (event.type === 'system') {
              const subtype = ev.subtype as string | undefined;
              if (subtype === 'task_progress' || subtype === 'task_notification') {
                description = (ev.description as string | undefined) ?? undefined;
                lastToolName = (ev.last_tool_name as string | undefined) ??
                  (ev.tool_name as string | undefined) ?? undefined;
                // system task events may carry a tool_use_id referencing the parent agent
                const sysToolUseId = ev.tool_use_id as string | undefined;
                if (sysToolUseId && agentMap.has(sysToolUseId)) {
                  resolvedAgentName = agentMap.get(sysToolUseId)!;
                }
              }
            }

            // Store parsed event with timestamp + agent attribution
            const timestampedEvent: StreamEvent = {
              ...event,
              timestamp: new Date().toISOString(),
              agentName: resolvedAgentName,
              ...(description ? { description } : {}),
              ...(lastToolName ? { lastToolName } : {}),
            };
            events.push(timestampedEvent);
            if (events.length > MAX_PARSED_EVENTS) {
              events.shift();
            }

            // Accumulate token counts from assistant events
            this.accumulateTokens(teamId, event);

            // Broadcast interesting events via SSE
            // Include 'system' for task_progress/task_notification visibility
            if (['assistant', 'tool_use', 'tool_result', 'result', 'system'].includes(event.type)) {
              sseBroker.broadcast('team_output', {
                team_id: teamId,
                event: timestampedEvent,
              }, teamId);
            }

            // Track stdout activity for hook fallback (#446)
            if (['assistant', 'tool_use', 'tool_result', 'system'].includes(event.type)) {
              this.lastStreamAt.set(teamId, Date.now());

              // Fallback: transition launching→running from stdout when hooks don't fire
              try {
                const db = getDatabase();
                const team = db.getTeam(teamId);
                if (team && team.status === 'launching') {
                  db.insertTransition({
                    teamId,
                    fromStatus: 'launching',
                    toStatus: 'running',
                    trigger: 'system',
                    reason: 'Stdout stream event received (hook fallback)',
                  });
                  db.updateTeam(teamId, { status: 'running', lastEventAt: new Date().toISOString() });
                  sseBroker.broadcast('team_status_changed', {
                    team_id: teamId,
                    status: 'running',
                    previous_status: 'launching',
                    reason: 'Stdout stream event received (hook fallback)',
                  });
                  console.log(`[TeamManager] Team ${teamId} transitioned launching→running via stdout fallback`);
                }
              } catch (err) {
                console.error(`[TeamManager] Stdout fallback transition failed for team ${teamId}:`, err);
              }

              // Phase fallback: advance phase from task_notification/task_progress
              // when the resolved agent is not team-lead. This supplements hook-based
              // phase tracking for cases where hooks don't fire.
              if (event.type === 'system' && resolvedAgentName !== 'team-lead') {
                try {
                  const role = classifyAgentRole(resolvedAgentName);
                  if (role) {
                    const db = getDatabase();
                    const currentTeam = db.getTeam(teamId);
                    if (currentTeam) {
                      let targetPhase: TeamPhase | undefined;
                      if (role === 'planner') targetPhase = 'analyzing';
                      else if (role === 'dev') targetPhase = 'implementing';
                      else if (role === 'reviewer') targetPhase = 'reviewing';

                      if (targetPhase && shouldAdvancePhase(currentTeam.phase, targetPhase)) {
                        const prevPhase = currentTeam.phase;
                        db.updateTeam(teamId, { phase: targetPhase });
                        sseBroker.broadcast('team_status_changed', {
                          team_id: teamId,
                          status: currentTeam.status,
                          previous_status: currentTeam.status,
                          phase: targetPhase,
                          previous_phase: prevPhase,
                        }, teamId);
                        console.log(`[TeamManager] Team ${teamId} phase ${prevPhase}→${targetPhase} via stdout fallback (agent: ${resolvedAgentName})`);
                      }
                    }
                  }
                } catch (err) {
                  // Non-fatal — phase fallback is best-effort
                  console.error(`[TeamManager] Phase fallback failed for team ${teamId}:`, err);
                }
              }
            }
          } catch {
            // Not valid JSON — raw text output (e.g. startup messages)
            console.log(`[CC:${logPrefix}:raw] ${trimmed.substring(0, 200)}`);
          }
        }
      });

      child.stdout.on('error', (err: Error) => {
        console.error(`[TeamManager] stdout stream error for team ${teamId}:`, err.message);
      });

      child.stdout.on('end', () => {
        if (stdoutPartial.trim()) {
          const trimmed = stdoutPartial.trim();
          buffer.push(stdoutPartial);
          try {
            const event: StreamEvent = JSON.parse(trimmed);
            console.log(`[CC:${logPrefix}] ${event.type}: ${summarizeEvent(event)}`);

            // Skip CC-echoed "user" events (same rationale as in 'data' handler)
            if (event.type !== 'user') {
              // Detect thinking state before filtering
              this.detectThinking(teamId, event);

              // Filter out content_block events (same rationale as in 'data' handler)
              if (event.type !== 'content_block_start' && event.type !== 'content_block_delta' && event.type !== 'content_block_stop' && event.type !== 'stream_event') {
                // Resolve agent name (same logic as 'data' handler)
                const endEv = event as Record<string, unknown>;
                const endParentId = (endEv.parent_tool_use_id as string | null | undefined) ?? null;
                const endAgentName = endParentId
                  ? (agentMap.get(endParentId) ?? 'subagent')
                  : 'team-lead';

                const timestampedEvent: StreamEvent = {
                  ...event,
                  timestamp: new Date().toISOString(),
                  agentName: endAgentName,
                };
                events.push(timestampedEvent);
                if (events.length > MAX_PARSED_EVENTS) {
                  events.shift();
                }

                // Accumulate token counts from assistant events
                this.accumulateTokens(teamId, event);
              }
            }
          } catch {
            console.log(`[CC:${logPrefix}:raw] ${trimmed.substring(0, 200)}`);
          }
          stdoutPartial = '';
        }
      });
    }

    // stderr: always raw text (errors, warnings)
    if (child.stderr) {
      child.stderr.on('data', (data: Buffer) => {
        const text = data.toString('utf-8');
        for (const line of text.split('\n')) {
          if (line.trim()) {
            console.log(`[CC:${logPrefix}:stderr] ${line}`);
          }
        }

        const newLines = text.split('\n');
        for (let idx = 0; idx < newLines.length; idx++) {
          const line = newLines[idx]!;
          if (line === '' && idx === newLines.length - 1) continue;
          buffer.push(line);
        }
      });

      child.stderr.on('error', (err: Error) => {
        console.error(`[TeamManager] stderr stream error for team ${teamId}:`, err.message);
      });
    }
  }

  /**
   * Extract and accumulate token counts from stream events.
   * - `assistant` events: increment token counters from usage.input_tokens, etc.
   * - `result` events: replace totalCostUsd (it's cumulative) and flush to DB.
   */
  private accumulateTokens(teamId: number, event: StreamEvent): void {
    const counter = this.tokenCounters.get(teamId);
    if (!counter) return;

    const ev = event as Record<string, unknown>;

    if (event.type === 'assistant') {
      // Extract usage from message.usage (Claude API response format)
      const message = ev.message as Record<string, unknown> | undefined;
      const usage = message?.usage as Record<string, unknown> | undefined;
      if (usage) {
        if (typeof usage.input_tokens === 'number') {
          counter.inputTokens += usage.input_tokens;
        }
        if (typeof usage.output_tokens === 'number') {
          counter.outputTokens += usage.output_tokens;
        }
        if (typeof usage.cache_creation_input_tokens === 'number') {
          counter.cacheCreationTokens += usage.cache_creation_input_tokens;
        }
        if (typeof usage.cache_read_input_tokens === 'number') {
          counter.cacheReadTokens += usage.cache_read_input_tokens;
        }
      }
    }

    if (event.type === 'result') {
      // total_cost_usd on result is cumulative for the session — replace, don't add
      if (typeof ev.total_cost_usd === 'number') {
        counter.costUsd = ev.total_cost_usd;
        console.log(`[TeamManager] Team ${teamId} cost: $${counter.costUsd.toFixed(4)}`);
      }
      // Flush to DB on every result event
      this.flushTokenCounters(teamId);
    }
  }

  /**
   * Persist in-memory token counters to the database and broadcast SSE update.
   */
  private flushTokenCounters(teamId: number): void {
    const counter = this.tokenCounters.get(teamId);
    if (!counter) return;

    try {
      const db = getDatabase();
      db.updateTeam(teamId, {
        totalInputTokens: counter.inputTokens,
        totalOutputTokens: counter.outputTokens,
        totalCacheCreationTokens: counter.cacheCreationTokens,
        totalCacheReadTokens: counter.cacheReadTokens,
        totalCostUsd: counter.costUsd,
      });

      const currentTeam = db.getTeam(teamId);
      const status = currentTeam?.status ?? 'running';
      sseBroker.broadcast('team_status_changed', {
        team_id: teamId,
        status,
        previous_status: status,
        tokens: {
          input: counter.inputTokens,
          output: counter.outputTokens,
          cacheCreation: counter.cacheCreationTokens,
          cacheRead: counter.cacheReadTokens,
          costUsd: counter.costUsd,
        },
      }, teamId);
    } catch (err) {
      console.error(`[TeamManager] Failed to flush token counters for team ${teamId}:`, err);
    }
  }

  /**
   * Detect thinking start/stop from Claude Code stream-json events.
   *
   * content_block_start with content_block.type === "thinking" signals the
   * start of an extended thinking block. content_block_stop (matched by
   * index) signals the end.
   */
  private detectThinking(teamId: number, event: StreamEvent): void {
    let ev = event as Record<string, unknown>;
    let effectiveType = event.type;

    // Unwrap stream_event envelopes: thinking signals from
    // --include-partial-messages arrive wrapped as
    // { type: "stream_event", event: { type: "content_block_start", ... } }
    if (event.type === 'stream_event') {
      const inner = ev.event as Record<string, unknown> | undefined;
      if (inner && typeof inner.type === 'string') {
        ev = inner;
        effectiveType = inner.type as string;
      }
    }

    if (effectiveType === 'content_block_start') {
      const block = ev.content_block as Record<string, unknown> | undefined;
      if (block && block.type === 'thinking') {
        this.thinkingTeams.add(teamId);
        this.thinkingStartTimes.set(teamId, Date.now());
        const index = typeof ev.index === 'number' ? ev.index : -1;
        this.thinkingBlockIndex.set(teamId, index);
        sseBroker.broadcast('team_thinking_start', { team_id: teamId }, teamId);
        console.log(`[TeamManager] Team ${teamId} thinking started (block index ${index})`);
      }
    } else if (effectiveType === 'content_block_stop') {
      const index = typeof ev.index === 'number' ? ev.index : -1;
      const trackedIndex = this.thinkingBlockIndex.get(teamId);
      if (this.thinkingTeams.has(teamId) && (trackedIndex === undefined || trackedIndex === index)) {
        const startTime = this.thinkingStartTimes.get(teamId) ?? Date.now();
        const durationMs = Date.now() - startTime;
        this.thinkingTeams.delete(teamId);
        this.thinkingStartTimes.delete(teamId);
        this.thinkingBlockIndex.delete(teamId);
        sseBroker.broadcast('team_thinking_stop', { team_id: teamId, duration_ms: durationMs }, teamId);
        console.log(`[TeamManager] Team ${teamId} thinking stopped (${durationMs}ms)`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // purgeTeamMaps — centralized cleanup of ALL per-team tracking maps
  // -------------------------------------------------------------------------
  // When adding a new per-team Map or Set to TeamManager, you MUST add a
  // corresponding .delete() call here. The maps cleaned are:
  //   outputBuffers, childProcesses, stdinPipes, parsedEvents, tokenCounters,
  //   agentMaps, lastStreamAt, shutdownTimers, thinkingTeams,
  //   thinkingStartTimes, thinkingBlockIndex
  // -------------------------------------------------------------------------

  /**
   * Delete all per-team map/set entries for the given teamId.
   * Clears the shutdown timer (if any) before deleting it, and
   * broadcasts a thinking-stop SSE event if the team was thinking.
   * Safe to call multiple times (all operations are idempotent).
   */
  private purgeTeamMaps(teamId: number): void {
    // Clear shutdown timer before deleting to prevent dangling callback
    const timer = this.shutdownTimers.get(teamId);
    if (timer) {
      clearTimeout(timer);
      this.shutdownTimers.delete(teamId);
    }

    // Clear thinking state (broadcasts SSE event if active)
    this.clearThinking(teamId);

    this.outputBuffers.delete(teamId);
    this.childProcesses.delete(teamId);
    this.stdinPipes.delete(teamId);
    this.parsedEvents.delete(teamId);
    this.tokenCounters.delete(teamId);
    this.agentMaps.delete(teamId);
    this.lastStreamAt.delete(teamId);
  }

  // -------------------------------------------------------------------------
  // Periodic cleanup — sweep orphaned map entries as a safety net
  // -------------------------------------------------------------------------

  private cleanupInterval: NodeJS.Timeout | null = null;

  /**
   * Start a periodic timer that sweeps map entries for teams that are in a
   * terminal state (done/failed) or no longer exist in the database, AND have
   * no active child process. Uses `.unref()` so the timer does not prevent
   * Node.js from exiting.
   */
  startPeriodicCleanup(): void {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => {
      this.sweepOrphanedMaps();
    }, config.mapCleanupIntervalMs);
    this.cleanupInterval.unref();
  }

  /** Stop the periodic cleanup timer. */
  stopPeriodicCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Scan all per-team maps for team IDs that are in a terminal DB state
   * (done/failed) or missing from the database, AND have no active child
   * process. Purge those entries to prevent unbounded memory growth.
   */
  private sweepOrphanedMaps(): void {
    const db = getDatabase();

    // Collect all unique team IDs across every per-team map/set
    const allTeamIds = new Set<number>();
    for (const id of this.outputBuffers.keys()) allTeamIds.add(id);
    for (const id of this.childProcesses.keys()) allTeamIds.add(id);
    for (const id of this.stdinPipes.keys()) allTeamIds.add(id);
    for (const id of this.parsedEvents.keys()) allTeamIds.add(id);
    for (const id of this.tokenCounters.keys()) allTeamIds.add(id);
    for (const id of this.agentMaps.keys()) allTeamIds.add(id);
    for (const id of this.lastStreamAt.keys()) allTeamIds.add(id);
    for (const id of this.shutdownTimers.keys()) allTeamIds.add(id);
    for (const id of this.thinkingTeams) allTeamIds.add(id);
    for (const id of this.thinkingStartTimes.keys()) allTeamIds.add(id);
    for (const id of this.thinkingBlockIndex.keys()) allTeamIds.add(id);

    let purged = 0;
    for (const teamId of allTeamIds) {
      // Never purge maps for a team that still has an active child process
      if (this.childProcesses.has(teamId)) continue;

      const team = db.getTeam(teamId);
      if (!team || team.status === 'done' || team.status === 'failed') {
        this.purgeTeamMaps(teamId);
        purged++;
      }
    }

    if (purged > 0) {
      console.log(`[TeamManager] Periodic cleanup: purged maps for ${purged} orphaned team(s)`);
    }
  }

  /**
   * Clear thinking state for a team (e.g. on stop/cleanup).
   */
  clearThinking(teamId: number): void {
    if (this.thinkingTeams.has(teamId)) {
      const startTime = this.thinkingStartTimes.get(teamId) ?? Date.now();
      const durationMs = Date.now() - startTime;
      this.thinkingTeams.delete(teamId);
      this.thinkingStartTimes.delete(teamId);
      this.thinkingBlockIndex.delete(teamId);
      sseBroker.broadcast('team_thinking_stop', { team_id: teamId, duration_ms: durationMs }, teamId);
    }
  }

  private killProcess(pid: number): void {
    try {
      if (process.platform === 'win32') {
        // On Windows, use taskkill to kill the entire process tree
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'pipe' });
      } else {
        // On Unix, send SIGTERM
        process.kill(pid, 'SIGTERM');
      }
    } catch {
      // Process may have already exited — ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: TeamManager | null = null;

export function getTeamManager(): TeamManager {
  if (!_instance) {
    _instance = new TeamManager();
  }
  return _instance;
}

export default TeamManager;
