// =============================================================================
// Fleet Commander — Hook Install/Uninstall Utilities
// =============================================================================
// Shared utilities for installing and uninstalling Fleet Commander hooks
// into target project repositories. Used by both projects.ts and system.ts.
// =============================================================================

import type { FastifyBaseLogger } from 'fastify';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import config from '../config.js';

/**
 * Find Git Bash executable on Windows.
 * Avoids WSL's bash which can't handle Windows paths.
 */
let _gitBash: string | null = null;
export function getGitBash(): string {
  if (_gitBash) return _gitBash;
  try {
    // git --exec-path returns e.g. "C:/Git/scm/libexec/git-core"
    // Git bash is at {git_root}/usr/bin/bash.exe
    const execPath = execSync('git --exec-path', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    const gitRoot = path.resolve(execPath, '..', '..');
    const bashPath = path.join(gitRoot, 'usr', 'bin', 'bash.exe');
    if (fs.existsSync(bashPath)) {
      _gitBash = bashPath;
      return _gitBash;
    }
  } catch {
    // fallback
  }
  _gitBash = 'bash'; // hope for the best
  return _gitBash;
}

/**
 * Convert a Windows path to a bash-safe format with forward slashes.
 */
export function toBashPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Install Fleet Commander hooks into a project repo.
 * Returns { ok, stdout, stderr } so callers can log / surface errors.
 */
export function installHooks(repoPath: string, logger: FastifyBaseLogger): { ok: boolean; stdout: string; stderr: string } {
  const fail = (msg: string) => ({ ok: false, stdout: '', stderr: msg });

  const scriptPath = path.join(config.fleetCommanderRoot, 'scripts', 'install.sh');
  if (!fs.existsSync(scriptPath)) {
    return fail(`install.sh not found at ${scriptPath}`);
  }

  // On Windows, convert paths to MSYS2 format: C:/foo → /c/foo
  const cmd = process.platform === 'win32'
    ? `"${getGitBash()}" "${toBashPath(scriptPath)}" "${toBashPath(repoPath)}"`
    : `"${scriptPath}" "${repoPath}"`;

  try {
    const stdout = execSync(cmd, { encoding: 'utf-8', stdio: 'pipe', timeout: 30000 });
    return { ok: true, stdout, stderr: '' };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string; status?: number };
    const stdout = e.stdout ?? '';
    const stderr = e.stderr ?? '';
    logger.error(
      `[installHooks] Failed for ${repoPath} (exit ${e.status ?? '?'}):\n` +
      `  cmd: ${cmd}\n` +
      `  stderr: ${stderr.trim()}\n` +
      `  stdout: ${stdout.trim()}`,
    );
    return { ok: false, stdout, stderr: stderr || e.message || 'unknown error' };
  }
}

/**
 * Uninstall Fleet Commander hooks from a project repo.
 */
export function uninstallHooks(repoPath: string, logger: FastifyBaseLogger): void {
  try {
    const scriptPath = path.join(config.fleetCommanderRoot, 'scripts', 'uninstall.sh');
    if (!fs.existsSync(scriptPath)) {
      return;
    }

    const cmd = process.platform === 'win32'
      ? `"${getGitBash()}" "${toBashPath(scriptPath)}" "${toBashPath(repoPath)}"`
      : `"${scriptPath}" "${repoPath}"`;

    execSync(cmd, { encoding: 'utf-8', stdio: 'pipe', timeout: 30000 });
  } catch (err) {
    // Non-fatal — log but don't block project deletion
    logger.error(
      `[uninstallHooks] Failed to uninstall from ${repoPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
