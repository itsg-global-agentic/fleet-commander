// =============================================================================
// Fleet Commander — exec-gh Utility Tests
// =============================================================================
// Tests for the shared async CLI execution utilities used by github-poller,
// pr-service, and project-service.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock child_process.exec via promisify
// ---------------------------------------------------------------------------

const mockExec = vi.fn();
vi.mock('child_process', () => ({
  exec: (...args: unknown[]) => mockExec(...args),
}));

// We need to mock util.promisify to return our controllable mock.
// Since exec-gh.ts calls promisify(exec) at module load, we control exec's
// callback-based behavior via mockExec.
vi.mock('util', async (importOriginal) => {
  const original = await importOriginal<typeof import('util')>();
  return {
    ...original,
    promisify: () => mockExec,
  };
});

// Import after mocks
const { execGHAsync, execGHResult, execGitAsync } = await import(
  '../../src/server/utils/exec-gh.js'
);

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// execGHAsync
// =============================================================================

describe('execGHAsync', () => {
  it('returns stdout on success', async () => {
    mockExec.mockResolvedValue({ stdout: '{"number": 42}\n', stderr: '' });

    const result = await execGHAsync('gh pr view 42 --json number');

    expect(result).toBe('{"number": 42}\n');
    expect(mockExec).toHaveBeenCalledWith('gh pr view 42 --json number', {
      encoding: 'utf-8',
      timeout: 15_000,
    });
  });

  it('returns null on error', async () => {
    mockExec.mockRejectedValue(new Error('gh not found'));

    const result = await execGHAsync('gh pr view 42');

    expect(result).toBeNull();
  });

  it('passes custom options through', async () => {
    mockExec.mockResolvedValue({ stdout: 'ok', stderr: '' });

    await execGHAsync('gh api repos/o/r', { timeout: 5000, cwd: '/tmp' });

    expect(mockExec).toHaveBeenCalledWith('gh api repos/o/r', {
      encoding: 'utf-8',
      timeout: 5000,
      cwd: '/tmp',
    });
  });

  it('suppresses "no pull requests match" errors', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExec.mockRejectedValue(new Error('no pull requests match'));

    await execGHAsync('gh pr list');

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('logs non-benign errors', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExec.mockRejectedValue(new Error('network timeout'));

    await execGHAsync('gh pr list');

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[execGHAsync]'),
    );
    consoleSpy.mockRestore();
  });
});

// =============================================================================
// execGHResult
// =============================================================================

describe('execGHResult', () => {
  it('returns ok: true with stdout on success', async () => {
    mockExec.mockResolvedValue({ stdout: 'merged', stderr: '' });

    const result = await execGHResult('gh pr merge 42 --auto --squash');

    expect(result).toEqual({ ok: true, stdout: 'merged' });
  });

  it('returns ok: false with error on failure', async () => {
    mockExec.mockRejectedValue(new Error('merge conflict'));

    const result = await execGHResult('gh pr merge 42 --auto --squash');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('merge conflict');
  });

  it('extracts stderr from error object when available', async () => {
    const err = new Error('command failed') as Error & { stderr: string };
    err.stderr = 'auto-merge is not allowed';
    mockExec.mockRejectedValue(err);

    const result = await execGHResult('gh pr merge 42');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('auto-merge is not allowed');
  });

  it('handles Buffer stderr', async () => {
    const err = new Error('command failed') as Error & { stderr: Buffer };
    err.stderr = Buffer.from('branch protection enabled');
    mockExec.mockRejectedValue(err);

    const result = await execGHResult('gh pr merge 42');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('branch protection enabled');
  });
});

// =============================================================================
// execGitAsync
// =============================================================================

describe('execGitAsync', () => {
  it('returns trimmed stdout on success', async () => {
    mockExec.mockResolvedValue({ stdout: 'feat/my-branch\n', stderr: '' });

    const result = await execGitAsync('git rev-parse --abbrev-ref HEAD');

    expect(result).toBe('feat/my-branch');
  });

  it('returns null on error', async () => {
    mockExec.mockRejectedValue(new Error('not a git repo'));

    const result = await execGitAsync('git rev-parse --is-inside-work-tree');

    expect(result).toBeNull();
  });

  it('returns null for empty stdout', async () => {
    mockExec.mockResolvedValue({ stdout: '  \n', stderr: '' });

    const result = await execGitAsync('git rev-parse --abbrev-ref HEAD');

    expect(result).toBeNull();
  });

  it('uses 5s default timeout for git commands', async () => {
    mockExec.mockResolvedValue({ stdout: 'main\n', stderr: '' });

    await execGitAsync('git branch --show-current');

    expect(mockExec).toHaveBeenCalledWith('git branch --show-current', {
      encoding: 'utf-8',
      timeout: 5_000,
    });
  });

  it('allows custom timeout override', async () => {
    mockExec.mockResolvedValue({ stdout: 'main\n', stderr: '' });

    await execGitAsync('git fetch', { timeout: 30_000 });

    expect(mockExec).toHaveBeenCalledWith('git fetch', {
      encoding: 'utf-8',
      timeout: 30_000,
    });
  });
});
