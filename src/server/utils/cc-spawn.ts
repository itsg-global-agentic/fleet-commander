// =============================================================================
// Fleet Commander — Unified Claude Code Spawn Module
// =============================================================================
// Single entry-point for all CC process spawning: headless (stream-json),
// interactive (terminal window), and query (-p one-shot) modes.
//
// Design goals:
//   1. All spawn-environment construction in one place (buildEnv).
//   2. All CLI-arg construction in one place (build*Args helpers).
//   3. Interactive mode on Windows writes a temp .cmd file, eliminating the
//      cmd.exe quoting bug where prompt text containing %, ", &, | etc.
//      breaks shell argument parsing.
//   4. Headless mode uses execa for improved Windows cross-spawn support.
//   5. Pure helper exports (buildEnv, build*Args, escapeCmdArg) are
//      independently testable without spawning any process.
// =============================================================================

import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execa } from 'execa';
import config from '../config.js';
import { resolveClaudePath } from './resolve-claude-path.js';
import { findGitBash } from './find-git-bash.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * Spawn environment record. Keys with `undefined` values are silently
 * dropped by Node's child_process module before the child process starts.
 */
export type SpawnEnv = Record<string, string | undefined>;

/**
 * Fleet-specific context injected into the spawn environment.
 * Required for team/project-scoped spawns (headless and interactive modes).
 * Omit for context-free spawns (query mode has no team association).
 */
export interface FleetEnvContext {
  /** Worktree name, e.g. "my-project-42". Set as FLEET_TEAM_ID. */
  teamId: string;
  /** Numeric project DB row ID. Set as FLEET_PROJECT_ID. */
  projectId: number;
  /** GitHub repo slug, e.g. "owner/repo". Set as FLEET_GITHUB_REPO. */
  githubRepo: string;
}

// ---------------------------------------------------------------------------
// buildEnv — single source of truth for all CC spawn environments
// ---------------------------------------------------------------------------

/**
 * Build the spawn environment for a Claude Code process.
 *
 * Starts from a shallow copy of `process.env` and adds/overrides:
 *   - `FLEET_TEAM_ID`, `FLEET_PROJECT_ID`, `FLEET_GITHUB_REPO`
 *     when `fleetContext` is provided (headless and interactive modes).
 *   - `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` — set to `'1'` or `undefined`
 *     based on `config.enableAgentTeams`. Explicitly setting `undefined`
 *     prevents accidental inheritance from the outer server process.
 *   - `CLAUDE_CODE_GIT_BASH_PATH` — Windows only; auto-detected via
 *     `findGitBash()`. Required by CC to locate bash.exe for hook scripts.
 *
 * @param fleetContext - Optional fleet team/project context. Omit for query
 *   mode which runs without a team association.
 */
export function buildEnv(fleetContext?: FleetEnvContext): SpawnEnv {
  const env: SpawnEnv = { ...process.env };

  if (fleetContext) {
    env['FLEET_TEAM_ID'] = fleetContext.teamId;
    env['FLEET_PROJECT_ID'] = String(fleetContext.projectId);
    env['FLEET_GITHUB_REPO'] = fleetContext.githubRepo;
  }

  // Explicitly set or clear the agent-teams flag so it is never accidentally
  // inherited from the outer server process with a stale value.
  if (config.enableAgentTeams) {
    env['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'] = '1';
  } else {
    env['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'] = undefined;
  }

  // Absolute path to the shared hooks.log file. Hook scripts read this env
  // var instead of computing a fragile relative path from their own location.
  env['FLEET_HOOK_LOG'] = config.hookLogPath;

  // Windows: CC requires git-bash for hook execution. Auto-detect the path
  // so CC can find bash.exe even when Fleet Commander is started from a
  // non-Git-Bash terminal (e.g. cmd.exe or PowerShell).
  const gitBash = findGitBash();
  if (gitBash) {
    env['CLAUDE_CODE_GIT_BASH_PATH'] = gitBash;
  }

  return env;
}

// ---------------------------------------------------------------------------
// Arg builders — pure functions, one per spawn mode
// ---------------------------------------------------------------------------

/** Options for building headless (stream-json) CLI args. */
export interface HeadlessArgsOptions {
  worktreeName: string;
  resume?: boolean;
  model?: string | null;
}

/**
 * Options for building interactive (terminal window) CLI args.
 *
 * The initial prompt is intentionally excluded — it is handled separately
 * by `spawnInteractive()` via the temp .cmd launcher file.
 */
export interface InteractiveArgsOptions {
  worktreeName: string;
  model?: string | null;
}

/** Options for building query (-p one-shot) CLI args. */
export interface QueryArgsOptions {
  prompt: string;
  jsonSchema: Record<string, unknown>;
  maxTurns?: number;
  model?: string;
}

/**
 * Build CLI args for headless (stream-json) mode.
 *
 * Produces:
 *   `[--resume] --worktree <name> [--dangerously-skip-permissions]
 *    [--model <m>] --input-format stream-json --output-format stream-json
 *    --verbose --include-partial-messages`
 */
export function buildHeadlessArgs(options: HeadlessArgsOptions): string[] {
  const args: string[] = [];

  if (options.resume) {
    args.push('--resume');
  }

  args.push('--worktree', options.worktreeName);

  if (config.skipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  if (options.model) {
    args.push('--model', options.model);
  }

  args.push(
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
  );

  return args;
}

/**
 * Build CLI args for interactive (terminal window) mode.
 *
 * The initial prompt is intentionally NOT included here. `spawnInteractive()`
 * appends it as the last argument inside the temp .cmd launcher file to
 * avoid all cmd.exe quoting hazards with arbitrary prompt text.
 *
 * Produces:
 *   `--worktree <name> [--dangerously-skip-permissions] [--model <m>]`
 */
export function buildInteractiveArgs(options: InteractiveArgsOptions): string[] {
  const args: string[] = [];

  args.push('--worktree', options.worktreeName);

  if (config.skipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  if (options.model) {
    args.push('--model', options.model);
  }

  return args;
}

/**
 * Build CLI args for query (-p one-shot) mode.
 *
 * Produces:
 *   `-p <prompt> --output-format json --no-session-persistence
 *    --max-turns <n> --model <m> --tools '' --strict-mcp-config
 *    --disable-slash-commands --json-schema <schema>`
 */
export function buildQueryArgs(options: QueryArgsOptions): string[] {
  return [
    '-p', options.prompt,
    '--output-format', 'json',
    '--no-session-persistence',
    '--max-turns', String(options.maxTurns ?? config.ccQueryMaxTurns),
    '--model', options.model ?? config.ccQueryModel,
    '--tools', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--json-schema', JSON.stringify(options.jsonSchema),
  ];
}

// ---------------------------------------------------------------------------
// Headless spawn
// ---------------------------------------------------------------------------

/** Options for `spawnHeadless()` / `spawnClaude({ mode: 'headless', ... })`. */
export interface HeadlessSpawnOptions {
  mode: 'headless';
  /** Absolute path to the git worktree directory. Becomes the cwd for CC. */
  cwd: string;
  /** Worktree name passed to --worktree. Must match the git worktree name. */
  worktreeName: string;
  /** Fleet team/project context for FLEET_* env vars. */
  fleetContext: FleetEnvContext;
  /** Pass --resume to continue a previous CC session. */
  resume?: boolean;
  /** Optional model override from project config. */
  model?: string | null;
}

/**
 * Spawn Claude Code in headless (stream-json) mode.
 *
 * Uses `execa` instead of raw `child_process.spawn` for improved Windows
 * support: cross-spawn internally handles PATHEXT resolution and produces
 * better error messages on spawn failure.
 *
 * Key options:
 *   - `buffer: false` — output is NOT buffered; callers attach stream data
 *     event handlers directly. Mandatory for stream-json mode where output
 *     can be unbounded.
 *   - `reject: false` — non-zero exit does NOT throw; callers handle via the
 *     `'exit'` event. This matches team-manager's existing error handling.
 *   - `extendEnv: false` — prevents double-merging since `buildEnv()` already
 *     contains the full `process.env`.
 *
 * The returned value is cast to `ChildProcess`. The execa `Subprocess` type is
 * structurally assignable to `ChildProcess` (defined as
 * `Omit<ChildProcess, overlapping-keys> & ExecaCustomSubprocess`), so the cast
 * is sound. Callers access `.pid`, `.stdin`, `.stdout`, `.stderr`, `.kill()`,
 * `.on('exit')`, and `.on('error')` — all present on `Subprocess`.
 *
 * @returns The running subprocess. Check `.pid !== undefined` before use.
 */
export function spawnHeadless(options: HeadlessSpawnOptions): ChildProcess {
  const claudePath = resolveClaudePath();
  const args = buildHeadlessArgs({
    worktreeName: options.worktreeName,
    resume: options.resume,
    model: options.model,
  });
  const env = buildEnv(options.fleetContext);

  console.log(
    `[cc-spawn] headless: worktree=${options.worktreeName}` +
    ` resume=${!!options.resume} model=${options.model ?? 'default'}` +
    ` cwd=${options.cwd}`,
  );

  const subprocess = execa(claudePath, args, {
    cwd: options.cwd,
    // SpawnEnv is Record<string,string|undefined>; execa env is Partial<Record<string,string>>.
    // The types are equivalent; cast strips the union for TypeScript.
    env: env as Record<string, string>,
    extendEnv: false,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    buffer: false,
    reject: false,
    windowsHide: true,
    detached: false,
  });

  return subprocess as unknown as ChildProcess;
}

// ---------------------------------------------------------------------------
// Interactive spawn helpers
// ---------------------------------------------------------------------------

/**
 * Escape a string for use as a double-quoted argument in a Windows cmd.exe
 * script (.cmd / .bat file).
 *
 * Transformations applied:
 *   1. Wraps the value in double-quotes.
 *   2. Each embedded `"` → `""` (cmd.exe in-quote escape convention).
 *   3. Each `%` → `%%` to prevent environment-variable expansion at parse time.
 *
 * Characters NOT escaped here (not special inside cmd.exe double-quoted tokens):
 *   `^`, `&`, `|`, `<`, `>`, `(`, `)` — these are only cmd metacharacters
 *   when they appear outside of double-quoted strings.
 *
 * @example
 * escapeCmdArg('hello world')          // => '"hello world"'
 * escapeCmdArg('say "hi"')             // => '"say ""hi"""'
 * escapeCmdArg('100% done')            // => '"100%% done"'
 * escapeCmdArg('C:\\Program Files\\x') // => '"C:\\Program Files\\x"'
 */
export function escapeCmdArg(s: string): string {
  return '"' + s.replace(/"/g, '""').replace(/%/g, '%%') + '"';
}

/**
 * Detect whether wt.exe (Windows Terminal) is available on PATH.
 * Returns false immediately on non-Windows platforms.
 */
async function detectWindowsTerminal(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    await execa('where', ['wt.exe'], {
      timeout: 3000,
      reject: true,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a self-contained .cmd launcher file to the system temp directory.
 *
 * The file embeds the full worktree path, all FLEET_* and CLAUDE_CODE_*
 * env vars, and the complete claude command with every argument properly
 * escaped for cmd.exe.
 *
 * File structure (CRLF line endings):
 * ```bat
 * @echo off
 *
 * cd /d "C:\path\to\worktree"
 *
 * SET "FLEET_TEAM_ID=project-42"
 * SET "FLEET_PROJECT_ID=7"
 * SET "CLAUDE_CODE_GIT_BASH_PATH=C:\Program Files\Git\bin\bash.exe"
 *
 * "C:\path\to\claude.exe" "--worktree" "project-42" "--dangerously-skip-permissions" "prompt text..."
 * ```
 *
 * Using a .cmd file instead of inlining into a shell string eliminates ALL
 * cmd.exe quoting issues for prompt text containing %, ", &, |, (, ), <, >.
 *
 * @returns Absolute path to the written .cmd file.
 */
function writeLauncherCmdFile(params: {
  worktreePath: string;
  claudePath: string;
  claudeArgs: string[];
  prompt: string;
  env: SpawnEnv;
}): string {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const cmdFilePath = path.join(os.tmpdir(), `fleet-cc-${stamp}.cmd`);

  const lines: string[] = [];
  lines.push('@echo off');
  lines.push('');
  lines.push(`cd /d ${escapeCmdArg(params.worktreePath)}`);
  lines.push('');

  // Emit SET commands only for FLEET_* and CLAUDE_CODE_* vars. The outer
  // quotes on SET "KEY=VALUE" delimit the assignment; cmd.exe stores the
  // value without the outer quotes. Any " inside the value must be doubled.
  const envPrefixes = ['FLEET_', 'CLAUDE_CODE_'];
  for (const [key, value] of Object.entries(params.env)) {
    if (value !== undefined && envPrefixes.some((p) => key.startsWith(p))) {
      lines.push(`SET "${key}=${value.replace(/"/g, '""')}"`);
    }
  }
  lines.push('');

  // Build the claude invocation with every argument independently escaped
  const cmdParts = [
    escapeCmdArg(params.claudePath),
    ...params.claudeArgs.map(escapeCmdArg),
    escapeCmdArg(params.prompt),
  ];
  lines.push(cmdParts.join(' '));

  // CRLF line endings for cmd.exe compatibility
  fs.writeFileSync(cmdFilePath, lines.join('\r\n'), { encoding: 'utf8' });
  return cmdFilePath;
}

// ---------------------------------------------------------------------------
// Interactive spawn
// ---------------------------------------------------------------------------

/** Options for `spawnInteractive()` / `spawnClaude({ mode: 'interactive', ... })`. */
export interface InteractiveSpawnOptions {
  mode: 'interactive';
  /** Absolute path to the worktree directory. The terminal window cd's here. */
  cwd: string;
  /** Worktree name passed to --worktree. */
  worktreeName: string;
  /** Title shown in the terminal window title bar. */
  windowTitle: string;
  /** Fleet team/project context for FLEET_* env vars. */
  fleetContext: FleetEnvContext;
  /** Optional model override. */
  model?: string | null;
  /**
   * Initial prompt passed to Claude as the last positional argument.
   *
   * May contain arbitrary characters including %, ", &, |, <, >, (, ), ^.
   * Embedded safely into the temp .cmd launcher file — never interpolated
   * into a shell command string.
   */
  prompt: string;
  /**
   * Terminal preference override. Defaults to `config.terminalCmd`.
   *   `'auto'` — try wt.exe first, fall back to cmd.exe
   *   `'wt'`   — force Windows Terminal
   *   `'cmd'`  — force classic cmd.exe
   */
  terminalPref?: 'auto' | 'wt' | 'cmd';
}

/**
 * Spawn Claude Code in interactive (terminal window) mode on Windows.
 *
 * Opens a new terminal window (Windows Terminal or cmd.exe) running the CC
 * CLI inside the worktree directory. The user can see live output and type
 * follow-up messages directly.
 *
 * **Windows quoting bug fix**: The previous implementation interpolated the
 * full prompt string into a shell command string, causing cmd.exe to misparse
 * prompts containing %, ", &, |, (, ), <, >, ^. This implementation writes a
 * temp .cmd file containing the full command with each argument independently
 * escaped. The outer terminal-launch command only receives the safe temp-file
 * path — no user content is present in the shell string.
 *
 * @returns Promise that resolves once the terminal-launcher process has been
 *   spawned and detached. Does NOT await CC session completion.
 */
export async function spawnInteractive(options: InteractiveSpawnOptions): Promise<void> {
  const claudePath = resolveClaudePath();
  const args = buildInteractiveArgs({
    worktreeName: options.worktreeName,
    model: options.model,
  });
  const env = buildEnv(options.fleetContext);

  const cmdFilePath = writeLauncherCmdFile({
    worktreePath: options.cwd,
    claudePath,
    claudeArgs: args,
    prompt: options.prompt,
    env,
  });

  let cleanedUp = false;
  try {
    const termPref = options.terminalPref ?? config.terminalCmd;
    let useWindowsTerminal = false;
    if (termPref === 'wt') {
      useWindowsTerminal = true;
    } else if (termPref === 'auto') {
      useWindowsTerminal = await detectWindowsTerminal();
    }
    // termPref === 'cmd' → useWindowsTerminal remains false

    // Strip `"` from the title; it is embedded inside a `"..."` quoted string
    // in the launch command. Spaces and other printable chars are fine.
    const safeTitle = options.windowTitle.replace(/"/g, '');
    // The .cmd path comes from os.tmpdir() which never contains `"`, so
    // wrapping in double-quotes is sufficient for paths with spaces.
    const quotedCmdFile = `"${cmdFilePath}"`;

    let launchCmd: string;
    if (useWindowsTerminal) {
      launchCmd = `wt.exe new-tab --title "${safeTitle}" cmd.exe /k ${quotedCmdFile}`;
    } else {
      launchCmd = `start "${safeTitle}" cmd.exe /k ${quotedCmdFile}`;
    }

    console.log(
      `[cc-spawn] interactive: terminal=${useWindowsTerminal ? 'wt' : 'cmd'}` +
      ` worktree=${options.worktreeName} launcher=${cmdFilePath}`,
    );

    // shell:true is required so `start` (a cmd builtin) and `wt.exe` (PATH-resolved)
    // work correctly. detached:true lets the window outlive the server process.
    const launcher = spawn(launchCmd, [], {
      env: env as NodeJS.ProcessEnv,
      shell: true,
      detached: true,
      stdio: 'ignore',
    });
    launcher.unref();

    // Best-effort cleanup after 60 s (generous margin for terminal startup)
    setTimeout(() => {
      try { fs.unlinkSync(cmdFilePath); } catch { /* ignore */ }
    }, 60_000);
    cleanedUp = true;
  } finally {
    if (!cleanedUp) {
      try { fs.unlinkSync(cmdFilePath); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Query spawn (one-shot -p mode)
// ---------------------------------------------------------------------------

/** Options for `spawnQuery()` / `spawnClaude({ mode: 'query', ... })`. */
export interface QuerySpawnOptions {
  mode: 'query';
  /** Prompt text passed to CC via the -p flag. */
  prompt: string;
  /** JSON schema for structured output (passed to --json-schema). */
  jsonSchema: Record<string, unknown>;
  /** Max conversation turns. Defaults to `config.ccQueryMaxTurns`. */
  maxTurns?: number;
  /** Model name. Defaults to `config.ccQueryModel`. */
  model?: string;
  /** Kill timeout in milliseconds. Defaults to `config.ccQueryTimeoutMs`. */
  timeoutMs?: number;
  /** Working directory. Defaults to `os.tmpdir()`. */
  cwd?: string;
}

/** Raw result from a query spawn, before JSON parsing or retry logic. */
export interface QuerySpawnResult {
  /** `true` when the process exited with code 0 and was not timed out. */
  exitedOk: boolean;
  /** `true` when the process was killed because it exceeded `timeoutMs`. */
  timedOut: boolean;
  /** Raw stdout — the full CC JSON response payload. */
  stdout: string;
  /** Raw stderr — warnings, debug output, error messages. */
  stderr: string;
  /** Process exit code, or `null` if killed by signal. */
  exitCode: number | null;
  /** Wall-clock duration from spawn to process-close in milliseconds. */
  durationMs: number;
  /**
   * Error thrown by the `spawn()` call itself (e.g. ENOENT if claude is not
   * found on PATH). Present only on spawn failure, not on non-zero exit.
   */
  spawnError?: Error;
}

/**
 * Spawn Claude Code in query (-p) mode and collect all output.
 *
 * Runs the CC process to completion (or timeout) and resolves with raw
 * stdout/stderr. JSON parsing, structured-output extraction, and retry
 * logic are delegated to the caller (`CCQueryService._executeImpl`).
 *
 * Uses raw `child_process.spawn`. All args are built from controlled values
 * (never user-typed freeform text), so cross-platform argument escaping is
 * not a concern. `resolveClaudePath()` already handles Windows executable
 * path resolution.
 *
 * On Windows timeout, the process tree is killed with `taskkill /F /T /PID`
 * rather than SIGKILL (unavailable on Windows).
 *
 * @returns Promise that resolves with the spawn result. Never rejects.
 */
export function spawnQuery(options: QuerySpawnOptions): Promise<QuerySpawnResult> {
  return new Promise<QuerySpawnResult>((resolve) => {
    const start = Date.now();
    const claudePath = resolveClaudePath();
    const args = buildQueryArgs({
      prompt: options.prompt,
      jsonSchema: options.jsonSchema,
      maxTurns: options.maxTurns,
      model: options.model,
    });
    const env = buildEnv(); // no fleet context — query mode is context-free
    const cwd = options.cwd ?? os.tmpdir();
    const effectiveTimeoutMs = options.timeoutMs ?? config.ccQueryTimeoutMs;

    const child = spawn(claudePath, args, {
      cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid === undefined) {
          // spawn failed — no process to kill
        } else if (process.platform === 'win32') {
          // Kill the full process tree; SIGKILL is not available on Windows.
          spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
            stdio: 'pipe',
            windowsHide: true,
          });
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        // Best effort; the process may have already exited
      }
    }, effectiveTimeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      clearTimeout(timeoutHandle);
      resolve({
        exitedOk: !timedOut && code === 0,
        timedOut,
        stdout,
        stderr,
        exitCode: code,
        durationMs: Date.now() - start,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeoutHandle);
      resolve({
        exitedOk: false,
        timedOut: false,
        stdout,
        stderr,
        exitCode: null,
        durationMs: Date.now() - start,
        spawnError: err,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// spawnClaude — unified dispatcher with discriminated-union overloads
// ---------------------------------------------------------------------------

export type CCSpawnOptions =
  | HeadlessSpawnOptions
  | InteractiveSpawnOptions
  | QuerySpawnOptions;

/**
 * Spawn a Claude Code process in the requested mode.
 *
 * Overloads ensure the TypeScript return type matches the mode:
 *   - `'headless'`    → `ChildProcess`         (attach stream + lifecycle handlers)
 *   - `'interactive'` → `Promise<void>`         (resolves once terminal window opens)
 *   - `'query'`       → `Promise<QuerySpawnResult>` (resolves when CC exits)
 *
 * @example Headless background agent:
 * ```ts
 * const child = spawnClaude({
 *   mode: 'headless',
 *   cwd: worktreeAbsPath,
 *   worktreeName,
 *   fleetContext: { teamId: worktreeName, projectId, githubRepo },
 * });
 * if (!child.pid) { // spawn failed — handle error }
 * child.stdout?.on('data', handleOutput);
 * child.on('exit', handleExit);
 * ```
 *
 * @example Interactive terminal window:
 * ```ts
 * await spawnClaude({
 *   mode: 'interactive',
 *   cwd: worktreeAbsPath,
 *   worktreeName,
 *   windowTitle: `Team ${team.worktreeName}`,
 *   fleetContext: { teamId: team.worktreeName, projectId: team.projectId!, githubRepo },
 *   prompt: resolvedPrompt,
 * });
 * ```
 *
 * @example One-shot structured query:
 * ```ts
 * const result = await spawnClaude({ mode: 'query', prompt, jsonSchema });
 * if (result.exitedOk) {
 *   const data = JSON.parse(result.stdout);
 * }
 * ```
 */
export function spawnClaude(options: HeadlessSpawnOptions): ChildProcess;
export function spawnClaude(options: InteractiveSpawnOptions): Promise<void>;
export function spawnClaude(options: QuerySpawnOptions): Promise<QuerySpawnResult>;
export function spawnClaude(
  options: CCSpawnOptions,
): ChildProcess | Promise<void> | Promise<QuerySpawnResult> {
  switch (options.mode) {
    case 'headless':
      return spawnHeadless(options);
    case 'interactive':
      return spawnInteractive(options);
    case 'query':
      return spawnQuery(options);
  }
}