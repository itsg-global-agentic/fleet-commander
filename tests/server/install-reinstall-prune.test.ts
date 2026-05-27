// =============================================================================
// Fleet Commander — Install Reinstall Stale-Hook Pruning Tests (issue #760)
// =============================================================================
// Verifies that:
//   (a) `detectHookDrift` correctly identifies FC hook types in a project's
//       `.claude/settings.json` whose parent hook type is absent from the
//       current FC template.
//   (b) `checkInstallStatus` surfaces drift via `installStatus.driftHookTypes`.
//   (c) `scripts/install.sh` (via `installHooks`) prunes stale FC hook
//       entries and reports them on stdout.
// Tests use a real temporary directory + real fs — no mocks. The end-to-end
// install.sh test skips cleanly when Git Bash is unavailable.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { detectHookDrift, checkInstallStatus } from '../../src/server/services/project-service.js';
import { installHooks } from '../../src/server/utils/hook-installer.js';
import config from '../../src/server/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-prune-stale-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Write a `.claude/settings.json` to the tmp repo with the given hook map.
 * Returns the absolute path that was written.
 */
function writeSettings(hooks: Record<string, unknown>): string {
  const settingsDir = path.join(tmpDir, '.claude');
  fs.mkdirSync(settingsDir, { recursive: true });
  const settingsPath = path.join(settingsDir, 'settings.json');
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ hooks }, null, 2),
  );
  return settingsPath;
}

/** Build a single-entry http FC hook entry for the given hook type. */
function httpFcEntry(hookType: string, port = 4680): {
  hooks: Array<{ type: string; url: string }>;
} {
  return {
    hooks: [
      {
        type: 'http',
        url: `http://localhost:${port}/api/hooks/${hookType}`,
      },
    ],
  };
}

/** Build a single-entry bash FC hook entry for the given hook type. */
function bashFcEntry(hookType: string): {
  hooks: Array<{ type: string; command: string }>;
} {
  return {
    hooks: [
      {
        type: 'command',
        command: `bash .claude/hooks/fleet-commander/run-hook.sh ${hookType}`,
      },
    ],
  };
}

/** Read and parse the current http settings example for comparison. */
function loadHttpTemplateTypes(): string[] {
  const templatePath = path.join(config.fcHooksDir, 'settings.json.http.example');
  const raw = fs.readFileSync(templatePath, 'utf-8');
  const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown> };
  return Object.keys(parsed.hooks || {});
}

/**
 * Check whether Git Bash is available so the install.sh integration test can
 * skip gracefully on hosts where it is not installed. Matches the pattern used
 * by `tests/server/find-git-bash.test.ts`.
 */
function gitBashAvailable(): boolean {
  if (process.platform !== 'win32') return true; // POSIX bash is assumed
  try {
    const out = execSync('where bash.exe', { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Group A — detectHookDrift unit tests
// ---------------------------------------------------------------------------

describe('detectHookDrift', () => {
  it('returns [] when .claude/settings.json does not exist', () => {
    expect(detectHookDrift(tmpDir)).toEqual([]);
  });

  it('returns [] when settings.json has no FC entries', () => {
    writeSettings({
      Stop: [
        {
          hooks: [{ type: 'command', command: 'echo hello' }],
        },
      ],
    });
    expect(detectHookDrift(tmpDir)).toEqual([]);
  });

  it('returns [] when settings.json contains only in-template FC types (http)', () => {
    const templateTypes = loadHttpTemplateTypes();
    // Pick the first three template types — they must all be in-sync.
    const hooks: Record<string, unknown> = {};
    for (const t of templateTypes.slice(0, 3)) {
      hooks[t] = [httpFcEntry(t)];
    }
    writeSettings(hooks);
    expect(detectHookDrift(tmpDir)).toEqual([]);
  });

  it('returns single stale hook type when http FC entry is for a key not in template', () => {
    const templateTypes = loadHttpTemplateTypes();
    expect(templateTypes).not.toContain('WorktreeCreate');
    writeSettings({
      WorktreeCreate: [httpFcEntry('WorktreeCreate')],
      // Plus one in-template entry to prove non-stale entries are not flagged
      SessionStart: [httpFcEntry('SessionStart')],
    });
    expect(detectHookDrift(tmpDir)).toEqual(['WorktreeCreate']);
  });

  it('returns multiple stale hook types sorted alphabetically', () => {
    writeSettings({
      WorktreeRemove: [httpFcEntry('WorktreeRemove')],
      WorktreeCreate: [httpFcEntry('WorktreeCreate')],
      SessionStart: [httpFcEntry('SessionStart')],
    });
    expect(detectHookDrift(tmpDir)).toEqual(['WorktreeCreate', 'WorktreeRemove']);
  });

  it('auto-detects http mode when FC entry uses url', () => {
    writeSettings({
      WorktreeCreate: [httpFcEntry('WorktreeCreate')],
    });
    // No explicit mode — auto-detect picks http because url is present.
    // 'WorktreeCreate' is absent from the http template -> reported.
    expect(detectHookDrift(tmpDir)).toEqual(['WorktreeCreate']);
  });

  it('auto-detects bash mode when FC entry uses command', () => {
    // 'PermissionRequest' is in the http template but NOT in the bash
    // template, so bash-mode autodetect should flag it as drift.
    writeSettings({
      PermissionRequest: [bashFcEntry('PermissionRequest')],
    });
    expect(detectHookDrift(tmpDir)).toEqual(['PermissionRequest']);
  });

  it('honours an explicit mode argument over auto-detection', () => {
    // 'WorktreeCreate' is in the bash template but NOT in the http template.
    // The settings.json uses url-based entries (auto-detect would say http).
    // With explicit mode='bash' the function must use the bash template, so
    // 'WorktreeCreate' is NOT stale. With explicit mode='http' it IS stale.
    writeSettings({
      WorktreeCreate: [httpFcEntry('WorktreeCreate')],
    });
    expect(detectHookDrift(tmpDir, 'bash')).toEqual([]);
    expect(detectHookDrift(tmpDir, 'http')).toEqual(['WorktreeCreate']);
  });

  it('returns [] on malformed JSON without throwing', () => {
    const settingsDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, 'settings.json'), '{ this is not json');
    expect(() => detectHookDrift(tmpDir)).not.toThrow();
    expect(detectHookDrift(tmpDir)).toEqual([]);
  });

  it('ignores hook types whose FC entries are mixed with user entries', () => {
    const templateTypes = loadHttpTemplateTypes();
    expect(templateTypes).toContain('Stop');
    writeSettings({
      // Stop has BOTH a user-defined entry AND an FC entry — Stop IS in the
      // template so it must not show up as stale.
      Stop: [
        { hooks: [{ type: 'command', command: 'echo user-only' }] },
        httpFcEntry('Stop'),
      ],
    });
    expect(detectHookDrift(tmpDir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Group B — checkInstallStatus surfaces drift
// ---------------------------------------------------------------------------

describe('checkInstallStatus drift integration', () => {
  it('exposes driftHookTypes when settings.json has a stale FC entry', () => {
    writeSettings({
      WorktreeCreate: [httpFcEntry('WorktreeCreate')],
    });
    const status = checkInstallStatus(tmpDir);
    expect(status.driftHookTypes).toBeDefined();
    expect(status.driftHookTypes).toContain('WorktreeCreate');
  });

  it('returns empty driftHookTypes when settings.json is in sync with template', () => {
    const templateTypes = loadHttpTemplateTypes();
    const hooks: Record<string, unknown> = {};
    for (const t of templateTypes.slice(0, 2)) {
      hooks[t] = [httpFcEntry(t)];
    }
    writeSettings(hooks);
    const status = checkInstallStatus(tmpDir);
    expect(status.driftHookTypes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Group C — install.sh strip+report end-to-end
// ---------------------------------------------------------------------------

describe('install.sh prunes stale FC entries and reports them on stdout', () => {
  it.skipIf(!gitBashAvailable())(
    'removes a stale WorktreeCreate entry and prints "Removed 1 stale hook entries: WorktreeCreate"',
    () => {
      // Initialise a tmp git repo so install.sh can operate (some steps may
      // assume the target is a directory; git status not required for this
      // path, but mirrors real usage).
      execSync('git init -q', { cwd: tmpDir, stdio: 'pipe' });

      // Seed an existing settings.json with one stale FC entry plus one
      // in-template entry, to prove the stale one is removed without
      // disturbing the in-template one.
      writeSettings({
        WorktreeCreate: [httpFcEntry('WorktreeCreate')],
        SessionStart: [httpFcEntry('SessionStart')],
      });

      // Minimal noop logger — installHooks expects a FastifyBaseLogger but
      // only calls .info/.error.
      const logger = {
        info: () => undefined,
        error: () => undefined,
        warn: () => undefined,
        debug: () => undefined,
        trace: () => undefined,
        fatal: () => undefined,
        child: () => logger,
        level: 'info',
      } as unknown as Parameters<typeof installHooks>[1];

      const result = installHooks(tmpDir, logger, { mode: 'http', port: 4680 });
      expect(result.ok).toBe(true);

      // The "removed N stale hook entries" line must appear in stdout.
      expect(result.stdout).toContain('Removed 1 stale hook entries: WorktreeCreate');

      // settings.json must no longer have a `WorktreeCreate` key.
      const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
        hooks?: Record<string, unknown>;
      };
      expect(settings.hooks).toBeDefined();
      expect(Object.keys(settings.hooks || {})).not.toContain('WorktreeCreate');

      // SessionStart should still be present (it is in the template).
      expect(Object.keys(settings.hooks || {})).toContain('SessionStart');
    },
    30_000,
  );

  it.skipIf(!gitBashAvailable())(
    'does NOT print "Removed N stale hook entries" when no stale entries exist',
    () => {
      execSync('git init -q', { cwd: tmpDir, stdio: 'pipe' });

      // Seed settings.json with only in-template entries (no drift).
      writeSettings({
        SessionStart: [httpFcEntry('SessionStart')],
      });

      const logger = {
        info: () => undefined,
        error: () => undefined,
        warn: () => undefined,
        debug: () => undefined,
        trace: () => undefined,
        fatal: () => undefined,
        child: () => logger,
        level: 'info',
      } as unknown as Parameters<typeof installHooks>[1];

      const result = installHooks(tmpDir, logger, { mode: 'http', port: 4680 });
      expect(result.ok).toBe(true);

      // No "Removed N stale hook entries" line should appear.
      expect(result.stdout).not.toMatch(/Removed \d+ stale hook entries/);
    },
    30_000,
  );
});
