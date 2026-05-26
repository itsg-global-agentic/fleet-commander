// =============================================================================
// Fleet Commander -- Team Resolution Helpers (issue #735)
// =============================================================================
// Unit tests for the cwd -> worktree-name resolution used by the HTTP hook
// route. The helper must handle both POSIX and Windows path separators since
// FC runs on both platforms.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  resolveTeamFromCwd,
  resolveTeamFromHookBody,
} from '../../../src/server/utils/team-resolution.js';

describe('resolveTeamFromCwd', () => {
  it('extracts worktree name from a POSIX path', () => {
    expect(resolveTeamFromCwd('/home/user/myrepo/.claude/worktrees/myrepo-42')).toBe(
      'myrepo-42',
    );
  });

  it('extracts worktree name from a Windows path with backslashes', () => {
    expect(
      resolveTeamFromCwd('C:\\Git\\myrepo\\.claude\\worktrees\\myrepo-42'),
    ).toBe('myrepo-42');
  });

  it('extracts worktree name from a Windows path with forward slashes', () => {
    expect(resolveTeamFromCwd('C:/Git/myrepo/.claude/worktrees/myrepo-42')).toBe(
      'myrepo-42',
    );
  });

  it('returns only the first segment after worktrees, ignoring subdirectories', () => {
    expect(
      resolveTeamFromCwd('/home/user/repo/.claude/worktrees/repo-42/src/app'),
    ).toBe('repo-42');
  });

  it('handles trailing separator after worktree name', () => {
    expect(
      resolveTeamFromCwd('/home/user/repo/.claude/worktrees/repo-42/'),
    ).toBe('repo-42');
  });

  it('handles mixed separators in the same path', () => {
    expect(
      resolveTeamFromCwd('C:/Git/myrepo/.claude\\worktrees/myrepo-42'),
    ).toBe('myrepo-42');
  });

  it('falls back to basename when there is no worktrees segment', () => {
    expect(resolveTeamFromCwd('/some/random/path/myrepo-42')).toBe('myrepo-42');
  });

  it('falls back to basename for Windows paths without worktrees segment', () => {
    expect(resolveTeamFromCwd('C:\\Users\\me\\projects\\standalone-team')).toBe(
      'standalone-team',
    );
  });

  it('does not match worktrees as an embedded substring', () => {
    // `myworktrees-stuff` is NOT a worktrees segment — the helper falls back
    // to basename so callers don't accidentally treat it as a team name.
    expect(resolveTeamFromCwd('/home/user/myworktrees-stuff/repo-42')).toBe(
      'repo-42',
    );
  });

  it('handles nested worktrees segments by taking the FIRST one', () => {
    // Defensive: nested worktrees should never happen in practice, but if
    // they do, take the outermost worktree name. This matches FC's spawn
    // behavior (one worktree per team) and prevents weird edge-case keys.
    expect(
      resolveTeamFromCwd(
        '/repo/.claude/worktrees/outer-team/.claude/worktrees/inner-team',
      ),
    ).toBe('outer-team');
  });

  it('returns empty string for empty input', () => {
    expect(resolveTeamFromCwd('')).toBe('');
  });
});

describe('resolveTeamFromHookBody', () => {
  it('prefers cwd over transcript_path', () => {
    const body = {
      cwd: 'C:/Git/repo/.claude/worktrees/repo-1',
      transcript_path: 'C:/Git/repo/.claude/worktrees/repo-2/transcript.jsonl',
    };
    expect(resolveTeamFromHookBody(body)).toBe('repo-1');
  });

  it('falls back to transcript_path when cwd is missing', () => {
    const body = {
      transcript_path: 'C:/Git/repo/.claude/worktrees/repo-7/transcript.jsonl',
    };
    expect(resolveTeamFromHookBody(body)).toBe('repo-7');
  });

  it('falls back to transcript_path when cwd is empty string', () => {
    const body = {
      cwd: '',
      transcript_path: '/home/u/repo/.claude/worktrees/repo-99/x.jsonl',
    };
    expect(resolveTeamFromHookBody(body)).toBe('repo-99');
  });

  it('returns null when both fields are missing', () => {
    expect(resolveTeamFromHookBody({})).toBeNull();
  });

  it('returns null when both fields are non-strings', () => {
    expect(resolveTeamFromHookBody({ cwd: 42, transcript_path: null })).toBeNull();
  });

  it('returns null when both fields are empty strings', () => {
    expect(resolveTeamFromHookBody({ cwd: '', transcript_path: '' })).toBeNull();
  });

  it('handles a cwd without a worktrees segment via basename fallback', () => {
    expect(resolveTeamFromHookBody({ cwd: '/tmp/standalone-repo' })).toBe(
      'standalone-repo',
    );
  });
});
