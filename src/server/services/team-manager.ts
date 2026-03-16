// =============================================================================
// Fleet Commander — Team Manager Service (Spawn / Stop / Resume)
// =============================================================================
// Manages Claude Code agent processes: creates git worktrees, copies hooks,
// spawns child processes, captures output, and handles lifecycle transitions.
//
// Per-project: launch() accepts a projectId and resolves repo path, github
// repo, and worktree naming from the project record in the database.
// =============================================================================

import { spawn, execSync, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import config from '../config.js';
import { getDatabase } from '../db.js';
import { sseBroker } from './sse-broker.js';
import type { Team } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_OUTPUT_LINES = config.outputBufferLines;

// ---------------------------------------------------------------------------
// Output buffer: circular array of last N lines per team
// ---------------------------------------------------------------------------

interface OutputBuffer {
  lines: string[];
}

// ---------------------------------------------------------------------------
// TeamManager
// ---------------------------------------------------------------------------

export class TeamManager {
  private outputBuffers: Map<number, OutputBuffer> = new Map();
  private childProcesses: Map<number, ChildProcess> = new Map();

  // -------------------------------------------------------------------------
  // launch — create worktree, copy hooks, spawn Claude Code
  // -------------------------------------------------------------------------

  async launch(
    projectId: number,
    issueNumber: number,
    issueTitle?: string,
    prompt?: string,
  ): Promise<Team> {
    console.log(`[TeamManager] launch() called: projectId=${projectId}, issue=#${issueNumber}`);
    const db = getDatabase();

    // Look up project to get repo_path, github_repo, name
    const project = db.getProject(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    // Derive a slug from project name (lowercase, alphanumeric + hyphens)
    const slug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const worktreeName = `${slug}-${issueNumber}`;
    const branchName = `worktree-${slug}-${issueNumber}`;
    const worktreeRelPath = path.posix.join(config.worktreeDir, worktreeName);
    const worktreeAbsPath = path.join(project.repoPath, config.worktreeDir, worktreeName);

    // Check if a team already exists for this worktree name
    const existing = db.getTeamByWorktree(worktreeName);
    let relaunchTeamId: number | null = null;

    if (existing) {
      if (['running', 'launching', 'idle', 'stuck', 'queued'].includes(existing.status)) {
        throw new Error(`Team already active for issue ${issueNumber} (status: ${existing.status})`);
      }
      // Terminal state (done/failed) — reuse the existing team record
      relaunchTeamId = existing.id;
    }

    // 1. Create git worktree in the PROJECT's repo (if it doesn't exist)
    if (!fs.existsSync(worktreeAbsPath)) {
      try {
        execSync(
          `git -C "${project.repoPath}" worktree add "${worktreeRelPath}" -b "${branchName}"`,
          { encoding: 'utf-8', stdio: 'pipe' },
        );
      } catch (err: unknown) {
        // Branch may already exist — try without -b
        try {
          execSync(
            `git -C "${project.repoPath}" worktree add "${worktreeRelPath}" "${branchName}"`,
            { encoding: 'utf-8', stdio: 'pipe' },
          );
        } catch (err2: unknown) {
          const msg = err2 instanceof Error ? err2.message : String(err2);
          throw new Error(`Failed to create worktree: ${msg}`);
        }
      }
    }

    // 2. Copy hook scripts from FC's own hooks/ directory into worktree
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
        // Ensure executable on Unix
        if (process.platform !== 'win32') {
          fs.chmodSync(dest, 0o755);
        }
      }
    }

    // 3. Generate settings.json from example
    const settingsExamplePath = path.join(hookSrcDir, 'settings.json.example');
    const settingsDestDir = path.join(worktreeAbsPath, '.claude');
    const settingsDestPath = path.join(settingsDestDir, 'settings.json');

    fs.mkdirSync(settingsDestDir, { recursive: true });

    if (fs.existsSync(settingsExamplePath)) {
      fs.copyFileSync(settingsExamplePath, settingsDestPath);
    }

    // 4. Insert or reuse team record in DB (with projectId)
    const now = new Date().toISOString();
    let team: Team;

    if (relaunchTeamId !== null) {
      // Relaunch: reset the existing terminal team record
      console.log(`[TeamManager] Relaunching existing team record: id=${relaunchTeamId}, worktree=${worktreeName}`);
      db.updateTeam(relaunchTeamId, {
        status: 'launching',
        phase: 'init',
        pid: null,
        sessionId: null,
        issueTitle: issueTitle ?? null,
        launchedAt: now,
        stoppedAt: null,
        lastEventAt: null,
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
        status: 'launching',
        phase: 'init',
        launchedAt: now,
      });
    }

    console.log(`[TeamManager] Team ready: id=${team.id}, status=${team.status}, relaunch=${relaunchTeamId !== null}`);

    // 5. Spawn Claude Code process
    const resolvedPrompt = prompt || `${config.defaultPrompt} ${issueNumber}`;
    const args = ['--worktree', worktreeName, resolvedPrompt];

    if (config.skipPermissions) {
      args.unshift('--dangerously-skip-permissions');
    }

    const child = spawn(config.claudeCmd, args, {
      cwd: project.repoPath,
      env: {
        ...process.env,
        FLEET_TEAM_ID: worktreeName,
        FLEET_PROJECT_ID: String(projectId),
        FLEET_GITHUB_REPO: project.githubRepo ?? '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // On Windows, use shell to resolve commands in PATH
      shell: process.platform === 'win32',
      // Detach so parent can exit without killing children (if needed)
      detached: false,
    });

    const pid = child.pid;
    if (pid === undefined) {
      console.error(`[TeamManager] Spawn failed for team ${team.id}: no PID returned`);
      db.updateTeam(team.id, { status: 'failed', stoppedAt: new Date().toISOString() });
      this.broadcastSnapshot();
      throw new Error('Failed to spawn Claude Code process — no PID returned');
    }

    console.log(`[TeamManager] Process spawned: team=${team.id}, pid=${pid}`);

    // Update team with PID
    db.updateTeam(team.id, { pid });

    // Store child process reference
    this.childProcesses.set(team.id, child);

    // 6. Set up output capture
    this.initOutputBuffer(team.id);
    this.captureOutput(team.id, child);

    // 7. Handle process exit
    child.on('exit', (code, signal) => {
      console.log(`[TeamManager] Process exited for team ${team.id} (code=${code}, signal=${signal})`);
      this.childProcesses.delete(team.id);

      const currentTeam = db.getTeam(team.id);
      if (!currentTeam) return;

      // Only update status if team is still in an active state
      if (['launching', 'running', 'idle', 'stuck'].includes(currentTeam.status)) {
        const exitStatus = (code === 0) ? 'done' : 'failed';
        db.updateTeam(team.id, {
          status: exitStatus,
          pid: null,
          stoppedAt: new Date().toISOString(),
        });

        sseBroker.broadcast(
          'team_stopped',
          { team_id: team.id },
          team.id,
        );

        this.broadcastSnapshot();
      }
    });

    child.on('error', (err) => {
      console.error(`[TeamManager] Process error for team ${team.id}:`, err);
      this.childProcesses.delete(team.id);

      const currentTeam = db.getTeam(team.id);
      if (!currentTeam) return;

      if (['launching', 'running', 'idle', 'stuck'].includes(currentTeam.status)) {
        db.updateTeam(team.id, {
          status: 'failed',
          pid: null,
          stoppedAt: new Date().toISOString(),
        });

        sseBroker.broadcast(
          'team_stopped',
          { team_id: team.id },
          team.id,
        );

        this.broadcastSnapshot();
      }
    });

    // 8. Broadcast launch event
    sseBroker.broadcast(
      'team_launched',
      { team_id: team.id, issue_number: issueNumber, project_id: projectId },
      team.id,
    );

    // 9. Broadcast full snapshot so all SSE clients refresh their team list
    this.broadcastSnapshot();

    // Return fresh team record
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

    if (team.pid) {
      this.killProcess(team.pid);
    }

    // Clean up child process reference
    this.childProcesses.delete(teamId);

    const updated = db.updateTeam(teamId, {
      status: 'done',
      pid: null,
      stoppedAt: new Date().toISOString(),
    });

    sseBroker.broadcast(
      'team_stopped',
      { team_id: teamId },
      teamId,
    );

    this.broadcastSnapshot();

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

    // Resolve project for repo path
    const project = team.projectId ? db.getProject(team.projectId) : undefined;
    if (!project) {
      throw new Error(`Project for team ${teamId} not found (projectId: ${team.projectId})`);
    }

    // Verify worktree still exists
    const worktreeAbsPath = path.join(
      project.repoPath, config.worktreeDir, team.worktreeName,
    );
    if (!fs.existsSync(worktreeAbsPath)) {
      throw new Error(`Worktree ${team.worktreeName} no longer exists at ${worktreeAbsPath}`);
    }

    // Build args with --resume
    const args = ['--resume', '--worktree', team.worktreeName];

    if (config.skipPermissions) {
      args.unshift('--dangerously-skip-permissions');
    }

    // Update status to launching
    db.updateTeam(teamId, {
      status: 'launching',
      launchedAt: new Date().toISOString(),
      stoppedAt: null,
    });

    const child = spawn(config.claudeCmd, args, {
      cwd: project.repoPath,
      env: {
        ...process.env,
        FLEET_TEAM_ID: team.worktreeName,
        FLEET_PROJECT_ID: String(project.id),
        FLEET_GITHUB_REPO: project.githubRepo ?? '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      detached: false,
    });

    const pid = child.pid;
    if (pid === undefined) {
      db.updateTeam(teamId, { status: 'failed', stoppedAt: new Date().toISOString() });
      throw new Error('Failed to spawn Claude Code process — no PID returned');
    }

    db.updateTeam(teamId, { pid });

    // Store child process reference
    this.childProcesses.set(teamId, child);

    // Set up output capture
    this.initOutputBuffer(teamId);
    this.captureOutput(teamId, child);

    // Handle process exit
    child.on('exit', (code, _signal) => {
      console.log(`[TeamManager] Resume process exited for team ${teamId} (code=${code})`);
      this.childProcesses.delete(teamId);

      const currentTeam = db.getTeam(teamId);
      if (!currentTeam) return;

      if (['launching', 'running', 'idle', 'stuck'].includes(currentTeam.status)) {
        const exitStatus = (code === 0) ? 'done' : 'failed';
        db.updateTeam(teamId, {
          status: exitStatus,
          pid: null,
          stoppedAt: new Date().toISOString(),
        });

        sseBroker.broadcast('team_stopped', { team_id: teamId }, teamId);
        this.broadcastSnapshot();
      }
    });

    child.on('error', (err) => {
      console.error(`[TeamManager] Resume process error for team ${teamId}:`, err);
      this.childProcesses.delete(teamId);

      const currentTeam = db.getTeam(teamId);
      if (!currentTeam) return;

      if (['launching', 'running', 'idle', 'stuck'].includes(currentTeam.status)) {
        db.updateTeam(teamId, {
          status: 'failed',
          pid: null,
          stoppedAt: new Date().toISOString(),
        });

        sseBroker.broadcast('team_stopped', { team_id: teamId }, teamId);
        this.broadcastSnapshot();
      }
    });

    // Broadcast launch event
    sseBroker.broadcast(
      'team_launched',
      { team_id: teamId, issue_number: team.issueNumber },
      teamId,
    );

    // Broadcast full snapshot so all SSE clients refresh their team list
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

    // Stop if running
    if (team.pid && ['launching', 'running', 'idle', 'stuck'].includes(team.status)) {
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
  // launchBatch — launch multiple teams with optional stagger delay
  // -------------------------------------------------------------------------

  async launchBatch(
    projectId: number,
    issues: Array<{ number: number; title?: string }>,
    prompt?: string,
    delayMs?: number,
  ): Promise<Team[]> {
    const results: Team[] = [];
    const delay = delayMs ?? 2000; // default 2-second stagger

    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i]!;
      try {
        const team = await this.launch(projectId, issue.number, issue.title, prompt);
        results.push(team);
      } catch (err: unknown) {
        // Push a synthetic error indicator — don't stop the batch
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Batch launch failed at issue #${issue.number} (${i + 1}/${issues.length}): ${msg}. ` +
          `Successfully launched: ${results.length}`,
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

    const handleData = (data: Buffer) => {
      const text = data.toString('utf-8');
      const newLines = text.split('\n');

      for (const line of newLines) {
        // Skip empty trailing line from split
        if (line === '' && newLines.indexOf(line) === newLines.length - 1) continue;
        buffer.lines.push(line);

        // Trim to max
        while (buffer.lines.length > MAX_OUTPUT_LINES) {
          buffer.lines.shift();
        }
      }
    };

    if (child.stdout) {
      child.stdout.on('data', handleData);
    }
    if (child.stderr) {
      child.stderr.on('data', handleData);
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
