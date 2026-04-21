// =============================================================================
// Fleet Commander — cc-spawn module unit tests
// =============================================================================
// Verifies all exported helpers and spawn functions from cc-spawn.ts:
//   - buildEnv()            — environment construction
//   - buildHeadlessArgs()   — headless (stream-json) CLI args
//   - buildInteractiveArgs()— interactive (terminal) CLI args
//   - buildQueryArgs()      — query (-p one-shot) CLI args
//   - escapeCmdArg()        — Windows cmd.exe argument escaping
//   - spawnHeadless()       — headless CC process via execa
//   - spawnInteractive()    — interactive CC via temp .cmd file
//   - spawnQuery()          — query CC via child_process.spawn
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Hoisted mocks — available before vi.mock() factory functions run
// ---------------------------------------------------------------------------

const mockConfig = vi.hoisted(() => ({
  skipPermissions: true,
  enableAgentTeams: true,
  promptCache1h: true,
  terminalCmd: 'auto' as 'auto' | 'wt' | 'cmd',
  ccQueryModel: 'sonnet',
  ccQueryTimeoutMs: 30000,
  ccQueryMaxTurns: 4,
}));

const mockExeca = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());
const mockResolveClaudePath = vi.hoisted(() => vi.fn().mockReturnValue('/usr/bin/claude'));
const mockFindGitBash = vi.hoisted(() => vi.fn().mockReturnValue(null));
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockUnlinkSync = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/server/config.js', () => ({
  default: mockConfig,
}));

vi.mock('../../src/server/utils/resolve-claude-path.js', () => ({
  resolveClaudePath: mockResolveClaudePath,
}));

vi.mock('../../src/server/utils/find-git-bash.js', () => ({
  findGitBash: mockFindGitBash,
}));

vi.mock('execa', () => ({
  execa: mockExeca,
}));

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: mockWriteFileSync,
      unlinkSync: mockUnlinkSync,
    },
    writeFileSync: mockWriteFileSync,
    unlinkSync: mockUnlinkSync,
  };
});

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are registered
// ---------------------------------------------------------------------------

import {
  buildEnv,
  buildHeadlessArgs,
  buildInteractiveArgs,
  buildQueryArgs,
  escapeCmdArg,
  spawnHeadless,
  spawnInteractive,
  spawnQuery,
} from '../../src/server/utils/cc-spawn.js';
import type { FleetEnvContext } from '../../src/server/utils/cc-spawn.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFleetContext(overrides?: Partial<FleetEnvContext>): FleetEnvContext {
  return {
    teamId: 'my-project-42',
    projectId: 7,
    githubRepo: 'owner/repo',
    ...overrides,
  };
}

interface MockChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
}

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 12345;
  child.kill = vi.fn();
  child.unref = vi.fn();
  return child;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cc-spawn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: false });
    // Reset config to defaults
    mockConfig.skipPermissions = true;
    mockConfig.enableAgentTeams = true;
    mockConfig.promptCache1h = true;
    mockConfig.terminalCmd = 'auto';
    mockConfig.ccQueryModel = 'sonnet';
    mockConfig.ccQueryTimeoutMs = 30000;
    mockConfig.ccQueryMaxTurns = 4;
    mockResolveClaudePath.mockReturnValue('/usr/bin/claude');
    mockFindGitBash.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // buildEnv()
  // =========================================================================

  describe('buildEnv', () => {
    it('includes FLEET_TEAM_ID, FLEET_PROJECT_ID, FLEET_GITHUB_REPO when context is provided', () => {
      const ctx = makeFleetContext();
      const env = buildEnv(ctx);

      expect(env['FLEET_TEAM_ID']).toBe('my-project-42');
      expect(env['FLEET_PROJECT_ID']).toBe('7');
      expect(env['FLEET_GITHUB_REPO']).toBe('owner/repo');
    });

    it('omits FLEET_* vars when no context is provided (query mode)', () => {
      const env = buildEnv();

      expect(env['FLEET_TEAM_ID']).toBeUndefined();
      expect(env['FLEET_PROJECT_ID']).toBeUndefined();
      expect(env['FLEET_GITHUB_REPO']).toBeUndefined();
    });

    it('includes CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS when enableAgentTeams is true', () => {
      mockConfig.enableAgentTeams = true;
      const env = buildEnv(makeFleetContext());

      expect(env['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS']).toBe('1');
    });

    it('sets CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS to undefined when enableAgentTeams is false', () => {
      mockConfig.enableAgentTeams = false;
      const env = buildEnv(makeFleetContext());

      expect(env['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS']).toBeUndefined();
    });

    it('includes CLAUDE_CODE_GIT_BASH_PATH when findGitBash returns a path', () => {
      mockFindGitBash.mockReturnValue('C:\\Program Files\\Git\\bin\\bash.exe');
      const env = buildEnv(makeFleetContext());

      expect(env['CLAUDE_CODE_GIT_BASH_PATH']).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    });

    it('does not include CLAUDE_CODE_GIT_BASH_PATH when findGitBash returns null', () => {
      mockFindGitBash.mockReturnValue(null);
      const env = buildEnv(makeFleetContext());

      // Should not set the key (undefined is also acceptable since Node drops it)
      expect(env['CLAUDE_CODE_GIT_BASH_PATH']).toBeUndefined();
    });

    it('inherits process.env entries', () => {
      const env = buildEnv();

      // PATH is always present in process.env
      expect(env['PATH']).toBeDefined();
    });

    it('converts projectId to string', () => {
      const ctx = makeFleetContext({ projectId: 99 });
      const env = buildEnv(ctx);

      expect(env['FLEET_PROJECT_ID']).toBe('99');
      expect(typeof env['FLEET_PROJECT_ID']).toBe('string');
    });

    it('includes ENABLE_PROMPT_CACHING_1H when promptCache1h is true', () => {
      mockConfig.promptCache1h = true;
      const env = buildEnv(makeFleetContext());

      expect(env['ENABLE_PROMPT_CACHING_1H']).toBe('1');
    });

    it('sets ENABLE_PROMPT_CACHING_1H to undefined when promptCache1h is false', () => {
      mockConfig.promptCache1h = false;
      const env = buildEnv(makeFleetContext());

      expect(env['ENABLE_PROMPT_CACHING_1H']).toBeUndefined();
    });
  });

  // =========================================================================
  // buildHeadlessArgs()
  // =========================================================================

  describe('buildHeadlessArgs', () => {
    it('includes --worktree with the worktree name', () => {
      const args = buildHeadlessArgs({ worktreeName: 'test-wt' });

      expect(args).toContain('--worktree');
      const wtIdx = args.indexOf('--worktree');
      expect(args[wtIdx + 1]).toBe('test-wt');
    });

    it('includes stream-json input/output format flags', () => {
      const args = buildHeadlessArgs({ worktreeName: 'test-wt' });

      expect(args).toContain('--input-format');
      expect(args).toContain('--output-format');
      const inIdx = args.indexOf('--input-format');
      const outIdx = args.indexOf('--output-format');
      expect(args[inIdx + 1]).toBe('stream-json');
      expect(args[outIdx + 1]).toBe('stream-json');
    });

    it('includes --verbose flag', () => {
      const args = buildHeadlessArgs({ worktreeName: 'test-wt' });

      expect(args).toContain('--verbose');
    });

    it('includes --include-partial-messages flag', () => {
      const args = buildHeadlessArgs({ worktreeName: 'test-wt' });

      expect(args).toContain('--include-partial-messages');
    });

    it('includes --dangerously-skip-permissions when config.skipPermissions is true', () => {
      mockConfig.skipPermissions = true;
      const args = buildHeadlessArgs({ worktreeName: 'test-wt' });

      expect(args).toContain('--dangerously-skip-permissions');
    });

    it('excludes --dangerously-skip-permissions when config.skipPermissions is false', () => {
      mockConfig.skipPermissions = false;
      const args = buildHeadlessArgs({ worktreeName: 'test-wt' });

      expect(args).not.toContain('--dangerously-skip-permissions');
    });

    it('includes --model when provided', () => {
      const args = buildHeadlessArgs({ worktreeName: 'test-wt', model: 'opus' });

      expect(args).toContain('--model');
      const modelIdx = args.indexOf('--model');
      expect(args[modelIdx + 1]).toBe('opus');
    });

    it('excludes --model when not provided', () => {
      const args = buildHeadlessArgs({ worktreeName: 'test-wt' });

      expect(args).not.toContain('--model');
    });

    it('excludes --model when model is null', () => {
      const args = buildHeadlessArgs({ worktreeName: 'test-wt', model: null });

      expect(args).not.toContain('--model');
    });

    it('includes --effort when provided', () => {
      const args = buildHeadlessArgs({ worktreeName: 'test-wt', effort: 'max' });

      expect(args).toContain('--effort');
      const effortIdx = args.indexOf('--effort');
      expect(args[effortIdx + 1]).toBe('max');
    });

    it('excludes --effort when not provided', () => {
      const args = buildHeadlessArgs({ worktreeName: 'test-wt' });

      expect(args).not.toContain('--effort');
    });

    it('excludes --effort when effort is null', () => {
      const args = buildHeadlessArgs({ worktreeName: 'test-wt', effort: null });

      expect(args).not.toContain('--effort');
    });

    it('includes --resume when resume is true', () => {
      const args = buildHeadlessArgs({ worktreeName: 'test-wt', resume: true });

      expect(args).toContain('--resume');
    });

    it('excludes --resume when resume is false', () => {
      const args = buildHeadlessArgs({ worktreeName: 'test-wt', resume: false });

      expect(args).not.toContain('--resume');
    });

    it('excludes --resume when resume is not provided', () => {
      const args = buildHeadlessArgs({ worktreeName: 'test-wt' });

      expect(args).not.toContain('--resume');
    });

    it('does not include any prompt argument', () => {
      const args = buildHeadlessArgs({ worktreeName: 'test-wt' });

      // Headless mode sends prompt via stdin, not as a CLI arg
      expect(args).not.toContain('-p');
    });
  });

  // =========================================================================
  // buildInteractiveArgs()
  // =========================================================================

  describe('buildInteractiveArgs', () => {
    it('includes --worktree with the worktree name', () => {
      const args = buildInteractiveArgs({ worktreeName: 'proj-99' });

      expect(args).toContain('--worktree');
      const wtIdx = args.indexOf('--worktree');
      expect(args[wtIdx + 1]).toBe('proj-99');
    });

    it('includes --dangerously-skip-permissions when config.skipPermissions is true', () => {
      mockConfig.skipPermissions = true;
      const args = buildInteractiveArgs({ worktreeName: 'proj-99' });

      expect(args).toContain('--dangerously-skip-permissions');
    });

    it('excludes --dangerously-skip-permissions when config.skipPermissions is false', () => {
      mockConfig.skipPermissions = false;
      const args = buildInteractiveArgs({ worktreeName: 'proj-99' });

      expect(args).not.toContain('--dangerously-skip-permissions');
    });

    it('includes --model when provided', () => {
      const args = buildInteractiveArgs({ worktreeName: 'proj-99', model: 'haiku' });

      expect(args).toContain('--model');
      const modelIdx = args.indexOf('--model');
      expect(args[modelIdx + 1]).toBe('haiku');
    });

    it('excludes --model when not provided', () => {
      const args = buildInteractiveArgs({ worktreeName: 'proj-99' });

      expect(args).not.toContain('--model');
    });

    it('excludes --model when model is null', () => {
      const args = buildInteractiveArgs({ worktreeName: 'proj-99', model: null });

      expect(args).not.toContain('--model');
    });

    it('includes --effort when provided', () => {
      const args = buildInteractiveArgs({ worktreeName: 'proj-99', effort: 'high' });

      expect(args).toContain('--effort');
      const effortIdx = args.indexOf('--effort');
      expect(args[effortIdx + 1]).toBe('high');
    });

    it('excludes --effort when not provided', () => {
      const args = buildInteractiveArgs({ worktreeName: 'proj-99' });

      expect(args).not.toContain('--effort');
    });

    it('excludes --effort when effort is null', () => {
      const args = buildInteractiveArgs({ worktreeName: 'proj-99', effort: null });

      expect(args).not.toContain('--effort');
    });

    it('does NOT include stream-json flags (interactive mode)', () => {
      const args = buildInteractiveArgs({ worktreeName: 'proj-99' });

      expect(args).not.toContain('--input-format');
      expect(args).not.toContain('--output-format');
      expect(args).not.toContain('stream-json');
    });

    it('does NOT include --verbose flag', () => {
      const args = buildInteractiveArgs({ worktreeName: 'proj-99' });

      expect(args).not.toContain('--verbose');
    });
  });

  // =========================================================================
  // buildQueryArgs()
  // =========================================================================

  describe('buildQueryArgs', () => {
    const baseOptions = {
      prompt: 'Analyze this code',
      jsonSchema: { type: 'object', properties: { result: { type: 'string' } } },
    };

    it('includes -p with the prompt text', () => {
      const args = buildQueryArgs(baseOptions);

      expect(args).toContain('-p');
      const pIdx = args.indexOf('-p');
      expect(args[pIdx + 1]).toBe('Analyze this code');
    });

    it('includes --output-format json', () => {
      const args = buildQueryArgs(baseOptions);

      const idx = args.indexOf('--output-format');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('json');
    });

    it('includes --no-session-persistence', () => {
      const args = buildQueryArgs(baseOptions);

      expect(args).toContain('--no-session-persistence');
    });

    it('includes --json-schema with serialized JSON', () => {
      const schema = { type: 'object', properties: { x: { type: 'number' } } };
      const args = buildQueryArgs({ ...baseOptions, jsonSchema: schema });

      const idx = args.indexOf('--json-schema');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe(JSON.stringify(schema));
    });

    it('uses config.ccQueryMaxTurns when maxTurns is not provided', () => {
      mockConfig.ccQueryMaxTurns = 4;
      const args = buildQueryArgs(baseOptions);

      const idx = args.indexOf('--max-turns');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('4');
    });

    it('uses provided maxTurns over config default', () => {
      const args = buildQueryArgs({ ...baseOptions, maxTurns: 10 });

      const idx = args.indexOf('--max-turns');
      expect(args[idx + 1]).toBe('10');
    });

    it('uses config.ccQueryModel when model is not provided', () => {
      mockConfig.ccQueryModel = 'sonnet';
      const args = buildQueryArgs(baseOptions);

      const idx = args.indexOf('--model');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('sonnet');
    });

    it('uses provided model over config default', () => {
      const args = buildQueryArgs({ ...baseOptions, model: 'opus' });

      const idx = args.indexOf('--model');
      expect(args[idx + 1]).toBe('opus');
    });

    it('includes --tools with empty string', () => {
      const args = buildQueryArgs(baseOptions);

      const idx = args.indexOf('--tools');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('');
    });

    it('includes --strict-mcp-config', () => {
      const args = buildQueryArgs(baseOptions);

      expect(args).toContain('--strict-mcp-config');
    });

    it('includes --disable-slash-commands', () => {
      const args = buildQueryArgs(baseOptions);

      expect(args).toContain('--disable-slash-commands');
    });
  });

  // =========================================================================
  // escapeCmdArg()
  // =========================================================================

  describe('escapeCmdArg', () => {
    it('wraps a simple string in double quotes', () => {
      expect(escapeCmdArg('hello')).toBe('"hello"');
    });

    it('wraps a string with spaces in double quotes', () => {
      expect(escapeCmdArg('hello world')).toBe('"hello world"');
    });

    it('escapes embedded double quotes by doubling them', () => {
      expect(escapeCmdArg('say "hi"')).toBe('"say ""hi"""');
    });

    it('escapes percent signs by doubling them', () => {
      expect(escapeCmdArg('100% done')).toBe('"100%% done"');
    });

    it('handles both " and % in the same string', () => {
      expect(escapeCmdArg('50% "done"')).toBe('"50%% ""done"""');
    });

    it('preserves backslashes (not special in cmd.exe double-quoted strings)', () => {
      expect(escapeCmdArg('C:\\Program Files\\x')).toBe('"C:\\Program Files\\x"');
    });

    it('handles empty string', () => {
      expect(escapeCmdArg('')).toBe('""');
    });

    it('does not escape &, |, <, > (not special inside double quotes)', () => {
      expect(escapeCmdArg('a & b | c < d > e')).toBe('"a & b | c < d > e"');
    });
  });

  // =========================================================================
  // spawnHeadless()
  // =========================================================================

  describe('spawnHeadless', () => {
    it('calls execa with the resolved claude path', () => {
      mockResolveClaudePath.mockReturnValue('/custom/claude');
      const fakeChild = createMockChild();
      mockExeca.mockReturnValue(fakeChild);

      spawnHeadless({
        mode: 'headless',
        cwd: '/tmp/worktree',
        worktreeName: 'proj-42',
        fleetContext: makeFleetContext(),
      });

      expect(mockExeca).toHaveBeenCalledTimes(1);
      const [execPath] = mockExeca.mock.calls[0];
      expect(execPath).toBe('/custom/claude');
    });

    it('passes headless args to execa', () => {
      const fakeChild = createMockChild();
      mockExeca.mockReturnValue(fakeChild);

      spawnHeadless({
        mode: 'headless',
        cwd: '/tmp/worktree',
        worktreeName: 'proj-42',
        fleetContext: makeFleetContext(),
        model: 'opus',
        resume: true,
      });

      const [, args] = mockExeca.mock.calls[0];
      expect(args).toContain('--worktree');
      expect(args).toContain('proj-42');
      expect(args).toContain('--input-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('--model');
      expect(args).toContain('opus');
      expect(args).toContain('--resume');
    });

    it('sets stdio to pipe for stdin, stdout, stderr', () => {
      const fakeChild = createMockChild();
      mockExeca.mockReturnValue(fakeChild);

      spawnHeadless({
        mode: 'headless',
        cwd: '/tmp/worktree',
        worktreeName: 'proj-42',
        fleetContext: makeFleetContext(),
      });

      const [,, opts] = mockExeca.mock.calls[0];
      expect(opts.stdin).toBe('pipe');
      expect(opts.stdout).toBe('pipe');
      expect(opts.stderr).toBe('pipe');
    });

    it('sets buffer:false and reject:false', () => {
      const fakeChild = createMockChild();
      mockExeca.mockReturnValue(fakeChild);

      spawnHeadless({
        mode: 'headless',
        cwd: '/tmp/worktree',
        worktreeName: 'proj-42',
        fleetContext: makeFleetContext(),
      });

      const [,, opts] = mockExeca.mock.calls[0];
      expect(opts.buffer).toBe(false);
      expect(opts.reject).toBe(false);
    });

    it('sets extendEnv:false to prevent double-merging', () => {
      const fakeChild = createMockChild();
      mockExeca.mockReturnValue(fakeChild);

      spawnHeadless({
        mode: 'headless',
        cwd: '/tmp/worktree',
        worktreeName: 'proj-42',
        fleetContext: makeFleetContext(),
      });

      const [,, opts] = mockExeca.mock.calls[0];
      expect(opts.extendEnv).toBe(false);
    });

    it('passes cwd correctly', () => {
      const fakeChild = createMockChild();
      mockExeca.mockReturnValue(fakeChild);

      spawnHeadless({
        mode: 'headless',
        cwd: '/my/worktree/path',
        worktreeName: 'proj-42',
        fleetContext: makeFleetContext(),
      });

      const [,, opts] = mockExeca.mock.calls[0];
      expect(opts.cwd).toBe('/my/worktree/path');
    });

    it('passes fleet env vars in the environment', () => {
      const fakeChild = createMockChild();
      mockExeca.mockReturnValue(fakeChild);

      spawnHeadless({
        mode: 'headless',
        cwd: '/tmp/worktree',
        worktreeName: 'proj-42',
        fleetContext: makeFleetContext({ teamId: 'proj-42', projectId: 5, githubRepo: 'acme/lib' }),
      });

      const [,, opts] = mockExeca.mock.calls[0];
      expect(opts.env['FLEET_TEAM_ID']).toBe('proj-42');
      expect(opts.env['FLEET_PROJECT_ID']).toBe('5');
      expect(opts.env['FLEET_GITHUB_REPO']).toBe('acme/lib');
    });

    it('returns the subprocess (cast to ChildProcess)', () => {
      const fakeChild = createMockChild();
      mockExeca.mockReturnValue(fakeChild);

      const result = spawnHeadless({
        mode: 'headless',
        cwd: '/tmp/worktree',
        worktreeName: 'proj-42',
        fleetContext: makeFleetContext(),
      });

      // The returned object should be the mock child (after cast)
      expect(result).toBe(fakeChild);
    });

    it('sets windowsHide:true', () => {
      const fakeChild = createMockChild();
      mockExeca.mockReturnValue(fakeChild);

      spawnHeadless({
        mode: 'headless',
        cwd: '/tmp/worktree',
        worktreeName: 'proj-42',
        fleetContext: makeFleetContext(),
      });

      const [,, opts] = mockExeca.mock.calls[0];
      expect(opts.windowsHide).toBe(true);
    });
  });

  // =========================================================================
  // spawnInteractive()
  // =========================================================================

  describe('spawnInteractive', () => {
    beforeEach(() => {
      // spawnInteractive launches a shell process; mock it to return a detachable child
      const launcher = createMockChild();
      mockSpawn.mockReturnValue(launcher);

      // Mock detectWindowsTerminal — execa('where', ['wt.exe']) rejects by default
      mockExeca.mockRejectedValue(new Error('not found'));
    });

    it('writes a temp .cmd launcher file', async () => {
      const promise = spawnInteractive({
        mode: 'interactive',
        cwd: 'C:\\repos\\proj',
        worktreeName: 'proj-42',
        windowTitle: 'Team proj-42',
        fleetContext: makeFleetContext(),
        prompt: 'Fix the bug in main.ts',
        terminalPref: 'cmd',
      });

      await promise;

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const [filePath, content] = mockWriteFileSync.mock.calls[0];
      expect(filePath).toMatch(/fleet-cc-.*\.cmd$/);
      expect(content).toContain('@echo off');
    });

    it('launcher file contains cd /d to the worktree path', async () => {
      await spawnInteractive({
        mode: 'interactive',
        cwd: 'C:\\repos\\my project',
        worktreeName: 'proj-42',
        windowTitle: 'Team proj-42',
        fleetContext: makeFleetContext(),
        prompt: 'Fix it',
        terminalPref: 'cmd',
      });

      const [, content] = mockWriteFileSync.mock.calls[0];
      expect(content).toContain('cd /d "C:\\repos\\my project"');
    });

    it('launcher file contains SET commands for FLEET_* env vars', async () => {
      await spawnInteractive({
        mode: 'interactive',
        cwd: 'C:\\repos\\proj',
        worktreeName: 'proj-42',
        windowTitle: 'Team proj-42',
        fleetContext: makeFleetContext({ teamId: 'proj-42', projectId: 7, githubRepo: 'owner/repo' }),
        prompt: 'Fix it',
        terminalPref: 'cmd',
      });

      const [, content] = mockWriteFileSync.mock.calls[0];
      expect(content).toContain('SET "FLEET_TEAM_ID=proj-42"');
      expect(content).toContain('SET "FLEET_PROJECT_ID=7"');
      expect(content).toContain('SET "FLEET_GITHUB_REPO=owner/repo"');
    });

    it('launcher file contains the claude command with escaped prompt', async () => {
      await spawnInteractive({
        mode: 'interactive',
        cwd: 'C:\\repos\\proj',
        worktreeName: 'proj-42',
        windowTitle: 'Team proj-42',
        fleetContext: makeFleetContext(),
        prompt: 'Fix the "bug" at 100%',
        terminalPref: 'cmd',
      });

      const [, content] = mockWriteFileSync.mock.calls[0];
      // The prompt should have " doubled and % doubled
      expect(content).toContain('""bug""');
      expect(content).toContain('100%%');
    });

    it('launcher file contains --worktree arg', async () => {
      await spawnInteractive({
        mode: 'interactive',
        cwd: 'C:\\repos\\proj',
        worktreeName: 'proj-42',
        windowTitle: 'Team proj-42',
        fleetContext: makeFleetContext(),
        prompt: 'Fix it',
        terminalPref: 'cmd',
      });

      const [, content] = mockWriteFileSync.mock.calls[0];
      expect(content).toContain('"--worktree"');
      expect(content).toContain('"proj-42"');
    });

    it('uses start command for cmd terminal preference', async () => {
      await spawnInteractive({
        mode: 'interactive',
        cwd: 'C:\\repos\\proj',
        worktreeName: 'proj-42',
        windowTitle: 'Team proj-42',
        fleetContext: makeFleetContext(),
        prompt: 'Fix it',
        terminalPref: 'cmd',
      });

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [launchCmd] = mockSpawn.mock.calls[0];
      expect(launchCmd).toMatch(/^start "Team proj-42"/);
    });

    it('uses wt.exe command for wt terminal preference', async () => {
      await spawnInteractive({
        mode: 'interactive',
        cwd: 'C:\\repos\\proj',
        worktreeName: 'proj-42',
        windowTitle: 'Team proj-42',
        fleetContext: makeFleetContext(),
        prompt: 'Fix it',
        terminalPref: 'wt',
      });

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [launchCmd] = mockSpawn.mock.calls[0];
      expect(launchCmd).toMatch(/^wt\.exe new-tab --title "Team proj-42"/);
    });

    it('strips double quotes from window title', async () => {
      await spawnInteractive({
        mode: 'interactive',
        cwd: 'C:\\repos\\proj',
        worktreeName: 'proj-42',
        windowTitle: 'Team "proj-42"',
        fleetContext: makeFleetContext(),
        prompt: 'Fix it',
        terminalPref: 'cmd',
      });

      const [launchCmd] = mockSpawn.mock.calls[0];
      // Title should not contain unmatched double quotes inside the start "..." title
      expect(launchCmd).toContain('start "Team proj-42"');
    });

    it('spawns with shell:true and detached:true', async () => {
      await spawnInteractive({
        mode: 'interactive',
        cwd: 'C:\\repos\\proj',
        worktreeName: 'proj-42',
        windowTitle: 'Team proj-42',
        fleetContext: makeFleetContext(),
        prompt: 'Fix it',
        terminalPref: 'cmd',
      });

      const [, , opts] = mockSpawn.mock.calls[0];
      expect(opts.shell).toBe(true);
      expect(opts.detached).toBe(true);
      expect(opts.stdio).toBe('ignore');
    });

    it('schedules cleanup of the temp .cmd file after 60 seconds', async () => {
      await spawnInteractive({
        mode: 'interactive',
        cwd: 'C:\\repos\\proj',
        worktreeName: 'proj-42',
        windowTitle: 'Team proj-42',
        fleetContext: makeFleetContext(),
        prompt: 'Fix it',
        terminalPref: 'cmd',
      });

      // unlinkSync should not have been called yet
      expect(mockUnlinkSync).not.toHaveBeenCalled();

      // Advance time by 60 seconds to trigger cleanup
      vi.advanceTimersByTime(60_000);

      expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
      const [deletedPath] = mockUnlinkSync.mock.calls[0];
      expect(deletedPath).toMatch(/fleet-cc-.*\.cmd$/);
    });

    it('launcher file uses CRLF line endings', async () => {
      await spawnInteractive({
        mode: 'interactive',
        cwd: 'C:\\repos\\proj',
        worktreeName: 'proj-42',
        windowTitle: 'Team proj-42',
        fleetContext: makeFleetContext(),
        prompt: 'Fix it',
        terminalPref: 'cmd',
      });

      const [, content, writeOpts] = mockWriteFileSync.mock.calls[0];
      expect(content).toContain('\r\n');
      expect(writeOpts).toEqual({ encoding: 'utf8' });
    });

    it('cleans up temp .cmd file immediately when spawn throws', async () => {
      // Make spawn throw to simulate a failure after writeLauncherCmdFile
      mockSpawn.mockImplementation(() => { throw new Error('spawn ENOENT'); });

      await expect(spawnInteractive({
        mode: 'interactive',
        cwd: 'C:\\repos\\proj',
        worktreeName: 'proj-42',
        windowTitle: 'Team proj-42',
        fleetContext: makeFleetContext(),
        prompt: 'Fix it',
        terminalPref: 'cmd',
      })).rejects.toThrow('spawn ENOENT');

      // The .cmd file should have been written
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);

      // The finally block should have deleted the file immediately (no timer needed)
      expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
      const [deletedPath] = mockUnlinkSync.mock.calls[0];
      expect(deletedPath).toMatch(/fleet-cc-.*\.cmd$/);

      // No timer should have been scheduled for cleanup (it was immediate)
      vi.advanceTimersByTime(60_000);
      // Still only 1 call — no timer-based cleanup
      expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
    });

    it('includes CLAUDE_CODE_GIT_BASH_PATH SET in launcher when findGitBash returns path', async () => {
      mockFindGitBash.mockReturnValue('C:\\Program Files\\Git\\bin\\bash.exe');

      await spawnInteractive({
        mode: 'interactive',
        cwd: 'C:\\repos\\proj',
        worktreeName: 'proj-42',
        windowTitle: 'Team proj-42',
        fleetContext: makeFleetContext(),
        prompt: 'Fix it',
        terminalPref: 'cmd',
      });

      const [, content] = mockWriteFileSync.mock.calls[0];
      expect(content).toContain('SET "CLAUDE_CODE_GIT_BASH_PATH=C:\\Program Files\\Git\\bin\\bash.exe"');
    });
  });

  // =========================================================================
  // spawnQuery()
  // =========================================================================

  describe('spawnQuery', () => {
    it('calls spawn with the resolved claude path and query args', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      vi.useRealTimers();
      const promise = spawnQuery({
        mode: 'query',
        prompt: 'Analyze this',
        jsonSchema: { type: 'object' },
      });

      // Emit close to resolve
      setImmediate(() => child.emit('close', 0));
      await promise;

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [execPath, args] = mockSpawn.mock.calls[0];
      expect(execPath).toBe('/usr/bin/claude');
      expect(args).toContain('-p');
      expect(args).toContain('Analyze this');
      expect(args).toContain('--output-format');
    });

    it('sets stdio to [ignore, pipe, pipe]', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      vi.useRealTimers();
      const promise = spawnQuery({
        mode: 'query',
        prompt: 'Analyze',
        jsonSchema: { type: 'object' },
      });

      setImmediate(() => child.emit('close', 0));
      await promise;

      const [,, opts] = mockSpawn.mock.calls[0];
      expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    });

    it('sets windowsHide:true', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      vi.useRealTimers();
      const promise = spawnQuery({
        mode: 'query',
        prompt: 'Analyze',
        jsonSchema: { type: 'object' },
      });

      setImmediate(() => child.emit('close', 0));
      await promise;

      const [,, opts] = mockSpawn.mock.calls[0];
      expect(opts.windowsHide).toBe(true);
    });

    it('uses os.tmpdir() as default cwd', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      vi.useRealTimers();
      const promise = spawnQuery({
        mode: 'query',
        prompt: 'Analyze',
        jsonSchema: { type: 'object' },
      });

      setImmediate(() => child.emit('close', 0));
      await promise;

      const [,, opts] = mockSpawn.mock.calls[0];
      const os = await import('os');
      expect(opts.cwd).toBe(os.tmpdir());
    });

    it('uses provided cwd when specified', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      vi.useRealTimers();
      const promise = spawnQuery({
        mode: 'query',
        prompt: 'Analyze',
        jsonSchema: { type: 'object' },
        cwd: '/custom/dir',
      });

      setImmediate(() => child.emit('close', 0));
      await promise;

      const [,, opts] = mockSpawn.mock.calls[0];
      expect(opts.cwd).toBe('/custom/dir');
    });

    it('returns exitedOk:true on exit code 0', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      vi.useRealTimers();
      const promise = spawnQuery({
        mode: 'query',
        prompt: 'Analyze',
        jsonSchema: { type: 'object' },
      });

      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('output'));
        child.emit('close', 0);
      });

      const result = await promise;
      expect(result.exitedOk).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.stdout).toBe('output');
      expect(result.exitCode).toBe(0);
    });

    it('returns exitedOk:false on non-zero exit code', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      vi.useRealTimers();
      const promise = spawnQuery({
        mode: 'query',
        prompt: 'Analyze',
        jsonSchema: { type: 'object' },
      });

      setImmediate(() => {
        child.stderr.emit('data', Buffer.from('error message'));
        child.emit('close', 1);
      });

      const result = await promise;
      expect(result.exitedOk).toBe(false);
      expect(result.timedOut).toBe(false);
      expect(result.stderr).toBe('error message');
      expect(result.exitCode).toBe(1);
    });

    it('collects stdout from multiple data chunks', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      vi.useRealTimers();
      const promise = spawnQuery({
        mode: 'query',
        prompt: 'Analyze',
        jsonSchema: { type: 'object' },
      });

      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('chunk1'));
        child.stdout.emit('data', Buffer.from('chunk2'));
        child.emit('close', 0);
      });

      const result = await promise;
      expect(result.stdout).toBe('chunk1chunk2');
    });

    it('returns spawnError on spawn failure', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      vi.useRealTimers();
      const promise = spawnQuery({
        mode: 'query',
        prompt: 'Analyze',
        jsonSchema: { type: 'object' },
      });

      setImmediate(() => {
        child.emit('error', new Error('ENOENT'));
      });

      const result = await promise;
      expect(result.exitedOk).toBe(false);
      expect(result.spawnError).toBeInstanceOf(Error);
      expect(result.spawnError!.message).toBe('ENOENT');
      expect(result.exitCode).toBeNull();
    });

    it('records durationMs from spawn to close', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      vi.useRealTimers();
      const promise = spawnQuery({
        mode: 'query',
        prompt: 'Analyze',
        jsonSchema: { type: 'object' },
      });

      setImmediate(() => {
        child.emit('close', 0);
      });

      const result = await promise;
      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('passes env from buildEnv without fleet context (query mode)', async () => {
      mockConfig.enableAgentTeams = true;
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      vi.useRealTimers();
      const promise = spawnQuery({
        mode: 'query',
        prompt: 'Analyze',
        jsonSchema: { type: 'object' },
      });

      setImmediate(() => child.emit('close', 0));
      await promise;

      const [,, opts] = mockSpawn.mock.calls[0];
      // Query mode should NOT have fleet context vars
      expect(opts.env['FLEET_TEAM_ID']).toBeUndefined();
      expect(opts.env['FLEET_PROJECT_ID']).toBeUndefined();
      // But should still have agent teams flag
      expect(opts.env['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS']).toBe('1');
    });

    it('skips taskkill when child.pid is undefined on timeout', async () => {
      vi.useRealTimers();

      // Create a child with undefined pid to simulate a failed spawn
      const child = createMockChild();
      (child as { pid: number | undefined }).pid = undefined;

      let spawnCallCount = 0;
      mockSpawn.mockImplementation(() => {
        spawnCallCount++;
        if (spawnCallCount === 1) return child; // the CC spawn (with undefined pid)
        return createMockChild(); // should NOT be reached — no taskkill call
      });

      const promise = spawnQuery({
        mode: 'query',
        prompt: 'Analyze',
        jsonSchema: { type: 'object' },
        timeoutMs: 50,
      });

      // After the timeout fires, simulate the child closing
      setTimeout(() => {
        child.emit('close', null);
      }, 100);

      const result = await promise;
      expect(result.timedOut).toBe(true);
      expect(result.exitedOk).toBe(false);

      // spawn should have been called exactly once (for CC, not for taskkill)
      expect(spawnCallCount).toBe(1);
    });

    it('handles timeout by setting timedOut:true', async () => {
      // This test needs real timers so setTimeout fires naturally
      vi.useRealTimers();

      const child = createMockChild();
      // On Windows, the timeout handler calls spawn('taskkill', ...) to kill
      // the process tree. Return a dummy child for the taskkill call too.
      let spawnCallCount = 0;
      mockSpawn.mockImplementation(() => {
        spawnCallCount++;
        if (spawnCallCount === 1) return child; // the CC spawn
        return createMockChild(); // the taskkill spawn
      });

      // Use a very short timeout for the test
      const promise = spawnQuery({
        mode: 'query',
        prompt: 'Analyze',
        jsonSchema: { type: 'object' },
        timeoutMs: 50,
      });

      // After the timeout fires and kills the process, simulate the child
      // closing as the OS would after taskkill/SIGKILL.
      setTimeout(() => {
        child.emit('close', null);
      }, 100);

      const result = await promise;
      expect(result.timedOut).toBe(true);
      expect(result.exitedOk).toBe(false);
    });
  });
});
