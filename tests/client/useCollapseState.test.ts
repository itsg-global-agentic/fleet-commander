// =============================================================================
// Fleet Commander — useCollapseState Hook Tests
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCollapseState } from '../../src/client/hooks/useCollapseState';

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
// Tests
// ---------------------------------------------------------------------------

describe('useCollapseState', () => {
  beforeEach(() => {
    storageMock.clear();
    vi.clearAllMocks();
  });

  it('starts with empty collapsed set when localStorage is empty', () => {
    const { result } = renderHook(() => useCollapseState());
    expect(result.current.collapsedNodes.size).toBe(0);
  });

  it('loads collapsed IDs from localStorage on mount', () => {
    storageMock.setItem('fleet-issue-tree-collapsed', JSON.stringify(['1', '5', '10']));
    const { result } = renderHook(() => useCollapseState());
    expect(result.current.collapsedNodes.size).toBe(3);
    expect(result.current.isCollapsed('1')).toBe(true);
    expect(result.current.isCollapsed('5')).toBe(true);
    expect(result.current.isCollapsed('10')).toBe(true);
    expect(result.current.isCollapsed('99')).toBe(false);
  });

  it('handles corrupt localStorage data gracefully', () => {
    storageMock.setItem('fleet-issue-tree-collapsed', 'not-valid-json');
    const { result } = renderHook(() => useCollapseState());
    expect(result.current.collapsedNodes.size).toBe(0);
  });

  it('handles non-array localStorage data gracefully', () => {
    storageMock.setItem('fleet-issue-tree-collapsed', JSON.stringify({ foo: 'bar' }));
    const { result } = renderHook(() => useCollapseState());
    expect(result.current.collapsedNodes.size).toBe(0);
  });

  it('toggleCollapse adds a node ID when not present', () => {
    const { result } = renderHook(() => useCollapseState());
    act(() => {
      result.current.toggleCollapse('42');
    });
    expect(result.current.isCollapsed('42')).toBe(true);
  });

  it('toggleCollapse removes a node ID when already present', () => {
    storageMock.setItem('fleet-issue-tree-collapsed', JSON.stringify(['42']));
    const { result } = renderHook(() => useCollapseState());
    expect(result.current.isCollapsed('42')).toBe(true);
    act(() => {
      result.current.toggleCollapse('42');
    });
    expect(result.current.isCollapsed('42')).toBe(false);
  });

  it('expandAll clears all collapsed nodes', () => {
    storageMock.setItem('fleet-issue-tree-collapsed', JSON.stringify(['1', '2', '3']));
    const { result } = renderHook(() => useCollapseState());
    expect(result.current.collapsedNodes.size).toBe(3);
    act(() => {
      result.current.expandAll();
    });
    expect(result.current.collapsedNodes.size).toBe(0);
  });

  it('collapseAll sets all provided IDs as collapsed', () => {
    const { result } = renderHook(() => useCollapseState());
    act(() => {
      result.current.collapseAll(['10', '20', '30']);
    });
    expect(result.current.collapsedNodes.size).toBe(3);
    expect(result.current.isCollapsed('10')).toBe(true);
    expect(result.current.isCollapsed('20')).toBe(true);
    expect(result.current.isCollapsed('30')).toBe(true);
  });

  it('persists state to localStorage after toggle', () => {
    const { result } = renderHook(() => useCollapseState());
    act(() => {
      result.current.toggleCollapse('7');
    });
    const stored = JSON.parse(storageMock.getItem('fleet-issue-tree-collapsed')!);
    expect(stored).toEqual(['7']);
  });

  it('persists state to localStorage after expandAll', () => {
    storageMock.setItem('fleet-issue-tree-collapsed', JSON.stringify(['1', '2']));
    const { result } = renderHook(() => useCollapseState());
    act(() => {
      result.current.expandAll();
    });
    const stored = JSON.parse(storageMock.getItem('fleet-issue-tree-collapsed')!);
    expect(stored).toEqual([]);
  });

  it('persists state to localStorage after collapseAll', () => {
    const { result } = renderHook(() => useCollapseState());
    act(() => {
      result.current.collapseAll(['5', '15']);
    });
    const stored = JSON.parse(storageMock.getItem('fleet-issue-tree-collapsed')!);
    expect(stored).toContain('5');
    expect(stored).toContain('15');
    expect(stored.length).toBe(2);
  });

  it('isCollapsed returns correct values', () => {
    const { result } = renderHook(() => useCollapseState());
    expect(result.current.isCollapsed('99')).toBe(false);
    act(() => {
      result.current.toggleCollapse('99');
    });
    expect(result.current.isCollapsed('99')).toBe(true);
  });
});
