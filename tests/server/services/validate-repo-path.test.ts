// =============================================================================
// Fleet Commander — validateRepoPath Tests
// =============================================================================
// Tests the path validation function that prevents path traversal attacks
// and ensures the provided repo path is a valid, existing directory.
// =============================================================================

import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateRepoPath } from '../../../src/server/services/project-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateRepoPath', () => {
  // -------------------------------------------------------------------------
  // Empty / missing input
  // -------------------------------------------------------------------------

  it('should throw for empty string', () => {
    expect(() => validateRepoPath('')).toThrow('repoPath is required and must be a non-empty string');
  });

  it('should throw for whitespace-only string', () => {
    expect(() => validateRepoPath('   ')).toThrow('repoPath is required and must be a non-empty string');
  });

  it('should throw for non-string input', () => {
    expect(() => validateRepoPath(undefined as unknown as string)).toThrow(
      'repoPath is required and must be a non-empty string',
    );
  });

  // -------------------------------------------------------------------------
  // Path traversal detection
  // -------------------------------------------------------------------------

  it('should throw for path with forward-slash traversal segments', () => {
    expect(() => validateRepoPath('C:/Git/legit/../../../Windows/System32')).toThrow(
      'path traversal',
    );
  });

  it('should throw for path with backslash traversal segments', () => {
    expect(() => validateRepoPath('C:\\Git\\legit\\..\\..\\Windows\\System32')).toThrow(
      'path traversal',
    );
  });

  it('should throw for path that is just relative traversal', () => {
    expect(() => validateRepoPath('../..')).toThrow('path traversal');
  });

  it('should throw for path starting with .. segment', () => {
    expect(() => validateRepoPath('../some/path')).toThrow('path traversal');
  });

  it('should throw for path ending with .. segment', () => {
    expect(() => validateRepoPath('/some/path/..')).toThrow('path traversal');
  });

  // -------------------------------------------------------------------------
  // Legitimate paths with ".." in names (NOT traversal)
  // -------------------------------------------------------------------------

  it('should not reject paths with .. embedded in directory names', () => {
    // A directory literally named "my..project" is NOT a traversal.
    // The function will throw for non-existence, but NOT for traversal.
    expect(() => validateRepoPath('C:/Git/my..project')).toThrow('does not exist');
    expect(() => validateRepoPath('C:/Git/my..project')).not.toThrow('path traversal');
  });

  // -------------------------------------------------------------------------
  // Non-existent path
  // -------------------------------------------------------------------------

  it('should throw for path that does not exist', () => {
    expect(() => validateRepoPath('/nonexistent/path/xyz/does-not-exist')).toThrow(
      'does not exist',
    );
  });

  // -------------------------------------------------------------------------
  // Path is a file, not a directory
  // -------------------------------------------------------------------------

  it('should throw for path that is a file, not a directory', () => {
    // Use the test file itself as a known file path
    expect(() => validateRepoPath(__filename)).toThrow('not a directory');
  });

  // -------------------------------------------------------------------------
  // Valid directory
  // -------------------------------------------------------------------------

  it('should return normalized path for a valid directory', () => {
    // Use the test directory — guaranteed to exist
    const result = validateRepoPath(__dirname);
    // Should be an absolute path with forward slashes
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).not.toContain('\\');
  });
});
