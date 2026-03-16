// =============================================================================
// Fleet Commander — Project Cleanup Service (v2: preview + selective confirm)
// =============================================================================
// Two-phase cleanup:
//   1. getCleanupPreview() — scans and returns what WOULD be cleaned (dry run)
//   2. executeCleanup()    — removes only the items the user confirmed
// =============================================================================

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getDatabase } from '../db.js';
import config from '../config.js';
import type { CleanupItem, CleanupPreview, CleanupResult } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Preview (dry run)
// ---------------------------------------------------------------------------

/**
 * Scan a project and return what WOULD be cleaned, without touching anything.
 */
export function getCleanupPreview(projectId: number): CleanupPreview {
  const db = getDatabase();
  const project = db.getProject(projectId);
  if (!project) throw new Error('Project not found');

  const items: CleanupItem[] = [];
  const repoPath = project.repoPath;

  // Derive project slug (same convention used by team-manager)
  const slug = project.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  // Build set of worktree names belonging to active teams
  const allTeams = db.getTeams({ projectId });
  const activeStatuses = ['queued', 'launching', 'running', 'idle', 'stuck'];
  const activeWorktreeNames = new Set(
    allTeams
      .filter((t) => activeStatuses.includes(t.status))
      .map((t) => t.worktreeName),
  );

  const worktreeDir = path.join(repoPath, config.worktreeDir);

  // -------------------------------------------------------------------
  // 1. Scan worktrees directory for orphans + finished teams
  // -------------------------------------------------------------------
  if (fs.existsSync(worktreeDir)) {
    let dirs: fs.Dirent[];
    try {
      dirs = fs.readdirSync(worktreeDir, { withFileTypes: true });
    } catch {
      dirs = [];
    }

    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const dirName = dir.name;
      const fullPath = path.join(worktreeDir, dirName);

      // Only consider dirs matching this project's naming convention
      if (!dirName.startsWith(`${slug}-`)) continue;

      // Skip worktrees belonging to active teams
      if (activeWorktreeNames.has(dirName)) continue;

      // Check DB for this worktree
      const team = db.getTeamByWorktree(dirName);

      // Skip teams belonging to a different project (avoid cross-project collision)
      if (team && team.projectId !== projectId) continue;

      if (!team) {
        items.push({
          type: 'worktree',
          name: dirName,
          path: fullPath.replace(/\\/g, '/'),
          reason: 'Not tracked in database (orphan)',
        });
      } else if (['done', 'failed'].includes(team.status)) {
        items.push({
          type: 'worktree',
          name: dirName,
          path: fullPath.replace(/\\/g, '/'),
          reason: `Team status: ${team.status}`,
        });
      }
      // Active teams are never listed

      // -----------------------------------------------------------
      // 2. Check for signal files inside this worktree
      // -----------------------------------------------------------
      let files: string[];
      try {
        files = fs.readdirSync(fullPath);
      } catch {
        files = [];
      }

      const signalPatterns = ['.fleet-pm-message'];
      const prWatcherFiles = files.filter((f) => f.startsWith('.pr-watcher-'));

      for (const sf of [...signalPatterns, ...prWatcherFiles]) {
        const sfPath = path.join(fullPath, sf);
        if (fs.existsSync(sfPath)) {
          items.push({
            type: 'signal_file',
            name: `${dirName}/${sf}`,
            path: sfPath.replace(/\\/g, '/'),
            reason: 'Stale signal file',
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------
  // 3. Check for stale worktree branches (branch exists, worktree gone)
  // -------------------------------------------------------------------
  try {
    const branchPrefix = `worktree-${slug}-`;
    const branchOutput = execSync(
      `git -C "${repoPath}" branch --list "${branchPrefix}*"`,
      { encoding: 'utf-8', stdio: 'pipe', timeout: 10000 },
    );

    for (const rawLine of branchOutput.split('\n')) {
      const branch = rawLine.replace(/^[\s*]+/, '').trim();
      if (!branch) continue;

      const worktreeName = branch.slice('worktree-'.length);
      const worktreeExists = fs.existsSync(path.join(worktreeDir, worktreeName));
      if (!worktreeExists) {
        items.push({
          type: 'stale_branch',
          name: branch,
          path: branch,
          reason: 'Branch without worktree',
        });
      }
    }
  } catch {
    // git command failed — skip branch check for project branches
  }

  return { projectId, projectName: project.name, items };
}

// ---------------------------------------------------------------------------
// Execute (confirmed items only)
// ---------------------------------------------------------------------------

/**
 * Remove only the items the user selected from the preview.
 * @param projectId   The project to clean
 * @param itemPaths   Array of `item.path` values the user checked in the modal
 */
export function executeCleanup(
  projectId: number,
  itemPaths: string[],
): CleanupResult {
  const db = getDatabase();
  const project = db.getProject(projectId);
  if (!project) throw new Error('Project not found');

  // Re-scan to get the current preview (ensures we only remove items that
  // still exist AND were in the original preview — prevents stale requests)
  const preview = getCleanupPreview(projectId);
  const allowedPaths = new Set(itemPaths);

  const removed: string[] = [];
  const failed: { name: string; error: string }[] = [];

  for (const item of preview.items) {
    if (!allowedPaths.has(item.path)) continue; // User didn't select this one

    try {
      if (item.type === 'worktree') {
        // Try git worktree remove first (properly unlinks)
        try {
          execSync(
            `git -C "${project.repoPath}" worktree remove --force "${config.worktreeDir}/${item.name}"`,
            { encoding: 'utf-8', stdio: 'pipe', timeout: 15000 },
          );
        } catch {
          // Fallback: rm -rf the directory
          fs.rmSync(item.path, { recursive: true, force: true });
        }
        // Prune stale worktree references
        try {
          execSync(`git -C "${project.repoPath}" worktree prune`, {
            stdio: 'pipe',
            timeout: 5000,
          });
        } catch {
          // non-fatal
        }
        removed.push(item.name);
      } else if (item.type === 'signal_file') {
        fs.unlinkSync(item.path);
        removed.push(item.name);
      } else if (item.type === 'stale_branch') {
        execSync(
          `git -C "${project.repoPath}" branch -D "${item.name}"`,
          { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 },
        );
        removed.push(item.name);
      }
    } catch (err) {
      failed.push({
        name: item.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { removed, failed };
}
