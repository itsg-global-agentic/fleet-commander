// =============================================================================
// Fleet Commander — Team Resolution Helpers
// =============================================================================
// Shared helpers for resolving a team's worktree name from the data available
// on a Claude Code hook payload. Used by the new HTTP hook route
// (POST /api/hooks/:eventType) to map CC's `cwd` / `transcript_path` field
// onto the FC team registry without requiring the shell hook to extract the
// worktree name itself.
//
// CC ships the absolute working directory of the spawned process in
// `cc_stdin.cwd`. FC always spawns CC inside a worktree at
// `<repo>/.claude/worktrees/<worktree_name>`, so the worktree name is the
// path segment immediately after `/worktrees/`. When the path does not
// contain a `worktrees` segment (e.g. when CC runs from the main checkout),
// we fall back to the basename — which lets the helper work in test
// scenarios that seed teams whose worktreeName matches a literal directory
// name without the worktrees prefix.
// =============================================================================

import path from 'path';

/**
 * Resolve the worktree name (FC's team key) from a Claude Code `cwd` field.
 *
 * Splits on `/worktrees/` (forward slashes) or `\worktrees\` (Windows
 * backslashes) and returns the next path segment. Defensive against trailing
 * separators — only the segment immediately after `worktrees` is returned,
 * any deeper nesting (e.g. nested subdirectories of the worktree) is
 * discarded.
 *
 * Falls back to `path.basename(cwd)` when no `worktrees` segment is present.
 * Returns an empty string only for an empty input (callers should treat that
 * as a missing field and reject the request with 400).
 *
 * Examples:
 *   resolveTeamFromCwd('C:/Git/myrepo/.claude/worktrees/myrepo-42')
 *     -> 'myrepo-42'
 *   resolveTeamFromCwd('C:\\Git\\myrepo\\.claude\\worktrees\\myrepo-42')
 *     -> 'myrepo-42'
 *   resolveTeamFromCwd('/home/u/myrepo/.claude/worktrees/myrepo-42/src')
 *     -> 'myrepo-42'
 *   resolveTeamFromCwd('/some/random/path/myrepo-42')
 *     -> 'myrepo-42'  (basename fallback)
 */
export function resolveTeamFromCwd(cwd: string): string {
  if (!cwd) return '';

  // Match both POSIX (/worktrees/) and Windows (\worktrees\) variants.
  // The regex is anchored on the separator characters so it cannot match
  // a literal `worktrees` substring embedded in a directory name.
  const match = cwd.match(/[\\/]worktrees[\\/]([^\\/]+)/);
  if (match && match[1]) {
    return match[1];
  }

  // No worktrees segment — use basename as a defensive fallback.
  // Normalize backslashes to forward slashes first: on POSIX, `path.basename`
  // does NOT recognize `\` as a separator, so a Windows-style input like
  // `C:\Users\me\projects\standalone-team` would be returned verbatim on
  // Linux CI runners. Normalizing makes the fallback platform-independent.
  return path.basename(cwd.replace(/\\/g, '/'));
}

/**
 * Resolve the team's worktree name from a parsed CC hook body.
 *
 * Prefers `body.cwd` (canonical field on every CC hook). Falls back to
 * `body.transcript_path` for CC versions that omit `cwd` on some hook types
 * — the transcript file lives alongside the worktree so the same path
 * prefix logic applies.
 *
 * Returns `null` when neither field is present or both resolve to empty
 * strings. Route handlers should treat null as a 400 (missing cwd) so the
 * caller can fix their hook config rather than receiving a misleading 404
 * after we try to look up a nonexistent team.
 */
export function resolveTeamFromHookBody(body: Record<string, unknown>): string | null {
  const cwd = typeof body.cwd === 'string' ? body.cwd : '';
  if (cwd) {
    const resolved = resolveTeamFromCwd(cwd);
    if (resolved) return resolved;
  }

  const transcriptPath = typeof body.transcript_path === 'string' ? body.transcript_path : '';
  if (transcriptPath) {
    const resolved = resolveTeamFromCwd(transcriptPath);
    if (resolved) return resolved;
  }

  return null;
}
