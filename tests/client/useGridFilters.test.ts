// =============================================================================
// Fleet Commander — useGridFilters Hook & applyGridFilters Tests
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGridFilters, applyGridFilters } from '../../src/client/hooks/useGridFilters';
import type { TeamDashboardRow, TeamStatus } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// localStorage mock
// ---------------------------------------------------------------------------

const storageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
    get length() { return Object.keys(store).length; },
    key: vi.fn((_index: number) => null),
  };
})();

Object.defineProperty(globalThis, 'localStorage', { value: storageMock });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTeam(overrides: Partial<TeamDashboardRow> = {}): TeamDashboardRow {
  return {
    id: 1,
    issueNumber: 100,
    issueTitle: 'Fix bug',
    issueKey: null,
    issueProvider: null,
    projectId: 1,
    projectName: 'project-a',
    model: null,
    status: 'running',
    phase: 'implementing',
    worktreeName: 'project-a-100',
    branchName: null,
    prNumber: null,
    launchedAt: '2026-03-21T10:00:00Z',
    lastEventAt: null,
    durationMin: 10,
    idleMin: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalCostUsd: 0,
    retryCount: 0,
    blockedByJson: null,
    githubRepo: null,
    maxActiveTeams: null,
    prState: null,
    ciStatus: null,
    mergeStatus: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// applyGridFilters — Pure function tests
// ---------------------------------------------------------------------------

describe('applyGridFilters', () => {
  const teams: TeamDashboardRow[] = [
    makeTeam({ id: 1, projectName: 'alpha', status: 'running' }),
    makeTeam({ id: 2, projectName: 'beta', status: 'done' }),
    makeTeam({ id: 3, projectName: 'alpha', status: 'stuck' }),
    makeTeam({ id: 4, projectName: 'beta', status: 'running' }),
    makeTeam({ id: 5, projectName: null, status: 'idle' }),
  ];

  it('returns all teams when no filters are applied', () => {
    const result = applyGridFilters(teams, null, new Set());
    expect(result).toHaveLength(5);
  });

  it('filters by project name', () => {
    const result = applyGridFilters(teams, 'alpha', new Set());
    expect(result).toHaveLength(2);
    expect(result.every((t) => t.projectName === 'alpha')).toBe(true);
  });

  it('filters by status', () => {
    const result = applyGridFilters(teams, null, new Set<TeamStatus>(['running']));
    expect(result).toHaveLength(2);
    expect(result.every((t) => t.status === 'running')).toBe(true);
  });

  it('filters by multiple statuses', () => {
    const result = applyGridFilters(teams, null, new Set<TeamStatus>(['running', 'done']));
    expect(result).toHaveLength(3);
    expect(result.every((t) => t.status === 'running' || t.status === 'done')).toBe(true);
  });

  it('combines project and status filters (intersection)', () => {
    const result = applyGridFilters(teams, 'beta', new Set<TeamStatus>(['running']));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(4);
  });

  it('returns empty array for unknown project', () => {
    const result = applyGridFilters(teams, 'nonexistent', new Set());
    expect(result).toHaveLength(0);
  });

  it('excludes teams with null projectName when project filter is set', () => {
    const result = applyGridFilters(teams, 'alpha', new Set());
    expect(result.some((t) => t.projectName === null)).toBe(false);
  });

  it('includes teams with null projectName when project filter is null (All)', () => {
    const result = applyGridFilters(teams, null, new Set());
    expect(result.some((t) => t.projectName === null)).toBe(true);
  });

  it('returns empty array when status filter matches no teams', () => {
    const result = applyGridFilters(teams, null, new Set<TeamStatus>(['failed']));
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// useGridFilters — Hook tests
// ---------------------------------------------------------------------------

describe('useGridFilters', () => {
  beforeEach(() => {
    storageMock.clear();
    vi.clearAllMocks();
  });

  it('starts with no filters when localStorage is empty', () => {
    const { result } = renderHook(() => useGridFilters());
    expect(result.current.selectedProject).toBeNull();
    expect(result.current.selectedStatuses.size).toBe(0);
  });

  it('rehydrates project filter from localStorage', () => {
    storageMock.setItem('fleet-grid-filters', JSON.stringify({ project: 'my-project', statuses: [] }));
    const { result } = renderHook(() => useGridFilters());
    expect(result.current.selectedProject).toBe('my-project');
    expect(result.current.selectedStatuses.size).toBe(0);
  });

  it('rehydrates status filters from localStorage', () => {
    storageMock.setItem('fleet-grid-filters', JSON.stringify({ project: null, statuses: ['running', 'idle'] }));
    const { result } = renderHook(() => useGridFilters());
    expect(result.current.selectedProject).toBeNull();
    expect(result.current.selectedStatuses.size).toBe(2);
    expect(result.current.selectedStatuses.has('running')).toBe(true);
    expect(result.current.selectedStatuses.has('idle')).toBe(true);
  });

  it('rehydrates both project and status filters from localStorage', () => {
    storageMock.setItem('fleet-grid-filters', JSON.stringify({ project: 'alpha', statuses: ['stuck'] }));
    const { result } = renderHook(() => useGridFilters());
    expect(result.current.selectedProject).toBe('alpha');
    expect(result.current.selectedStatuses.has('stuck')).toBe(true);
  });

  it('handles corrupt localStorage data gracefully', () => {
    storageMock.setItem('fleet-grid-filters', 'not-valid-json');
    const { result } = renderHook(() => useGridFilters());
    expect(result.current.selectedProject).toBeNull();
    expect(result.current.selectedStatuses.size).toBe(0);
  });

  it('handles non-object localStorage data gracefully', () => {
    storageMock.setItem('fleet-grid-filters', JSON.stringify('just a string'));
    const { result } = renderHook(() => useGridFilters());
    expect(result.current.selectedProject).toBeNull();
    expect(result.current.selectedStatuses.size).toBe(0);
  });

  it('persists project filter to localStorage on setProject', () => {
    const { result } = renderHook(() => useGridFilters());
    act(() => {
      result.current.setProject('beta');
    });
    const stored = JSON.parse(storageMock.getItem('fleet-grid-filters')!);
    expect(stored.project).toBe('beta');
  });

  it('persists status filters to localStorage on setStatuses', () => {
    const { result } = renderHook(() => useGridFilters());
    act(() => {
      result.current.setStatuses(new Set<TeamStatus>(['running', 'done']));
    });
    const stored = JSON.parse(storageMock.getItem('fleet-grid-filters')!);
    expect(stored.statuses).toEqual(expect.arrayContaining(['running', 'done']));
    expect(stored.statuses).toHaveLength(2);
  });

  it('setProject(null) clears the project filter', () => {
    storageMock.setItem('fleet-grid-filters', JSON.stringify({ project: 'alpha', statuses: [] }));
    const { result } = renderHook(() => useGridFilters());
    expect(result.current.selectedProject).toBe('alpha');
    act(() => {
      result.current.setProject(null);
    });
    expect(result.current.selectedProject).toBeNull();
  });

  it('setStatuses(new Set()) clears status filters', () => {
    storageMock.setItem('fleet-grid-filters', JSON.stringify({ project: null, statuses: ['running'] }));
    const { result } = renderHook(() => useGridFilters());
    expect(result.current.selectedStatuses.size).toBe(1);
    act(() => {
      result.current.setStatuses(new Set());
    });
    expect(result.current.selectedStatuses.size).toBe(0);
  });
});
