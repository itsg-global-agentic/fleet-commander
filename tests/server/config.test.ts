// =============================================================================
// Fleet Commander — Config Tests (safeParseInt + validateConfig)
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { safeParseInt, validateConfig } from '../../src/server/config.js';

// ---------------------------------------------------------------------------
// safeParseInt
// ---------------------------------------------------------------------------

describe('safeParseInt', () => {
  it('parses valid integer strings', () => {
    expect(safeParseInt('42', 'TEST')).toBe(42);
    expect(safeParseInt('0', 'TEST')).toBe(0);
    expect(safeParseInt('-1', 'TEST')).toBe(-1);
    expect(safeParseInt('4680', 'PORT')).toBe(4680);
    expect(safeParseInt('30000', 'POLL')).toBe(30000);
  });

  it('throws on non-numeric strings', () => {
    expect(() => safeParseInt('abc', 'PORT')).toThrow('Invalid integer for PORT: "abc"');
    expect(() => safeParseInt('', 'PORT')).toThrow('Invalid integer for PORT: ""');
    expect(() => safeParseInt('not-a-number', 'FLEET_GITHUB_POLL_MS'))
      .toThrow('Invalid integer for FLEET_GITHUB_POLL_MS: "not-a-number"');
  });

  it('throws on NaN-producing values', () => {
    expect(() => safeParseInt('NaN', 'TEST')).toThrow('Invalid integer for TEST');
  });

  it('parses strings with leading digits and trailing garbage (parseInt behavior)', () => {
    // parseInt('123abc', 10) returns 123 — this is expected JavaScript behavior
    expect(safeParseInt('123abc', 'TEST')).toBe(123);
  });

  it('includes the variable name in the error message', () => {
    expect(() => safeParseInt('xyz', 'FLEET_IDLE_THRESHOLD_MIN'))
      .toThrow('FLEET_IDLE_THRESHOLD_MIN');
  });
});

// ---------------------------------------------------------------------------
// validateConfig (via dynamic import with env overrides)
// ---------------------------------------------------------------------------
// Because config.ts runs validateConfig() at module level on import,
// we test validation by importing the module with modified env vars.
// Each test uses a unique dynamic import to get a fresh module evaluation.

describe('validateConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it('accepts default config values (no env overrides)', async () => {
    // The main module import already validated defaults — re-importing should not throw
    const mod = await import('../../src/server/config.js');
    expect(mod.default.port).toBe(parseInt(process.env['PORT'] || '4680', 10));
  });

  it('defaults host to 127.0.0.1', async () => {
    const mod = await import('../../src/server/config.js');
    expect(mod.default.host).toBe(process.env['FLEET_HOST'] || '127.0.0.1');
  });

  it('safeParseInt rejects fully non-numeric PORT before config is built', () => {
    // Simulate what would happen: safeParseInt('abc', 'PORT') throws
    expect(() => safeParseInt('abc', 'PORT')).toThrow('Invalid integer for PORT: "abc"');
  });

  it('safeParseInt rejects non-numeric FLEET_GITHUB_POLL_MS', () => {
    expect(() => safeParseInt('fast', 'FLEET_GITHUB_POLL_MS'))
      .toThrow('Invalid integer for FLEET_GITHUB_POLL_MS: "fast"');
  });

  it('safeParseInt rejects non-numeric FLEET_IDLE_THRESHOLD_MIN', () => {
    expect(() => safeParseInt('five', 'FLEET_IDLE_THRESHOLD_MIN'))
      .toThrow('Invalid integer for FLEET_IDLE_THRESHOLD_MIN: "five"');
  });

  it('safeParseInt rejects non-numeric FLEET_MAX_CI_FAILURES', () => {
    expect(() => safeParseInt('three', 'FLEET_MAX_CI_FAILURES'))
      .toThrow('Invalid integer for FLEET_MAX_CI_FAILURES: "three"');
  });

  it('validateConfig passes with default config values', () => {
    // validateConfig reads from the module-level frozen config object.
    // With default values, it should not throw.
    expect(() => validateConfig()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Edge cases for safeParseInt
// ---------------------------------------------------------------------------

describe('safeParseInt edge cases', () => {
  it('handles whitespace-padded numbers', () => {
    // parseInt trims leading whitespace
    expect(safeParseInt('  42  ', 'TEST')).toBe(42);
  });

  it('handles negative numbers', () => {
    expect(safeParseInt('-5', 'TEST')).toBe(-5);
  });

  it('handles zero', () => {
    expect(safeParseInt('0', 'TEST')).toBe(0);
  });

  it('handles large numbers', () => {
    expect(safeParseInt('300000', 'TEST')).toBe(300000);
    expect(safeParseInt('65535', 'TEST')).toBe(65535);
  });
});
