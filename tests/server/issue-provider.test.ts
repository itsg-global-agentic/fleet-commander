// =============================================================================
// Fleet Commander — Issue Provider Type Guard Tests
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  isNormalizedStatus,
  isGenericIssue,
  type GenericIssue,
  type NormalizedStatus,
} from '../../src/shared/issue-provider.js';

// =============================================================================
// isNormalizedStatus
// =============================================================================

describe('isNormalizedStatus', () => {
  it('should return true for valid statuses', () => {
    const validStatuses: NormalizedStatus[] = ['open', 'in_progress', 'closed', 'unknown'];
    for (const status of validStatuses) {
      expect(isNormalizedStatus(status)).toBe(true);
    }
  });

  it('should return false for invalid string values', () => {
    expect(isNormalizedStatus('active')).toBe(false);
    expect(isNormalizedStatus('OPEN')).toBe(false);
    expect(isNormalizedStatus('in-progress')).toBe(false);
    expect(isNormalizedStatus('')).toBe(false);
    expect(isNormalizedStatus('todo')).toBe(false);
  });

  it('should return false for non-string values', () => {
    expect(isNormalizedStatus(null)).toBe(false);
    expect(isNormalizedStatus(undefined)).toBe(false);
    expect(isNormalizedStatus(42)).toBe(false);
    expect(isNormalizedStatus(true)).toBe(false);
    expect(isNormalizedStatus({})).toBe(false);
    expect(isNormalizedStatus([])).toBe(false);
  });
});

// =============================================================================
// isGenericIssue
// =============================================================================

describe('isGenericIssue', () => {
  const validIssue: GenericIssue = {
    key: '123',
    title: 'Fix login bug',
    status: 'open',
    rawStatus: 'OPEN',
    url: 'https://github.com/org/repo/issues/123',
    labels: ['bug', 'priority:high'],
    assignee: 'alice',
    priority: 1,
    parentKey: null,
    createdAt: '2026-03-27T10:00:00.000Z',
    updatedAt: '2026-03-27T12:00:00.000Z',
    provider: 'github',
  };

  it('should return true for a valid GenericIssue', () => {
    expect(isGenericIssue(validIssue)).toBe(true);
  });

  it('should return true with null optional fields', () => {
    const issue: GenericIssue = {
      key: 'PROJ-456',
      title: 'Implement feature',
      status: 'in_progress',
      rawStatus: 'In Progress',
      url: null,
      labels: [],
      assignee: null,
      priority: null,
      parentKey: null,
      createdAt: '2026-03-27T10:00:00.000Z',
      updatedAt: null,
      provider: 'jira',
    };
    expect(isGenericIssue(issue)).toBe(true);
  });

  it('should return false when key is missing', () => {
    const { key: _, ...noKey } = validIssue;
    expect(isGenericIssue(noKey)).toBe(false);
  });

  it('should return false when title is missing', () => {
    const { title: _, ...noTitle } = validIssue;
    expect(isGenericIssue(noTitle)).toBe(false);
  });

  it('should return false when status is invalid', () => {
    expect(isGenericIssue({ ...validIssue, status: 'active' })).toBe(false);
  });

  it('should return false when rawStatus is missing', () => {
    const { rawStatus: _, ...noRawStatus } = validIssue;
    expect(isGenericIssue(noRawStatus)).toBe(false);
  });

  it('should return false when labels is not an array', () => {
    expect(isGenericIssue({ ...validIssue, labels: 'bug' })).toBe(false);
  });

  it('should return false when createdAt is missing', () => {
    const { createdAt: _, ...noCreatedAt } = validIssue;
    expect(isGenericIssue(noCreatedAt)).toBe(false);
  });

  it('should return false when provider is missing', () => {
    const { provider: _, ...noProvider } = validIssue;
    expect(isGenericIssue(noProvider)).toBe(false);
  });

  it('should return false for null', () => {
    expect(isGenericIssue(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isGenericIssue(undefined)).toBe(false);
  });

  it('should return false for non-objects', () => {
    expect(isGenericIssue('string')).toBe(false);
    expect(isGenericIssue(42)).toBe(false);
    expect(isGenericIssue(true)).toBe(false);
  });

  it('should return false for url that is neither string nor null', () => {
    expect(isGenericIssue({ ...validIssue, url: 42 })).toBe(false);
  });
});
