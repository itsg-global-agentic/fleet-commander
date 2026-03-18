// =============================================================================
// Fleet Commander — Startup Recovery & Worktree Discovery
// =============================================================================
// On server startup, reconcile database state with actual process and
// filesystem state.  Running teams whose PIDs are still alive are kept;
// dead processes are marked idle or failed.  Orphan worktrees (present on
// disk but absent from the database) are logged as warnings.
//
// Per-project: iterates over all active projects from the DB and scans
// each project's repo_path for orphan worktrees. Graceful no-op if no
// projects are configured (fresh install).
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
 * 2. For each active project, scan the worktree directory for directories
 *    that are not tracked in the database (orphan worktrees).
 */
export async function recoverOnStartup(): Promise<void> {
  const db = getDatabase();

  // -------------------------------------------------------------------
  // 1. Reconcile active teams with actual OS processes
  // -------------------------------------------------------------------
  const activeTeams = db.getActiveTeams();

  for (const team of activeTeams) {
    if (team.status === 'queued') continue;

    if (!team.pid) {
      // No PID was ever recorded — mark as idle so the PM can re-launch.
      console.log(`[recovery] Team ${team.worktreeName} has no PID — marking idle`);
      db.insertTransition({
        teamId: team.id,
        fromStatus: team.status,
        toStatus: 'idle',
        trigger: 'system',
        reason: 'Server restart recovery: no PID recorded',
      });
      db.updateTeam(team.id, { status: 'idle', lastEventAt: new Date().toISOString() });
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
      db.insertTransition({
        teamId: team.id,
        fromStatus: team.status,
        toStatus: newStatus,
        trigger: 'system',
        reason: `Server restart recovery: process (PID ${team.pid}) no longer alive`,
      });
      db.updateTeam(team.id, { status: newStatus, pid: null, lastEventAt: new Date().toISOString() });
    }
  }

  // -------------------------------------------------------------------
  // 2. Scan for orphan worktrees per-project
  // -------------------------------------------------------------------
  const projects = db.getProjects({ status: 'active' });

  if (projects.length === 0) {
    console.log('[recovery] No active projects configured — skipping worktree scan');
    return;
  }

  for (const project of projects) {
    const worktreeDir = path.join(project.repoPath, config.worktreeDir);

    if (!fs.existsSync(worktreeDir)) {
      continue;
    }

    let dirs: string[];
    try {
      dirs = fs.readdirSync(worktreeDir);
    } catch (err) {
      console.warn(`[recovery] Could not read worktree directory for project "${project.name}": ${worktreeDir}`, err);
      continue;
    }

    // Derive slug from project name for matching worktree directories
    const slug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    for (const dir of dirs) {
      // Only inspect directories that follow the {slug}-{N} naming convention
      if (!dir.startsWith(`${slug}-`)) continue;

      const existsInDb = db.getTeamByWorktree(dir);
      if (!existsInDb) {
        console.warn(
          `[recovery] Orphan worktree found in project "${project.name}": ${dir} (not in database)`
        );
      }
    }
  }

  // -------------------------------------------------------------------
  // 3. Process queued teams — dequeue any that can now run
  // -------------------------------------------------------------------
  for (const project of projects) {
    const queued = db.getQueuedTeamsByProject(project.id);
    if (queued.length > 0) {
      console.log(
        `[recovery] ${queued.length} queued teams for project "${project.name}" — triggering queue processing`
      );
      try {
        const { getTeamManager } = await import('./team-manager.js');
        getTeamManager().processQueue(project.id).catch((err) => {
          console.error(`[recovery] processQueue failed for project "${project.name}":`, err);
        });
      } catch (err) {
        console.error(`[recovery] Failed to import TeamManager for queue processing:`, err);
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
