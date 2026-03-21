// =============================================================================
// Fleet Commander — resolveMessage() Tests
// =============================================================================
// Tests for the message template resolver that reads templates from the DB,
// substitutes {{PLACEHOLDER}} variables, and respects the enabled flag.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before import
// ---------------------------------------------------------------------------

const mockDb = {
  getMessageTemplate: vi.fn(),
};

vi.mock('../../src/server/db.js', () => ({
  getDatabase: () => mockDb,
}));

// Import after mocks are set up
const { resolveMessage } = await import('../../src/server/utils/resolve-message.js');

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// Basic placeholder substitution
// =============================================================================

describe('Placeholder substitution', () => {
  it('substitutes a single placeholder', () => {
    mockDb.getMessageTemplate.mockReturnValue({
      id: 'ci_green',
      template: 'CI passed on PR #{{PR_NUMBER}}.',
      enabled: true,
    });

    const result = resolveMessage('ci_green', { PR_NUMBER: '42' });
    expect(result).toBe('CI passed on PR #42.');
  });

  it('substitutes multiple placeholders', () => {
    mockDb.getMessageTemplate.mockReturnValue({
      id: 'ci_red',
      template: 'CI failed on PR #{{PR_NUMBER}}. Fails: {{FAIL_COUNT}}/{{MAX_FAILURES}}.',
      enabled: true,
    });

    const result = resolveMessage('ci_red', {
      PR_NUMBER: '99',
      FAIL_COUNT: '2',
      MAX_FAILURES: '3',
    });
    expect(result).toBe('CI failed on PR #99. Fails: 2/3.');
  });

  it('substitutes all occurrences of the same placeholder', () => {
    mockDb.getMessageTemplate.mockReturnValue({
      id: 'test',
      template: 'Issue #{{NUM}} is about #{{NUM}} again.',
      enabled: true,
    });

    const result = resolveMessage('test', { NUM: '7' });
    expect(result).toBe('Issue #7 is about #7 again.');
  });

  it('leaves unreferenced placeholders in vars without error', () => {
    mockDb.getMessageTemplate.mockReturnValue({
      id: 'simple',
      template: 'Hello {{NAME}}.',
      enabled: true,
    });

    const result = resolveMessage('simple', { NAME: 'World', EXTRA: 'unused' });
    expect(result).toBe('Hello World.');
  });
});

// =============================================================================
// Missing placeholders
// =============================================================================

describe('Missing placeholder handling', () => {
  it('leaves unresolved placeholders in the output when vars are missing', () => {
    mockDb.getMessageTemplate.mockReturnValue({
      id: 'partial',
      template: 'PR #{{PR_NUMBER}} by {{AUTHOR}}.',
      enabled: true,
    });

    const result = resolveMessage('partial', { PR_NUMBER: '10' });
    // {{AUTHOR}} was not provided — left as-is
    expect(result).toBe('PR #10 by {{AUTHOR}}.');
  });

  it('returns template as-is when vars is empty', () => {
    mockDb.getMessageTemplate.mockReturnValue({
      id: 'no_vars',
      template: 'Static message with {{PLACEHOLDER}}.',
      enabled: true,
    });

    const result = resolveMessage('no_vars', {});
    expect(result).toBe('Static message with {{PLACEHOLDER}}.');
  });
});

// =============================================================================
// Template enabled/disabled
// =============================================================================

describe('Template enabled/disabled', () => {
  it('returns null when template is disabled', () => {
    mockDb.getMessageTemplate.mockReturnValue({
      id: 'ci_green',
      template: 'CI passed.',
      enabled: false,
    });

    const result = resolveMessage('ci_green', { PR_NUMBER: '1' });
    expect(result).toBeNull();
  });

  it('returns the resolved message when template is enabled', () => {
    mockDb.getMessageTemplate.mockReturnValue({
      id: 'ci_green',
      template: 'CI passed on PR #{{PR_NUMBER}}.',
      enabled: true,
    });

    const result = resolveMessage('ci_green', { PR_NUMBER: '1' });
    expect(result).toBe('CI passed on PR #1.');
  });
});

// =============================================================================
// Template not found
// =============================================================================

describe('Template not found', () => {
  it('returns null when template ID does not exist', () => {
    mockDb.getMessageTemplate.mockReturnValue(undefined);

    const result = resolveMessage('nonexistent', { KEY: 'value' });
    expect(result).toBeNull();
  });

  it('returns null when getMessageTemplate returns null', () => {
    mockDb.getMessageTemplate.mockReturnValue(null);

    const result = resolveMessage('also_missing', {});
    expect(result).toBeNull();
  });
});

// =============================================================================
// DB lookup
// =============================================================================

describe('DB template lookup', () => {
  it('calls getMessageTemplate with the correct template ID', () => {
    mockDb.getMessageTemplate.mockReturnValue({
      id: 'idle_nudge',
      template: 'Idle for {{IDLE_MINUTES}} min.',
      enabled: true,
    });

    resolveMessage('idle_nudge', { IDLE_MINUTES: '5' });

    expect(mockDb.getMessageTemplate).toHaveBeenCalledTimes(1);
    expect(mockDb.getMessageTemplate).toHaveBeenCalledWith('idle_nudge');
  });
});
