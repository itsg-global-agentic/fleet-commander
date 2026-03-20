// =============================================================================
// Fleet Commander — Team Manager Service (Spawn / Stop / Resume)
// =============================================================================
// Manages Claude Code agent processes: creates git worktrees, copies hooks,
// spawns child processes, captures output, and handles lifecycle transitions.
//
// Per-project: launch() accepts a projectId and resolves repo path, github
// repo, and worktree naming from the project record in the database.
// =============================================================================

import { spawn, execSync, exec as execCallback, ChildProcess } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import type { Writable } from 'stream';
import config from '../config.js';
import { getDatabase } from '../db.js';
import { sseBroker } from './sse-broker.js';
import type { StreamEvent } from './sse-broker.js';
import { findGitBash } from '../utils/find-git-bash.js';
import { resolveClaudePath } from '../utils/resolve-claude-path.js';
import type { Team, Project } from '../../shared/types.js';
import { getUsageZone } from './usage-tracker.js';
import { resolveMessage } from '../utils/resolve-message.js';

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
// Output buffer: circular array of last N lines per team
// ---------------------------------------------------------------------------

interface OutputBuffer {
  lines: string[];
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
  private outputBuffers: Map<number, OutputBuffer> = new Map();
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
    if (!issueTitle && project.githubRepo) {
      try {
        const { stdout } = await execAsync(
          `gh issue view ${issueNumber} --repo ${project.githubRepo} --json title --jq .title`,
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
    this.copyHooksAndSettings(worktreeAbsPath);

    // ── Step 4: Spawn Claude Code process ──
    const resolvedPrompt = prompt || this.resolvePromptFromFile(project, issueNumber);
    const isHeadless = headless !== false;

    if (!isHeadless && process.platform === 'win32') {
      // ── Interactive mode (Windows): open Claude Code in a new terminal ──
      await this.launchInteractive(team, project, worktreeAbsPath, resolvedPrompt);
      return db.getTeam(team.id)!;
    }

    // ── Headless mode (default): spawn in background, capture output ──
    const args = this.buildHeadlessClaudeArgs(worktreeName, {
      model: project.model,
    });

    const spawnEnv = this.buildSpawnEnv(project, worktreeName, projectId);
    const claudePath = resolveClaudePath();
    console.log(`[TeamManager] Spawning: ${claudePath} ${args.join(' ')} (headless=${isHeadless})`);

    const child = this.spawnAndValidate(claudePath, args, project.repoPath, spawnEnv, team.id);
    if (!child) {
      throw new Error('Failed to spawn Claude Code process — no PID returned');
    }

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

    // Clean up child process reference
    this.clearThinking(teamId);
    this.flushTokenCounters(teamId);
    this.persistParsedEvents(teamId);
    this.childProcesses.delete(teamId);
    this.outputBuffers.delete(teamId);
    this.parsedEvents.delete(teamId);
    this.agentMaps.delete(teamId);
    this.tokenCounters.delete(teamId);

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

    // Build args with --resume (headless mode — resume always uses stream-json)
    const args = this.buildHeadlessClaudeArgs(team.worktreeName, {
      resume: true,
      model: project.model,
    });

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

    const spawnEnv = this.buildSpawnEnv(project, team.worktreeName, project.id);
    const claudePath = resolveClaudePath();
    console.log(`[TeamManager] Resume spawning: ${claudePath} ${args.join(' ')}`);

    const child = this.spawnAndValidate(claudePath, args, project.repoPath, spawnEnv, teamId);
    if (!child) {
      throw new Error('Failed to spawn Claude Code process — no PID returned');
    }

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
    if (!issueTitle && project.githubRepo) {
      try {
        const { stdout } = await execAsync(
          `gh issue view ${issueNumber} --repo ${project.githubRepo} --json title --jq .title`,
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
      const toDequeue = queued.slice(0, available);

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

    db.updateTeam(team.id, { status: 'launching' });
    this.broadcastSnapshot();

    // ── Step 2: Copy hooks and settings ──
    this.copyHooksAndSettings(worktreeAbsPath);

    // ── Step 3: Spawn Claude Code ──
    const resolvedPrompt = team.customPrompt || this.resolvePromptFromFile(project, team.issueNumber);
    const isHeadless = team.headless;

    if (!isHeadless && process.platform === 'win32') {
      // ── Interactive mode (Windows): open Claude Code in a new terminal ──
      await this.launchInteractive(team, project, worktreeAbsPath, resolvedPrompt);
      return;
    }

    // ── Headless mode (default): spawn in background, capture output ──
    const args = this.buildHeadlessClaudeArgs(team.worktreeName, {
      model: project.model,
    });

    const spawnEnv = this.buildSpawnEnv(project, team.worktreeName, projectId);
    const claudePath = resolveClaudePath();
    console.log(`[TeamManager] Spawning dequeued team ${team.id}: ${claudePath} ${args.join(' ')} (headless=${isHeadless})`);

    const child = this.spawnAndValidate(claudePath, args, project.repoPath, spawnEnv, team.id);
    if (!child) return;

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

    if (lines && lines > 0 && lines < buffer.lines.length) {
      return buffer.lines.slice(-lines);
    }

    return [...buffer.lines];
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
        // childProcesses.delete is idempotent
        this.flushTokenCounters(teamId);
        this.persistParsedEvents(teamId);
        this.childProcesses.delete(teamId);
        this.outputBuffers.delete(teamId);
        this.parsedEvents.delete(teamId);
        this.tokenCounters.delete(teamId);

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

  // -------------------------------------------------------------------------
  // Shared spawn/lifecycle helpers (extracted from launch/resume/launchQueued)
  // -------------------------------------------------------------------------

  /**
   * Build the spawn environment for a Claude Code process.
   * Inherits the server's env and adds fleet/git-bash vars.
   * This is the SINGLE source of CC env vars for BOTH headless and interactive modes.
   */
  private buildSpawnEnv(
    project: Project,
    worktreeName: string,
    projectId: number,
  ): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      FLEET_TEAM_ID: worktreeName,
      FLEET_PROJECT_ID: String(projectId),
      FLEET_GITHUB_REPO: project.githubRepo ?? '',
    };
    // Only set agent teams env var when enabled; explicitly clear it otherwise
    // so it's not inherited from process.env
    if (config.enableAgentTeams) {
      env['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'] = '1';
    } else {
      env['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'] = undefined;
    }
    const gitBash = findGitBash();
    if (gitBash) {
      env['CLAUDE_CODE_GIT_BASH_PATH'] = gitBash;
      console.log(`[TeamManager] CLAUDE_CODE_GIT_BASH_PATH=${gitBash}`);
    }
    console.log(`[TeamManager] Spawn env: FLEET_TEAM_ID=${worktreeName}, FLEET_PROJECT_ID=${projectId}, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=${config.enableAgentTeams ? '1' : 'disabled'}`);
    return env;
  }

  /**
   * Build the base Claude CLI args shared by BOTH headless and interactive modes.
   * @param worktreeName — worktree name for --worktree flag
   * @param options.resume — add --resume flag (for resume flow)
   * @param options.model — optional model override from project
   * @param options.prompt — positional prompt arg (interactive mode only)
   */
  private buildBaseClaudeArgs(
    worktreeName: string,
    options?: {
      resume?: boolean;
      model?: string | null;
      prompt?: string;
    },
  ): string[] {
    const args: string[] = [];
    if (options?.resume) {
      args.push('--resume');
    }
    args.push('--worktree', worktreeName);

    if (config.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    if (options?.model) {
      args.push('--model', options.model);
    }

    if (options?.prompt) {
      args.push(options.prompt);
    }

    return args;
  }

  /**
   * Build Claude CLI args for headless (stream-json) mode.
   * Calls buildBaseClaudeArgs() and appends stream-json + verbose flags.
   */
  private buildHeadlessClaudeArgs(
    worktreeName: string,
    options?: {
      resume?: boolean;
      model?: string | null;
    },
  ): string[] {
    const args = this.buildBaseClaudeArgs(worktreeName, options);
    args.push('--input-format', 'stream-json');
    args.push('--output-format', 'stream-json');
    args.push('--verbose');
    args.push('--include-partial-messages');
    return args;
  }

  /**
   * Build the `set VAR=value` portion of the innerCommand for interactive
   * mode on Windows. Iterates over buildSpawnEnv() output to generate
   * set commands dynamically, ensuring all env vars are passed.
   *
   * Only includes fleet/CC-specific vars (prefixed FLEET_, CLAUDE_CODE_)
   * to keep the command string manageable and avoid leaking unrelated env.
   */
  private buildInteractiveEnvSetCommands(
    spawnEnv: Record<string, string | undefined>,
  ): string {
    const prefixes = ['FLEET_', 'CLAUDE_CODE_'];
    const setCmds: string[] = [];
    for (const [key, value] of Object.entries(spawnEnv)) {
      if (value !== undefined && prefixes.some(p => key.startsWith(p))) {
        setCmds.push(`set ${key}=${value}`);
      }
    }
    return setCmds.join(' && ');
  }

  /**
   * Launch a Claude Code process in interactive mode (Windows terminal).
   * Extracted from the duplicated logic in launch() and launchQueued().
   *
   * Opens a new terminal window (wt.exe or cmd.exe) with the Claude Code
   * CLI and all required env vars from buildSpawnEnv().
   */
  private async launchInteractive(
    team: Team,
    project: Project,
    worktreeAbsPath: string,
    prompt: string,
  ): Promise<void> {
    const db = getDatabase();

    const args = this.buildBaseClaudeArgs(team.worktreeName, {
      model: project.model,
      prompt,
    });

    const spawnEnv = this.buildSpawnEnv(project, team.worktreeName, team.projectId!);
    const claudePath = resolveClaudePath();
    const fullCmd = `${claudePath} ${args.join(' ')}`;
    const windowTitle = `Team ${team.worktreeName}`;

    // Build env set commands dynamically from buildSpawnEnv()
    const envSetCmds = this.buildInteractiveEnvSetCommands(spawnEnv);
    const innerCommand = `cd /d "${worktreeAbsPath}" && ${envSetCmds} && ${fullCmd}`;

    const termPref = config.terminalCmd;
    let useWindowsTerminal = false;

    if (termPref === 'wt') {
      useWindowsTerminal = true;
    } else if (termPref === 'auto') {
      try {
        await execAsync('where wt.exe', { timeout: 3000 });
        useWindowsTerminal = true;
      } catch {
        useWindowsTerminal = false;
      }
    }

    let startCommand: string;
    if (useWindowsTerminal) {
      startCommand = `wt.exe new-tab --title "${windowTitle}" cmd.exe /k "${innerCommand}"`;
    } else {
      startCommand = `start "${windowTitle}" cmd.exe /k "${innerCommand}"`;
    }

    console.log(`[TeamManager] Interactive spawn (terminal=${useWindowsTerminal ? 'wt' : 'cmd'}): ${startCommand}`);

    const interactiveChild = spawn(startCommand, [], {
      env: spawnEnv,
      shell: true,
      detached: true,
      stdio: 'ignore',
    });
    interactiveChild.unref();

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
   * Spawn a Claude Code process and validate it got a PID.
   * On failure, transitions team to 'failed' and broadcasts snapshot.
   * Returns the child process, or null if spawn failed.
   */
  private spawnAndValidate(
    claudePath: string,
    args: string[],
    cwd: string,
    env: Record<string, string | undefined>,
    teamId: number,
  ): ChildProcess | null {
    const db = getDatabase();

    const child = spawn(claudePath, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
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
      return null;
    }

    console.log(`[TeamManager] Process spawned: PID ${pid}`);
    db.updateTeam(teamId, { pid });
    this.broadcastSnapshot();
    this.childProcesses.set(teamId, child);

    return child;
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
      this.clearThinking(teamId);
      this.flushTokenCounters(teamId);
      this.persistParsedEvents(teamId);
      this.childProcesses.delete(teamId);
      this.stdinPipes.delete(teamId);
      this.outputBuffers.delete(teamId);
      this.parsedEvents.delete(teamId);
      this.tokenCounters.delete(teamId);

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
      this.clearThinking(teamId);
      this.flushTokenCounters(teamId);
      this.persistParsedEvents(teamId);
      this.childProcesses.delete(teamId);
      this.stdinPipes.delete(teamId);
      this.outputBuffers.delete(teamId);
      this.parsedEvents.delete(teamId);
      this.tokenCounters.delete(teamId);

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
   * Copy hook scripts and generate settings.json into a worktree directory.
   */
  private copyHooksAndSettings(worktreeAbsPath: string): void {
    const hookSrcDir = config.fcHooksDir;
    const hookDestDir = path.join(worktreeAbsPath, config.hookDir);

    fs.mkdirSync(hookDestDir, { recursive: true });

    if (fs.existsSync(hookSrcDir)) {
      const hookFiles = fs.readdirSync(hookSrcDir).filter(
        (f) => f.endsWith('.sh'),
      );
      for (const file of hookFiles) {
        const src = path.join(hookSrcDir, file);
        const dest = path.join(hookDestDir, file);
        fs.copyFileSync(src, dest);
        if (process.platform !== 'win32') {
          fs.chmodSync(dest, 0o755);
        }
      }
    }

    console.log(`[TeamManager] Hooks copied to worktree`);

    // Generate settings.json from example
    const settingsExamplePath = path.join(hookSrcDir, 'settings.json.example');
    const settingsDestDir = path.join(worktreeAbsPath, '.claude');
    const settingsDestPath = path.join(settingsDestDir, 'settings.json');

    fs.mkdirSync(settingsDestDir, { recursive: true });

    if (fs.existsSync(settingsExamplePath)) {
      fs.copyFileSync(settingsExamplePath, settingsDestPath);
    }
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
    this.outputBuffers.set(teamId, { lines: [] });
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

          // Store raw line in output buffer
          buffer.lines.push(line);
          while (buffer.lines.length > MAX_OUTPUT_LINES) {
            buffer.lines.shift();
          }

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
            if (event.type === 'content_block_start' || event.type === 'content_block_delta' || event.type === 'content_block_stop') {
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
          } catch {
            // Not valid JSON — raw text output (e.g. startup messages)
            console.log(`[CC:${logPrefix}:raw] ${trimmed.substring(0, 200)}`);
          }
        }
      });

      child.stdout.on('end', () => {
        if (stdoutPartial.trim()) {
          const trimmed = stdoutPartial.trim();
          buffer.lines.push(stdoutPartial);
          while (buffer.lines.length > MAX_OUTPUT_LINES) {
            buffer.lines.shift();
          }
          try {
            const event: StreamEvent = JSON.parse(trimmed);
            console.log(`[CC:${logPrefix}] ${event.type}: ${summarizeEvent(event)}`);

            // Skip CC-echoed "user" events (same rationale as in 'data' handler)
            if (event.type !== 'user') {
              // Detect thinking state before filtering
              this.detectThinking(teamId, event);

              // Filter out content_block events (same rationale as in 'data' handler)
              if (event.type !== 'content_block_start' && event.type !== 'content_block_delta' && event.type !== 'content_block_stop') {
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
          buffer.lines.push(line);
          while (buffer.lines.length > MAX_OUTPUT_LINES) {
            buffer.lines.shift();
          }
        }
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
    const ev = event as Record<string, unknown>;

    if (event.type === 'content_block_start') {
      const block = ev.content_block as Record<string, unknown> | undefined;
      if (block && block.type === 'thinking') {
        this.thinkingTeams.add(teamId);
        this.thinkingStartTimes.set(teamId, Date.now());
        const index = typeof ev.index === 'number' ? ev.index : -1;
        this.thinkingBlockIndex.set(teamId, index);
        sseBroker.broadcast('team_thinking_start', { team_id: teamId }, teamId);
        console.log(`[TeamManager] Team ${teamId} thinking started (block index ${index})`);
      }
    } else if (event.type === 'content_block_stop') {
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
