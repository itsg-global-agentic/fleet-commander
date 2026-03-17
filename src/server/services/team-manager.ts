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
import type { Writable } from 'stream';
import config from '../config.js';
import { getDatabase } from '../db.js';
import { sseBroker } from './sse-broker.js';
import type { StreamEvent } from './sse-broker.js';
import { findGitBash } from '../utils/find-git-bash.js';
import type { Team, Project } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_OUTPUT_LINES = config.outputBufferLines;
const MAX_PARSED_EVENTS = 200;

// ---------------------------------------------------------------------------
// Resolve claude executable path (Windows needs full path for shell-free spawn)
// ---------------------------------------------------------------------------

let _resolvedClaudePath: string | null = null;

/**
 * On Windows, `spawn('claude', ...)` with `shell: false` fails because Node
 * cannot resolve bare command names via PATH without a shell. We use `where`
 * to find the full path to claude.exe once, then cache the result.
 *
 * On non-Windows platforms, the bare command name works fine with shell: false.
 */
function resolveClaudePath(): string {
  if (_resolvedClaudePath) return _resolvedClaudePath;

  if (process.platform === 'win32') {
    try {
      const result = execSync('where claude.exe', {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const firstLine = result.trim().split('\n')[0]?.trim();
      if (firstLine) {
        _resolvedClaudePath = firstLine;
        console.log(`[TeamManager] Resolved claude path: ${_resolvedClaudePath}`);
        return _resolvedClaudePath;
      }
    } catch {
      // `where` failed — try `where claude` without .exe extension
      try {
        const result = execSync('where claude', {
          encoding: 'utf-8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const firstLine = result.trim().split('\n')[0]?.trim();
        if (firstLine) {
          _resolvedClaudePath = firstLine;
          console.log(`[TeamManager] Resolved claude path: ${_resolvedClaudePath}`);
          return _resolvedClaudePath;
        }
      } catch {
        // Fall through to default
      }
    }
  }

  // Non-Windows or resolution failed — use configured command as-is
  _resolvedClaudePath = config.claudeCmd;
  console.log(`[TeamManager] Using claude command: ${_resolvedClaudePath}`);
  return _resolvedClaudePath;
}

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

export class TeamManager {
  private outputBuffers: Map<number, OutputBuffer> = new Map();
  private childProcesses: Map<number, ChildProcess> = new Map();
  private stdinPipes: Map<number, Writable> = new Map();
  private parsedEvents: Map<number, StreamEvent[]> = new Map();
  private _processingQueue = new Set<number>();

  // -------------------------------------------------------------------------
  // launch — create worktree, copy hooks, spawn Claude Code
  // -------------------------------------------------------------------------

  async launch(
    projectId: number,
    issueNumber: number,
    issueTitle?: string,
    prompt?: string,
    headless?: boolean,
  ): Promise<Team> {
    const db = getDatabase();

    // Look up project to get repo_path, github_repo, name
    const project = db.getProject(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    console.log(`[TeamManager] Launch started: project=${project.name} issue=#${issueNumber}`);

    // Check active team limit before proceeding
    const activeCount = db.getActiveTeamCountByProject(projectId);
    if (activeCount >= project.maxActiveTeams) {
      // Queue this team instead of launching
      return this.queueTeam(db, project, projectId, issueNumber, issueTitle, headless);
    }

    // If no title provided, fetch from GitHub
    if (!issueTitle && project.githubRepo) {
      try {
        const result = execSync(
          `gh issue view ${issueNumber} --repo ${project.githubRepo} --json title --jq .title`,
          { encoding: 'utf-8', timeout: 10000 },
        ).trim();
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

    // ── Step 1: Insert or reuse team record in DB (status: queued) ──
    // Team appears in FleetGrid immediately at this point.
    const now = new Date().toISOString();
    let team: Team;

    if (relaunchTeamId !== null) {
      // Relaunch: reset the existing terminal team record
      console.log(`[TeamManager] Relaunching existing team record: id=${relaunchTeamId}, worktree=${worktreeName}`);
      db.updateTeam(relaunchTeamId, {
        status: 'queued',
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
        status: 'queued',
        phase: 'init',
        launchedAt: now,
      });
    }

    console.log(`[TeamManager] Team queued: id=${team.id}, status=queued, relaunch=${relaunchTeamId !== null}`);

    // Broadcast immediately so the team appears in the grid right away
    this.broadcastSnapshot();

    // ── Step 2: Create git worktree in the PROJECT's repo ──
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
          console.error(`[TeamManager] ERROR: Worktree creation failed for team ${team.id}: ${msg}`);
          db.updateTeam(team.id, { status: 'failed', stoppedAt: new Date().toISOString() });
          this.broadcastSnapshot();
          throw new Error(`Failed to create worktree: ${msg}`);
        }
      }
    }

    console.log(`[TeamManager] Worktree created: ${worktreeName} at ${worktreeAbsPath}`);

    // Update team status to launching now that worktree exists
    db.updateTeam(team.id, { status: 'launching' });
    this.broadcastSnapshot();

    // ── Step 3: Copy hook scripts from FC's own hooks/ directory into worktree ──
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

    console.log(`[TeamManager] Hooks copied to worktree`);

    // Generate settings.json from example
    const settingsExamplePath = path.join(hookSrcDir, 'settings.json.example');
    const settingsDestDir = path.join(worktreeAbsPath, '.claude');
    const settingsDestPath = path.join(settingsDestDir, 'settings.json');

    fs.mkdirSync(settingsDestDir, { recursive: true });

    if (fs.existsSync(settingsExamplePath)) {
      fs.copyFileSync(settingsExamplePath, settingsDestPath);
    }

    // ── Step 4: Spawn Claude Code process ──
    const resolvedPrompt = prompt || this.resolvePromptFromFile(project, issueNumber);

    // Resolve headless flag — default to true if not specified
    const isHeadless = headless !== false;

    // Build claude args
    const args: string[] = [];
    args.push('--worktree', worktreeName);

    // Only add --output-format for headless mode; interactive terminals need
    // normal ANSI output so the user can read the Claude Code UI.
    if (isHeadless) {
      args.push('--input-format', 'stream-json');   // Bidirectional: receive messages via stdin
      args.push('--output-format', 'stream-json');  // Structured NDJSON output
      args.push('--verbose');  // Required when using stream-json with prompt (--print mode)
    }

    if (config.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    // In headless mode, the initial prompt is sent via stdin (not as positional arg)
    // so that the process stays alive for follow-up messages.
    if (!isHeadless) {
      args.push(resolvedPrompt);
    }

    // Build spawn environment — inherit everything from the server process
    // and auto-detect Git Bash so Claude Code can find it on Windows.
    const spawnEnv: Record<string, string | undefined> = {
      ...process.env,
      FLEET_TEAM_ID: worktreeName,
      FLEET_PROJECT_ID: String(projectId),
      FLEET_GITHUB_REPO: project.githubRepo ?? '',
    };
    const gitBash = findGitBash();
    if (gitBash) {
      spawnEnv['CLAUDE_CODE_GIT_BASH_PATH'] = gitBash;
      console.log(`[TeamManager] CLAUDE_CODE_GIT_BASH_PATH=${gitBash}`);
    }

    // Resolve the full path to claude executable (needed for shell-free spawn on Windows)
    const claudePath = resolveClaudePath();
    console.log(`[TeamManager] Spawning: ${claudePath} ${args.join(' ')} (headless=${isHeadless})`);

    if (!isHeadless && process.platform === 'win32') {
      // ── Interactive mode (Windows): open Claude Code in a new terminal ──
      const fullCmd = `${config.claudeCmd} ${args.join(' ')}`;
      const windowTitle = `Team ${worktreeName}`;

      // The inner command sets up the environment and launches Claude Code
      // inside the new terminal window. cmd.exe /k keeps it open after exit.
      const innerCommand = `cd /d "${worktreeAbsPath}" && set CLAUDE_CODE_GIT_BASH_PATH=${gitBash || ''} && set FLEET_TEAM_ID=${worktreeName} && set FLEET_PROJECT_ID=${projectId} && ${fullCmd}`;

      // Determine which terminal to use based on config.terminalCmd:
      //   'auto' — try wt.exe, fall back to cmd.exe
      //   'wt'   — force Windows Terminal
      //   'cmd'  — force classic cmd.exe
      const termPref = config.terminalCmd;
      let useWindowsTerminal = false;

      if (termPref === 'wt') {
        useWindowsTerminal = true;
      } else if (termPref === 'auto') {
        try {
          execSync('where wt.exe', { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] });
          useWindowsTerminal = true;
        } catch {
          // wt.exe not found — fall back to cmd.exe
          useWindowsTerminal = false;
        }
      }
      // termPref === 'cmd' leaves useWindowsTerminal = false

      let startCommand: string;
      if (useWindowsTerminal) {
        // Windows Terminal: open in a new tab with a descriptive title.
        // wt.exe new-tab runs inside the existing WT instance (or launches
        // a new one), giving users tabbed terminals, better fonts, and
        // dark-theme support.
        startCommand = `wt.exe new-tab --title "${windowTitle}" cmd.exe /k "${innerCommand}"`;
      } else {
        // Classic cmd.exe via `start`:
        // CRITICAL: The first quoted string is ALWAYS interpreted as the window
        // title by `start`. We must pass the full command as one string to
        // cmd.exe /c, because:
        //   1. Node's spawn() on Windows auto-quotes arguments containing spaces,
        //      which double-quotes our already-quoted title (""Team kea-765""),
        //      causing `start` to misparse it and try to open "kea-765" as a file.
        //   2. The && in the inner command gets interpreted by the outer cmd.exe
        //      as a command separator unless the whole thing is properly wrapped.
        startCommand = `start "${windowTitle}" cmd.exe /k "${innerCommand}"`;
      }

      console.log(`[TeamManager] Interactive spawn command (terminal=${useWindowsTerminal ? 'wt' : 'cmd'}): ${startCommand}`);

      const interactiveChild = spawn(startCommand, [], {
        env: spawnEnv,
        shell: true,
        detached: true,
        stdio: 'ignore',
      });
      interactiveChild.unref();

      console.log(`[TeamManager] Interactive window opened for team ${team.id} (worktree: ${worktreeName})`);

      // We can't capture output or PID in interactive mode (the `start` command
      // creates a separate process tree), but hooks still POST to the server
      // independently so phase transitions and events will still work.
      db.updateTeam(team.id, { status: 'running' });
      this.broadcastSnapshot();

      // Broadcast launch event
      sseBroker.broadcast(
        'team_launched',
        { team_id: team.id, issue_number: issueNumber, project_id: projectId },
        team.id,
      );

      return db.getTeam(team.id)!;
    }

    // ── Headless mode (default): spawn in background, capture output ──
    // IMPORTANT: Do NOT use shell: true here. On Windows, shell: true wraps the
    // spawn in cmd.exe, creating node → cmd.exe → claude.exe. The stdout pipe
    // connects to cmd.exe, not claude.exe, so Claude's NDJSON output never
    // reaches our capture handler. Instead, we resolve the full path to the
    // claude executable and spawn it directly.
    //
    // stdin is 'pipe' so we can send messages via --input-format stream-json.
    const child = spawn(claudePath, args, {
      cwd: project.repoPath,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Detach so parent can exit without killing children (if needed)
      detached: false,
    });

    const pid = child.pid;
    if (pid === undefined) {
      console.error(`[TeamManager] ERROR: spawn failed for team ${team.id}: no PID returned`);
      db.updateTeam(team.id, { status: 'failed', stoppedAt: new Date().toISOString() });
      this.broadcastSnapshot();
      throw new Error('Failed to spawn Claude Code process — no PID returned');
    }

    console.log(`[TeamManager] Process spawned: PID ${pid}`);

    // Update team with PID (status stays 'launching' until first event)
    db.updateTeam(team.id, { pid });
    this.broadcastSnapshot();

    // Store child process reference
    this.childProcesses.set(team.id, child);

    // Store stdin pipe for bidirectional messaging
    if (child.stdin) {
      this.stdinPipes.set(team.id, child.stdin);

      // Send the initial prompt via stdin (not as positional arg) so the
      // process stays alive for follow-up messages from the PM.
      this.writeStdinMessage(child.stdin, resolvedPrompt);
      console.log(`[TeamManager] Initial prompt sent via stdin for team ${team.id}`);
    }

    // Set up output capture
    this.initOutputBuffer(team.id);
    this.captureOutput(team.id, child);

    // Handle process exit
    child.on('exit', (code, signal) => {
      console.log(`[TeamManager] Process exited for team ${team.id} (code=${code}, signal=${signal})`);
      this.childProcesses.delete(team.id);
      this.stdinPipes.delete(team.id);
      this.outputBuffers.delete(team.id);
      this.parsedEvents.delete(team.id);

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

      // Process queue when a slot frees up
      if (currentTeam.projectId) {
        this.processQueue(currentTeam.projectId).catch((err) => {
          console.error(`[TeamManager] processQueue error after team exit:`, err);
        });
      }
    });

    child.on('error', (err) => {
      console.error(`[TeamManager] ERROR: process error for team ${team.id}:`, err.message);
      this.childProcesses.delete(team.id);
      this.stdinPipes.delete(team.id);
      this.outputBuffers.delete(team.id);
      this.parsedEvents.delete(team.id);

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

      // Process queue when a slot frees up
      if (currentTeam.projectId) {
        this.processQueue(currentTeam.projectId).catch((queueErr) => {
          console.error(`[TeamManager] processQueue error after team error:`, queueErr);
        });
      }
    });

    // Broadcast launch event
    sseBroker.broadcast(
      'team_launched',
      { team_id: team.id, issue_number: issueNumber, project_id: projectId },
      team.id,
    );

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

    // Queued teams have no process — just cancel them directly
    if (team.status === 'queued') {
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
    this.childProcesses.delete(teamId);
    this.outputBuffers.delete(teamId);
    this.parsedEvents.delete(teamId);

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

    // Build args with --resume and bidirectional streaming
    const args: string[] = [];
    args.push('--resume', '--worktree', team.worktreeName);
    args.push('--input-format', 'stream-json');   // Bidirectional: receive messages via stdin
    args.push('--output-format', 'stream-json');  // Structured NDJSON output
    args.push('--verbose');  // Required when using stream-json with prompt (--print mode)

    if (config.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    // Update status to launching
    db.updateTeam(teamId, {
      status: 'launching',
      launchedAt: new Date().toISOString(),
      stoppedAt: null,
    });

    // Build spawn environment with Git Bash auto-detection (same as launch)
    const resumeEnv: Record<string, string | undefined> = {
      ...process.env,
      FLEET_TEAM_ID: team.worktreeName,
      FLEET_PROJECT_ID: String(project.id),
      FLEET_GITHUB_REPO: project.githubRepo ?? '',
    };
    const resumeGitBash = findGitBash();
    if (resumeGitBash) {
      resumeEnv['CLAUDE_CODE_GIT_BASH_PATH'] = resumeGitBash;
      console.log(`[TeamManager] Resume: CLAUDE_CODE_GIT_BASH_PATH=${resumeGitBash}`);
    }

    // Resolve full path to claude executable — do NOT use shell: true (see
    // headless spawn comment above for why cmd.exe wrapper breaks stdout capture).
    const claudePath = resolveClaudePath();
    console.log(`[TeamManager] Resume spawning: ${claudePath} ${args.join(' ')}`);

    const child = spawn(claudePath, args, {
      cwd: project.repoPath,
      env: resumeEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
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

    // Store stdin pipe for bidirectional messaging
    if (child.stdin) {
      this.stdinPipes.set(teamId, child.stdin);
      console.log(`[TeamManager] Stdin pipe stored for resumed team ${teamId}`);
    }

    // Set up output capture
    this.initOutputBuffer(teamId);
    this.captureOutput(teamId, child);

    // Handle process exit
    child.on('exit', (code, _signal) => {
      console.log(`[TeamManager] Resume process exited for team ${teamId} (code=${code})`);
      this.childProcesses.delete(teamId);
      this.stdinPipes.delete(teamId);
      this.outputBuffers.delete(teamId);
      this.parsedEvents.delete(teamId);

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

      // Process queue when a slot frees up
      if (currentTeam.projectId) {
        this.processQueue(currentTeam.projectId).catch((err) => {
          console.error(`[TeamManager] processQueue error after resume exit:`, err);
        });
      }
    });

    child.on('error', (err) => {
      console.error(`[TeamManager] Resume process error for team ${teamId}:`, err);
      this.childProcesses.delete(teamId);
      this.stdinPipes.delete(teamId);
      this.outputBuffers.delete(teamId);
      this.parsedEvents.delete(teamId);

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

      // Process queue when a slot frees up
      if (currentTeam.projectId) {
        this.processQueue(currentTeam.projectId).catch((queueErr) => {
          console.error(`[TeamManager] processQueue error after resume error:`, queueErr);
        });
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
  ): Promise<Team> {
    // Fetch title from GitHub if needed
    if (!issueTitle && project.githubRepo) {
      try {
        const result = execSync(
          `gh issue view ${issueNumber} --repo ${project.githubRepo} --json title --jq .title`,
          { encoding: 'utf-8', timeout: 10000 },
        ).trim();
        if (result) issueTitle = result;
      } catch {
        issueTitle = `Issue #${issueNumber}`;
      }
    } else if (!issueTitle) {
      issueTitle = `Issue #${issueNumber}`;
    }

    const slug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const worktreeName = `${slug}-${issueNumber}`;
    const branchName = `worktree-${slug}-${issueNumber}`;

    // Check for existing team
    const existing = db.getTeamByWorktree(worktreeName);
    if (existing) {
      if (['running', 'launching', 'idle', 'stuck', 'queued'].includes(existing.status)) {
        throw new Error(`Team already active for issue ${issueNumber} (status: ${existing.status})`);
      }
      // Terminal state — reuse the existing team record as queued
      const now = new Date().toISOString();
      db.updateTeam(existing.id, {
        status: 'queued',
        phase: 'init',
        pid: null,
        sessionId: null,
        issueTitle: issueTitle ?? null,
        launchedAt: now,
        stoppedAt: null,
        lastEventAt: null,
      });
      const team = db.getTeam(existing.id)!;
      const activeCount = db.getActiveTeamCountByProject(projectId);
      console.log(`[TeamManager] Team ${team.id} queued (${activeCount}/${project.maxActiveTeams} active)`);
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
      launchedAt: now,
    });

    const activeCount = db.getActiveTeamCountByProject(projectId);
    console.log(`[TeamManager] Team ${team.id} queued (${activeCount}/${project.maxActiveTeams} active)`);
    this.broadcastSnapshot();
    return team;
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

      const activeCount = db.getActiveTeamCountByProject(projectId);
      const available = project.maxActiveTeams - activeCount;
      if (available <= 0) return;

      const queued = db.getQueuedTeamsByProject(projectId);
      const toDequeue = queued.slice(0, available);

      for (const team of toDequeue) {
        console.log(`[TeamManager] Dequeuing team ${team.id} (${team.worktreeName})`);
        // Mark as launching BEFORE releasing the guard, so concurrent calls
        // see this team as active (counted towards the active limit).
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

    // ── Step 1: Create git worktree ──
    if (!fs.existsSync(worktreeAbsPath)) {
      try {
        execSync(
          `git -C "${project.repoPath}" worktree add "${worktreeRelPath}" -b "${branchName}"`,
          { encoding: 'utf-8', stdio: 'pipe' },
        );
      } catch {
        try {
          execSync(
            `git -C "${project.repoPath}" worktree add "${worktreeRelPath}" "${branchName}"`,
            { encoding: 'utf-8', stdio: 'pipe' },
          );
        } catch (err2: unknown) {
          const msg = err2 instanceof Error ? err2.message : String(err2);
          console.error(`[TeamManager] ERROR: Worktree creation failed for queued team ${team.id}: ${msg}`);
          db.updateTeam(team.id, { status: 'failed', stoppedAt: new Date().toISOString() });
          this.broadcastSnapshot();
          return;
        }
      }
    }

    console.log(`[TeamManager] Worktree created for dequeued team: ${team.worktreeName}`);

    // Update to launching
    db.updateTeam(team.id, { status: 'launching' });
    this.broadcastSnapshot();

    // ── Step 2: Copy hooks ──
    const hookSrcDir = config.fcHooksDir;
    const hookDestDir = path.join(worktreeAbsPath, config.hookDir);
    fs.mkdirSync(hookDestDir, { recursive: true });

    if (fs.existsSync(hookSrcDir)) {
      const hookFiles = fs.readdirSync(hookSrcDir).filter((f) => f.endsWith('.sh'));
      for (const file of hookFiles) {
        const src = path.join(hookSrcDir, file);
        const dest = path.join(hookDestDir, file);
        fs.copyFileSync(src, dest);
        if (process.platform !== 'win32') {
          fs.chmodSync(dest, 0o755);
        }
      }
    }

    // Generate settings.json from example
    const settingsExamplePath = path.join(hookSrcDir, 'settings.json.example');
    const settingsDestDir = path.join(worktreeAbsPath, '.claude');
    const settingsDestPath = path.join(settingsDestDir, 'settings.json');
    fs.mkdirSync(settingsDestDir, { recursive: true });
    if (fs.existsSync(settingsExamplePath)) {
      fs.copyFileSync(settingsExamplePath, settingsDestPath);
    }

    // ── Step 3: Spawn Claude Code ──
    const resolvedPrompt = this.resolvePromptFromFile(project, team.issueNumber);
    const args: string[] = [];
    args.push('--worktree', team.worktreeName);
    args.push('--input-format', 'stream-json');   // Bidirectional: receive messages via stdin
    args.push('--output-format', 'stream-json');
    args.push('--verbose');

    if (config.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    // Initial prompt is sent via stdin, not as positional arg

    const spawnEnv: Record<string, string | undefined> = {
      ...process.env,
      FLEET_TEAM_ID: team.worktreeName,
      FLEET_PROJECT_ID: String(projectId),
      FLEET_GITHUB_REPO: project.githubRepo ?? '',
    };
    const gitBash = findGitBash();
    if (gitBash) {
      spawnEnv['CLAUDE_CODE_GIT_BASH_PATH'] = gitBash;
    }

    const claudePath = resolveClaudePath();
    console.log(`[TeamManager] Spawning dequeued team ${team.id}: ${claudePath} ${args.join(' ')}`);

    const child = spawn(claudePath, args, {
      cwd: project.repoPath,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    const pid = child.pid;
    if (pid === undefined) {
      console.error(`[TeamManager] ERROR: spawn failed for dequeued team ${team.id}: no PID returned`);
      db.updateTeam(team.id, { status: 'failed', stoppedAt: new Date().toISOString() });
      this.broadcastSnapshot();
      return;
    }

    console.log(`[TeamManager] Dequeued team ${team.id} spawned: PID ${pid}`);
    db.updateTeam(team.id, { pid });
    this.broadcastSnapshot();

    this.childProcesses.set(team.id, child);

    // Store stdin pipe and send initial prompt
    if (child.stdin) {
      this.stdinPipes.set(team.id, child.stdin);
      this.writeStdinMessage(child.stdin, resolvedPrompt);
      console.log(`[TeamManager] Initial prompt sent via stdin for dequeued team ${team.id}`);
    }

    this.initOutputBuffer(team.id);
    this.captureOutput(team.id, child);

    // Handle process exit — trigger queue processing
    child.on('exit', (code, signal) => {
      console.log(`[TeamManager] Process exited for dequeued team ${team.id} (code=${code}, signal=${signal})`);
      this.childProcesses.delete(team.id);
      this.stdinPipes.delete(team.id);
      this.outputBuffers.delete(team.id);
      this.parsedEvents.delete(team.id);

      const currentTeam = db.getTeam(team.id);
      if (!currentTeam) return;

      if (['launching', 'running', 'idle', 'stuck'].includes(currentTeam.status)) {
        const exitStatus = (code === 0) ? 'done' : 'failed';
        db.updateTeam(team.id, {
          status: exitStatus,
          pid: null,
          stoppedAt: new Date().toISOString(),
        });

        sseBroker.broadcast('team_stopped', { team_id: team.id }, team.id);
        this.broadcastSnapshot();
      }

      // Process queue when a slot frees up
      if (currentTeam.projectId) {
        this.processQueue(currentTeam.projectId).catch((err) => {
          console.error(`[TeamManager] processQueue error after dequeued team exit:`, err);
        });
      }
    });

    child.on('error', (err) => {
      console.error(`[TeamManager] ERROR: process error for dequeued team ${team.id}:`, err.message);
      this.childProcesses.delete(team.id);
      this.stdinPipes.delete(team.id);
      this.outputBuffers.delete(team.id);
      this.parsedEvents.delete(team.id);

      const currentTeam = db.getTeam(team.id);
      if (!currentTeam) return;

      if (['launching', 'running', 'idle', 'stuck'].includes(currentTeam.status)) {
        db.updateTeam(team.id, {
          status: 'failed',
          pid: null,
          stoppedAt: new Date().toISOString(),
        });

        sseBroker.broadcast('team_stopped', { team_id: team.id }, team.id);
        this.broadcastSnapshot();
      }

      // Process queue when a slot frees up
      if (currentTeam.projectId) {
        this.processQueue(currentTeam.projectId).catch((queueErr) => {
          console.error(`[TeamManager] processQueue error after dequeued team error:`, queueErr);
        });
      }
    });

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
    return this.parsedEvents.get(teamId) ?? [];
  }

  // -------------------------------------------------------------------------
  // sendMessage — deliver a PM message to a running team via stdin
  // -------------------------------------------------------------------------

  sendMessage(teamId: number, message: string): boolean {
    const stdin = this.stdinPipes.get(teamId);
    if (!stdin || stdin.destroyed) return false;

    try {
      this.writeStdinMessage(stdin, message);
      console.log(`[TeamManager] Message sent to team ${teamId}: ${message.substring(0, 100)}`);
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
    const fallback = `Read the ENTIRE file .claude/prompts/fleet-workflow.md before taking any actions.\nYou are the TL. Create a team and spawn the CORE team (Coordinator + analyst + dev + reviewer) as described in the workflow.\nIssue: #${issueNumber}`;
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

            // Store parsed event with timestamp
            const timestampedEvent: StreamEvent = {
              ...event,
              timestamp: new Date().toISOString(),
            };
            events.push(timestampedEvent);
            if (events.length > MAX_PARSED_EVENTS) {
              events.shift();
            }

            // Extract cost from result events and persist as usage snapshot
            if (event.type === 'result' && (event as any).total_cost_usd != null) {
              const costUsd = (event as any).total_cost_usd as number;
              const usage = (event as any).usage as Record<string, unknown> | undefined;
              const sessionId = (event as any).session_id as string | undefined;

              console.log(`[TeamManager] Team ${teamId} cost: $${costUsd.toFixed(4)}`);

              db.insertUsageSnapshot({
                teamId,
                sessionId: sessionId || undefined,
                dailyPercent: 0,
                weeklyPercent: 0,
                sonnetPercent: 0,
                extraPercent: 0,
                rawOutput: JSON.stringify({ total_cost_usd: costUsd, usage }),
              });

              sseBroker.broadcast('usage_updated', {
                daily_percent: 0,
                weekly_percent: 0,
                sonnet_percent: 0,
                extra_percent: 0,
              }, teamId);
            }

            // Broadcast interesting events via SSE
            if (['assistant', 'tool_use', 'tool_result', 'result'].includes(event.type)) {
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
            const timestampedEvent: StreamEvent = {
              ...event,
              timestamp: new Date().toISOString(),
            };
            events.push(timestampedEvent);
            if (events.length > MAX_PARSED_EVENTS) {
              events.shift();
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
