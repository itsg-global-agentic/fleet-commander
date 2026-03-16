// =============================================================================
// Fleet Commander — Startup Recovery & Worktree Discovery
// =============================================================================
// On server startup, reconcile database state with actual process and
// filesystem state.  Running teams whose PIDs are still alive are kept;
// dead processes are marked idle or failed.  Orphan worktrees (present on
// disk but absent from the database) are logged as warnings.
// =============================================================================

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getDatabase } from '../db.js';
import config from '../config.js';

/**
 * Run recovery checks during server initialisation.
 *
 * 1. Re-evaluate every team that was in an "active" status (queued, launching,
 *    running, idle, stuck) before the server went down.
 * 2. Scan the worktree directory for directories that are not tracked in the
 *    database (orphan worktrees).
 */
export async function recoverOnStartup(): Promise<void> {
  const db = getDatabase();

  // -------------------------------------------------------------------
  // 1. Reconcile active teams with actual OS processes
  // -------------------------------------------------------------------
  const activeTeams = db.getActiveTeams();

  for (const team of activeTeams) {
    if (!team.pid) {
      // No PID was ever recorded — mark as idle so the PM can re-launch.
      console.log(`[recovery] Team ${team.worktreeName} has no PID — marking idle`);
      db.updateTeam(team.id, { status: 'idle' });
      continue;
    }

    const alive = isProcessAlive(team.pid);

    if (alive) {
      // The Claude Code process survived the server restart.  We cannot
      // re-attach to its stdout, but we acknowledge it is still working.
      console.log(
        `[recovery] Team ${team.worktreeName} (PID ${team.pid}) still running`
      );
      db.updateTeam(team.id, { lastEventAt: new Date().toISOString() });
    } else {
      // Process is gone.  If it was still launching when we lost track,
      // treat it as a failure; otherwise just mark idle.
      const newStatus = team.status === 'launching' ? 'failed' : 'idle';
      console.log(
        `[recovery] Team ${team.worktreeName} (PID ${team.pid}) dead -> ${newStatus}`
      );
      db.updateTeam(team.id, { status: newStatus, pid: null });
    }
  }

  // -------------------------------------------------------------------
  // 2. Scan for orphan worktrees (on disk but not in database)
  // -------------------------------------------------------------------
  const worktreeDir = path.join(config.repoRoot, config.worktreeDir);

  if (fs.existsSync(worktreeDir)) {
    let dirs: string[];
    try {
      dirs = fs.readdirSync(worktreeDir);
    } catch (err) {
      console.warn(`[recovery] Could not read worktree directory: ${worktreeDir}`, err);
      return;
    }

    for (const dir of dirs) {
      // Only inspect directories that follow the kea-{N} naming convention.
      if (!dir.startsWith('kea-')) continue;

      const existsInDb = db.getTeamByWorktree(dir);
      if (!existsInDb) {
        console.warn(
          `[recovery] Orphan worktree found: ${dir} (not in database)`
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a process with the given PID is still alive.
 *
 * - On Windows: uses `tasklist /FI "PID eq …"` and checks for the PID in the
 *   output.  This avoids false positives from recycled PIDs.
 * - On POSIX:  sends signal 0 via `process.kill`.  This does not kill the
 *   process — it only checks whether the process exists.
 */
function isProcessAlive(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      const result = execSync(`tasklist /FI "PID eq ${pid}" /NH`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      return result.includes(String(pid));
    } else {
      process.kill(pid, 0);
      return true;
    }
  } catch {
    return false;
  }
}
