// =============================================================================
// Fleet Commander — Async GH/Git CLI Execution Utility
// =============================================================================
// Shared async utility for executing `gh` and `git` CLI commands without
// blocking the Node.js event loop. Replaces the various per-file `execSync`
// helpers that were causing event-loop stalls (see issue #385).
//
// Uses `promisify(child_process.exec)` — the same pattern as issue-fetcher.ts
// and team-manager.ts.
// =============================================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import type { ExecOptions } from 'child_process';

/** Promisified exec for async child_process calls */
const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Classification of CLI execution errors for caller-side recovery logic */
export type ExecErrorType = 'auth' | 'network' | 'rate_limit' | 'not_found' | 'timeout' | 'unknown';

export interface ExecResult {
  ok: boolean;
  stdout?: string;
  error?: string;
  /** Error classification — only present when ok is false */
  errorType?: ExecErrorType;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify a CLI error string into a typed error category.
 * Inspects stderr / error message content for known patterns.
 */
function classifyError(errorText: string): ExecErrorType {
  const lower = errorText.toLowerCase();
  if (lower.includes('rate limit') || lower.includes('api rate limit')) {
    return 'rate_limit';
  }
  if (lower.includes('http 401') || lower.includes('authentication') || lower.includes('auth token') || lower.includes('not logged in')) {
    return 'auth';
  }
  if (lower.includes('http 404') || lower.includes('not found') || lower.includes('could not resolve to a repository')) {
    return 'not_found';
  }
  if (lower.includes('could not resolve host') || lower.includes('network') || lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('etimedout')) {
    return 'network';
  }
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('timedout')) {
    return 'timeout';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a `gh` CLI command asynchronously and return stdout, or `null` on error.
 * Errors are logged but never thrown — the caller decides how to proceed.
 *
 * This is the async replacement for the synchronous `execSync` patterns that
 * were blocking the event loop during GitHub polling.
 *
 * @param command - Full CLI command string (e.g. "gh pr view 42 --repo owner/repo ...")
 * @param options - Optional ExecOptions overrides (timeout defaults to 15s)
 * @returns stdout string on success, or null on error
 */
export async function execGHAsync(
  command: string,
  options?: Partial<ExecOptions>,
): Promise<string | null> {
  try {
    const result = await execAsync(command, {
      encoding: 'utf-8',
      timeout: 15_000,
      ...options,
    });
    return String(result.stdout);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Only log if it's not a benign "no PRs found" type error
    if (!message.includes('no pull requests match')) {
      const errorType = classifyError(message);
      console.error(`[execGHAsync] CLI error (${errorType}): ${message.slice(0, 200)}`);
    }
    return null;
  }
}

/**
 * Execute a CLI command asynchronously and return a structured result with
 * ok/stdout/error fields. Suitable for callers that need to distinguish
 * between success and failure and inspect stderr.
 *
 * @param command - Full CLI command string
 * @param options - Optional ExecOptions overrides (timeout defaults to 15s)
 * @returns ExecResult with ok, stdout, and error fields
 */
export async function execGHResult(
  command: string,
  options?: Partial<ExecOptions>,
): Promise<ExecResult> {
  try {
    const result = await execAsync(command, {
      encoding: 'utf-8',
      timeout: 15_000,
      ...options,
    });
    return { ok: true, stdout: String(result.stdout) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    let stderr = message;
    if (err && typeof err === 'object' && 'stderr' in err) {
      const rawStderr = (err as { stderr: string | Buffer }).stderr;
      stderr = typeof rawStderr === 'string' ? rawStderr : rawStderr.toString('utf-8');
    }
    const errorText = stderr.trim() || message;
    return { ok: false, error: errorText, errorType: classifyError(errorText) };
  }
}

/**
 * Execute a `git` command asynchronously and return trimmed stdout, or null on error.
 * Convenience wrapper for git operations (e.g. detecting worktree branches).
 *
 * @param command - Full git command string (e.g. "git -C /path rev-parse --abbrev-ref HEAD")
 * @param options - Optional ExecOptions overrides (timeout defaults to 5s)
 * @returns Trimmed stdout on success, or null on error
 */
export async function execGitAsync(
  command: string,
  options?: Partial<ExecOptions>,
): Promise<string | null> {
  try {
    const result = await execAsync(command, {
      encoding: 'utf-8',
      timeout: 5_000,
      ...options,
    });
    const str = String(result.stdout).trim();
    return str || null;
  } catch {
    return null;
  }
}
