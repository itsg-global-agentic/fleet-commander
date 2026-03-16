// =============================================================================
// Fleet Commander — Project Cleanup Service
// =============================================================================
// Removes orphan git worktrees, stale signal files, zombie processes, and
// prunes git worktree references.  Modelled after the manual cleanup script
// at itsg-kea/scripts/cleanup-claude.sh, but integrated into the Fleet
// Commander server and scoped per-project.
// =============================================================================

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getDatabase } from '../db.js';
import config from '../config.js';
import type { CleanupResult } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Signal file patterns to clean from worktrees
// ---------------------------------------------------------------------------

const SIGNAL_FILE_PATTERNS = [
  '.fleet-pm-message',
  /^\.pr-watcher-/,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a process with the given PID is still alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      const result = execSync(`tasklist /FI "PID eq ${pid}" /NH`, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: 'pipe',
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

// ---------------------------------------------------------------------------
// Main cleanup function
// ---------------------------------------------------------------------------

/**
 * Clean up a single project: remove orphan worktrees, signal files, fix
 * zombie team records, and prune stale git references.
 */
export async function cleanupProject(projectId: number): Promise<CleanupResult> {
  const db = getDatabase();
  const project = db.getProject(projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  const result: CleanupResult = {
    worktreesRemoved: [],
    signalFilesRemoved: [],
    staleDirsRemoved: [],
    branchesPruned: [],
    zombiesFixed: 0,
    staleTeamsCleaned: 0,
    errors: [],
  };

  const worktreeBaseDir = path.join(project.repoPath, config.worktreeDir);

  // Derive the slug used for naming worktrees in this project
  const slug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // Build set of worktree names that are tracked by active teams in the DB
  const allTeams = db.getTeams({ projectId });
  const activeStatuses = ['queued', 'launching', 'running', 'idle', 'stuck'];
  const activeWorktreeNames = new Set(
    allTeams
      .filter((t) => activeStatuses.includes(t.status))
      .map((t) => t.worktreeName),
  );
  // -------------------------------------------------------------------
  // 1. Find and remove orphan worktrees
  // -------------------------------------------------------------------
  // An "orphan" worktree is one that exists on disk (in .claude/worktrees/)
  // but has no corresponding active team in the database.

  if (fs.existsSync(worktreeBaseDir)) {
    let dirs: string[];
    try {
      dirs = fs.readdirSync(worktreeBaseDir);
    } catch (err) {
      result.errors.push(`Failed to read worktree directory: ${err}`);
      dirs = [];
    }

    for (const dir of dirs) {
      const dirPath = path.join(worktreeBaseDir, dir);

      // Only consider directories
      try {
        if (!fs.statSync(dirPath).isDirectory()) continue;
      } catch {
        continue;
      }

      // Only consider dirs matching this project's naming convention
      if (!dir.startsWith(`${slug}-`) && !dir.startsWith('kea-')) continue;

      // Skip if there's an active team using this worktree
      if (activeWorktreeNames.has(dir)) continue;

      // This is an orphan — try to remove via git worktree remove
      try {
        execSync(`git -C "${project.repoPath}" worktree remove --force "${config.worktreeDir}/${dir}"`, {
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 15000,
        });
        result.worktreesRemoved.push(dir);
      } catch {
        // git worktree remove failed — try manual removal + prune
        try {
          fs.rmSync(dirPath, { recursive: true, force: true });
          result.staleDirsRemoved.push(dir);
        } catch (err) {
          result.errors.push(`Failed to remove orphan dir ${dir}: ${err}`);
        }
      }
    }
  }

  // -------------------------------------------------------------------
  // 2. Clean signal files in remaining worktrees
  // -------------------------------------------------------------------

  if (fs.existsSync(worktreeBaseDir)) {
    let dirs: string[];
    try {
      dirs = fs.readdirSync(worktreeBaseDir);
    } catch {
      dirs = [];
    }

    for (const dir of dirs) {
      const dirPath = path.join(worktreeBaseDir, dir);
      try {
        if (!fs.statSync(dirPath).isDirectory()) continue;
      } catch {
        continue;
      }

      // Scan for signal files
      let files: string[];
      try {
        files = fs.readdirSync(dirPath);
      } catch {
        continue;
      }

      for (const file of files) {
        const isSignal = SIGNAL_FILE_PATTERNS.some((pattern) => {
          if (typeof pattern === 'string') return file === pattern;
          return pattern.test(file);
        });

        if (isSignal) {
          try {
            fs.unlinkSync(path.join(dirPath, file));
            result.signalFilesRemoved.push(`${dir}/${file}`);
          } catch (err) {
            result.errors.push(`Failed to remove signal file ${dir}/${file}: ${err}`);
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------
  // 3. Prune git worktrees (cleans stale references)
  // -------------------------------------------------------------------

  try {
    execSync(`git -C "${project.repoPath}" worktree prune`, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 10000,
    });
  } catch (err) {
    result.errors.push(`git worktree prune failed: ${err}`);
  }

  // -------------------------------------------------------------------
  // 4. Clean stale worktree branches (worktree-{slug}-* without a
  //    linked worktree)
  // -------------------------------------------------------------------

  try {
    // Get branches that ARE linked to active worktrees
    const activeWtBranches = new Set<string>();
    try {
      const porcelain = execSync(`git -C "${project.repoPath}" worktree list --porcelain`, {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 10000,
      });
      for (const line of porcelain.split('\n')) {
        if (line.startsWith('branch refs/heads/')) {
          activeWtBranches.add(line.slice('branch refs/heads/'.length).trim());
        }
      }
    } catch {
      // ignore
    }

    // List local branches matching the worktree pattern
    const branchPrefix = `worktree-${slug}-`;
    const branchOutput = execSync(`git -C "${project.repoPath}" branch --list "${branchPrefix}*"`, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 10000,
    });

    for (const rawLine of branchOutput.split('\n')) {
      const branch = rawLine.replace(/^[\s*]+/, '').trim();
      if (!branch) continue;

      // Skip if actively linked to a worktree
      if (activeWtBranches.has(branch)) continue;

      try {
        execSync(`git -C "${project.repoPath}" branch -D "${branch}"`, {
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 10000,
        });
        result.branchesPruned.push(branch);
      } catch (err) {
        result.errors.push(`Failed to delete branch ${branch}: ${err}`);
      }
    }
  } catch {
    // No matching branches — normal
  }

  // -------------------------------------------------------------------
  // 5. Fix zombie team records
  // -------------------------------------------------------------------
  // Teams in DB with active status but whose PID is dead

  for (const team of allTeams) {
    if (!activeStatuses.includes(team.status)) continue;
    if (!team.pid) continue;

    if (!isProcessAlive(team.pid)) {
      db.updateTeam(team.id, {
        status: 'failed',
        pid: null,
        stoppedAt: new Date().toISOString(),
      });
      result.zombiesFixed++;
    }
  }

  // -------------------------------------------------------------------
  // 6. Clean stale team records (done/failed older than 7 days)
  // -------------------------------------------------------------------

  const STALE_DAYS = 7;
  const staleCutoff = new Date();
  staleCutoff.setDate(staleCutoff.getDate() - STALE_DAYS);
  const staleCutoffIso = staleCutoff.toISOString();

  for (const team of allTeams) {
    if (team.status !== 'done' && team.status !== 'failed') continue;

    const teamDate = team.stoppedAt || team.launchedAt;
    if (teamDate && teamDate < staleCutoffIso) {
      result.staleTeamsCleaned++;
    }
  }

  return result;
}
