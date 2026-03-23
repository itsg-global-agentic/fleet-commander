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
 *
 * `git --exec-path` returns something like:
 *   - "C:/Program Files/Git/mingw64/libexec/git-core"  (standard install, 3 levels deep)
 *   - "C:/Git/scm/mingw64/libexec/git-core"            (custom install, 3 levels deep)
 *   - "C:/Git/scm/libexec/git-core"                    (portable, 2 levels deep)
 *
 * We walk up the tree until we find usr/bin/bash.exe rather than assuming
 * a fixed depth, since the layout varies across Git for Windows installs.
 */
let _gitBash: string | null = null;
export function getGitBash(): string {
  if (_gitBash) return _gitBash;

  // Strategy 1: Walk up from git --exec-path to find usr/bin/bash.exe
  try {
    const execPath = execSync('git --exec-path', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    let dir = path.resolve(execPath);
    // Walk up at most 5 levels looking for usr/bin/bash.exe
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(dir, 'usr', 'bin', 'bash.exe');
      if (fs.existsSync(candidate)) {
        _gitBash = candidate;
        return _gitBash;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break; // reached filesystem root
      dir = parent;
    }
  } catch {
    // git not in PATH or other error — try fallback locations
  }

  // Strategy 2: Check common Git for Windows install locations
  const commonLocations = [
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
  ];
  for (const loc of commonLocations) {
    if (fs.existsSync(loc)) {
      _gitBash = loc;
      return _gitBash;
    }
  }

  // Strategy 3: Check if 'bash' in PATH is Git Bash (not WSL)
  // by looking for the --version containing "pc-msys" or "pc-linux"
  try {
    const ver = execSync('bash --version', { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 });
    if (ver.includes('pc-msys') || ver.includes('Msys') || ver.includes('mintty')) {
      _gitBash = 'bash';
      return _gitBash;
    }
  } catch {
    // bash not found at all
  }

  _gitBash = 'bash'; // last resort — may be WSL, but nothing else to try
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

  // On Windows, use Git Bash with forward-slash paths (Git Bash handles C:/ natively)
  const bash = getGitBash();
  const cmd = process.platform === 'win32'
    ? `"${bash}" "${toBashPath(scriptPath)}" "${toBashPath(repoPath)}"`
    : `"${scriptPath}" "${repoPath}"`;

  logger.info(`[installHooks] bash=${bash}, cmd=${cmd}`);

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
