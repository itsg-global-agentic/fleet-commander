// =============================================================================
// Fleet Commander — Project Readiness Tests (evaluateProjectReadiness)
// =============================================================================
// Tests the pure readiness evaluation function that determines whether a
// project is ready for team launches based on its install status.
// =============================================================================

import { describe, it, expect } from 'vitest';
import type { InstallStatus, InstallFileStatus } from '../../../src/shared/types.js';
import { evaluateProjectReadiness } from '../../../src/server/services/project-service.js';

// ---------------------------------------------------------------------------
// Helpers — build InstallStatus fixtures
// ---------------------------------------------------------------------------

function makeFileStatus(overrides: Partial<InstallFileStatus> = {}): InstallFileStatus {
  return {
    name: 'file.sh',
    exists: true,
    hasCrlf: false,
    installedVersion: '0.1.0',
    currentVersion: '0.1.0',
    ...overrides,
  };
}

/** Returns a fully healthy InstallStatus (all checks green). */
function makeGreenStatus(): InstallStatus {
  return {
    hooks: {
      installed: true,
      total: 10,
      found: 10,
      files: [makeFileStatus({ name: 'on_session_start.sh' })],
    },
    prompt: {
      installed: true,
      files: [makeFileStatus({ name: 'workflow.md' })],
    },
    agents: {
      installed: true,
      files: [makeFileStatus({ name: 'fleet-dev.md' })],
    },
    settings: makeFileStatus({ name: 'settings.json' }),
    outdatedCount: 0,
    currentVersion: '0.1.0',
    gitCommitStatus: {
      health: 'green',
      message: 'All files committed',
      gitignored: false,
      files: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('evaluateProjectReadiness', () => {
  // -------------------------------------------------------------------------
  // All-green project
  // -------------------------------------------------------------------------

  it('returns ready with no errors for a fully healthy project', () => {
    const result = evaluateProjectReadiness(makeGreenStatus());

    expect(result.ready).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Missing hooks → blocked
  // -------------------------------------------------------------------------

  it('blocks launch when hooks are not installed', () => {
    const status = makeGreenStatus();
    status.hooks.installed = false;
    status.hooks.found = 5;
    status.hooks.files = [
      makeFileStatus({ name: 'on_session_start.sh', exists: true }),
      makeFileStatus({ name: 'on_session_end.sh', exists: false }),
    ];

    const result = evaluateProjectReadiness(status);

    expect(result.ready).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining('Hooks not installed'),
    );
  });

  // -------------------------------------------------------------------------
  // CRLF hooks → specific CRLF error message
  // -------------------------------------------------------------------------

  it('shows specific CRLF message when hooks have CRLF line endings', () => {
    const status = makeGreenStatus();
    status.hooks.installed = false;
    status.hooks.files = [
      makeFileStatus({ name: 'on_session_start.sh', hasCrlf: true }),
    ];

    const result = evaluateProjectReadiness(status);

    expect(result.ready).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining('CRLF line endings'),
    );
    // Should NOT contain the generic "Hooks not installed" message
    expect(result.errors).not.toContainEqual(
      expect.stringContaining('Hooks not installed'),
    );
  });

  // -------------------------------------------------------------------------
  // Missing settings.json → blocked
  // -------------------------------------------------------------------------

  it('blocks launch when settings.json is not installed', () => {
    const status = makeGreenStatus();
    status.settings = makeFileStatus({ name: 'settings.json', exists: false });

    const result = evaluateProjectReadiness(status);

    expect(result.ready).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining('Settings file'),
    );
  });

  // -------------------------------------------------------------------------
  // Outdated files → blocked (not warning)
  // -------------------------------------------------------------------------

  it('blocks launch when installed files are outdated (not just a warning)', () => {
    const status = makeGreenStatus();
    status.outdatedCount = 3;

    const result = evaluateProjectReadiness(status);

    expect(result.ready).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining('3 installed file(s) are outdated'),
    );
    // Must be in errors, not warnings
    expect(result.warnings).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Amber git commit → blocked (not warning)
  // -------------------------------------------------------------------------

  it('blocks launch when git commit health is amber (not just a warning)', () => {
    const status = makeGreenStatus();
    status.gitCommitStatus = {
      health: 'amber',
      message: 'Files are outdated on default branch',
      gitignored: false,
      files: [],
    };

    const result = evaluateProjectReadiness(status);

    expect(result.ready).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining('Git commit check:'),
    );
    // Must be in errors, not warnings
    expect(result.warnings).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Red git commit → blocked
  // -------------------------------------------------------------------------

  it('blocks launch when git commit health is red', () => {
    const status = makeGreenStatus();
    status.gitCommitStatus = {
      health: 'red',
      message: 'Files not committed',
      gitignored: false,
      files: [],
    };

    const result = evaluateProjectReadiness(status);

    expect(result.ready).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining('Git commit check failed'),
    );
  });

  // -------------------------------------------------------------------------
  // .gitignore blocking
  // -------------------------------------------------------------------------

  it('blocks launch when .claude/ is in .gitignore', () => {
    const status = makeGreenStatus();
    status.gitCommitStatus = {
      health: 'red',
      message: '.claude/ is gitignored',
      gitignored: true,
      files: [],
    };

    const result = evaluateProjectReadiness(status);

    expect(result.ready).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining('.gitignore'),
    );
    // Should not duplicate with the red health error when gitignored is true
    expect(
      result.errors.filter((e) => e.includes('Git commit check failed')),
    ).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // GitHub settings (repoSettings) do NOT block
  // -------------------------------------------------------------------------

  it('does not block launch based on repoSettings (GitHub settings are informational)', () => {
    const status = makeGreenStatus();
    // Add repoSettings — they should have no effect on readiness
    status.repoSettings = {
      autoMergeEnabled: false,
      defaultBranch: 'main',
      branchProtection: {
        enabled: false,
        requiresPR: false,
        requiredChecks: [],
      },
    };

    const result = evaluateProjectReadiness(status);

    expect(result.ready).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Missing prompt → blocked
  // -------------------------------------------------------------------------

  it('blocks launch when prompt file is not installed', () => {
    const status = makeGreenStatus();
    status.prompt.installed = false;

    const result = evaluateProjectReadiness(status);

    expect(result.ready).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining('Prompt file not installed'),
    );
  });

  // -------------------------------------------------------------------------
  // Missing agents → blocked
  // -------------------------------------------------------------------------

  it('blocks launch when agent files are not installed', () => {
    const status = makeGreenStatus();
    status.agents.installed = false;

    const result = evaluateProjectReadiness(status);

    expect(result.ready).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining('Agent files not installed'),
    );
  });

  // -------------------------------------------------------------------------
  // Multiple errors accumulate
  // -------------------------------------------------------------------------

  it('accumulates multiple errors when multiple checks fail', () => {
    const status = makeGreenStatus();
    status.hooks.installed = false;
    status.hooks.found = 0;
    status.hooks.files = [];
    status.prompt.installed = false;
    status.agents.installed = false;
    status.settings = makeFileStatus({ name: 'settings.json', exists: false });
    status.outdatedCount = 2;

    const result = evaluateProjectReadiness(status);

    expect(result.ready).toBe(false);
    // Should have at least 5 errors: hooks, prompt, agents, settings, outdated
    expect(result.errors.length).toBeGreaterThanOrEqual(5);
  });
});
