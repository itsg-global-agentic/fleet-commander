// =============================================================================
// Fleet Commander — useIssueSelection Hook Tests
// =============================================================================

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { IssueNode } from '../../src/client/components/TreeNode';
import {
  useIssueSelection,
  collectAllOpenIssueNumbers,
} from '../../src/client/hooks/useIssueSelection';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeNode(
  overrides: Partial<IssueNode> & { number: number; title: string },
): IssueNode {
  return {
    state: 'open',
    labels: [],
    url: `https://github.com/test/repo/issues/${overrides.number}`,
    children: [],
    ...overrides,
  };
}

const sampleTree: IssueNode[] = [
  makeNode({
    number: 1,
    title: 'Parent open',
    children: [
      makeNode({ number: 2, title: 'Child open leaf' }),
      makeNode({ number: 3, title: 'Child closed leaf', state: 'closed' }),
    ],
  }),
  makeNode({ number: 4, title: 'Top-level open leaf' }),
  makeNode({ number: 5, title: 'Top-level closed', state: 'closed' }),
];

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('collectAllOpenIssueNumbers', () => {
  it('should collect only open issue numbers from the tree', () => {
    const result = collectAllOpenIssueNumbers(sampleTree);
    expect(result).toEqual([1, 2, 4]);
  });

  it('should return empty array for empty tree', () => {
    expect(collectAllOpenIssueNumbers([])).toEqual([]);
  });

  it('should skip all closed issues', () => {
    const closedTree: IssueNode[] = [
      makeNode({ number: 10, title: 'Closed', state: 'closed' }),
      makeNode({ number: 11, title: 'Also closed', state: 'closed' }),
    ];
    expect(collectAllOpenIssueNumbers(closedTree)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Hook tests
// ---------------------------------------------------------------------------

describe('useIssueSelection', () => {
  it('should start with empty selection', () => {
    const { result } = renderHook(() => useIssueSelection());
    expect(result.current.selectedIssues.size).toBe(0);
    expect(result.current.selectedCount).toBe(0);
  });

  it('toggleCheck should add and remove a single issue', () => {
    const { result } = renderHook(() => useIssueSelection());

    act(() => {
      result.current.toggleCheck(42, true);
    });
    expect(result.current.selectedIssues.has(42)).toBe(true);
    expect(result.current.selectedCount).toBe(1);

    act(() => {
      result.current.toggleCheck(42, false);
    });
    expect(result.current.selectedIssues.has(42)).toBe(false);
    expect(result.current.selectedCount).toBe(0);
  });

  it('toggleWithChildren should select a parent and all open descendants', () => {
    const { result } = renderHook(() => useIssueSelection());

    const parentNode = sampleTree[0]; // has children: #2 (open), #3 (closed)

    act(() => {
      result.current.toggleWithChildren(parentNode, true);
    });
    // Should include #1 (parent, open) and #2 (child, open)
    // Should NOT include #3 (child, closed)
    expect(result.current.selectedIssues.has(1)).toBe(true);
    expect(result.current.selectedIssues.has(2)).toBe(true);
    expect(result.current.selectedIssues.has(3)).toBe(false);
    expect(result.current.selectedCount).toBe(2);
  });

  it('toggleWithChildren should deselect a parent and all open descendants', () => {
    const { result } = renderHook(() => useIssueSelection());

    const parentNode = sampleTree[0];

    // First select, then deselect
    act(() => {
      result.current.toggleWithChildren(parentNode, true);
    });
    act(() => {
      result.current.toggleWithChildren(parentNode, false);
    });
    expect(result.current.selectedIssues.has(1)).toBe(false);
    expect(result.current.selectedIssues.has(2)).toBe(false);
    expect(result.current.selectedCount).toBe(0);
  });

  it('selectAll should select all open issues in the tree', () => {
    const { result } = renderHook(() => useIssueSelection());

    act(() => {
      result.current.selectAll(sampleTree);
    });
    // Open issues: #1, #2, #4
    expect(result.current.selectedIssues.has(1)).toBe(true);
    expect(result.current.selectedIssues.has(2)).toBe(true);
    expect(result.current.selectedIssues.has(4)).toBe(true);
    // Closed issues should not be selected
    expect(result.current.selectedIssues.has(3)).toBe(false);
    expect(result.current.selectedIssues.has(5)).toBe(false);
    expect(result.current.selectedCount).toBe(3);
  });

  it('deselectAll should clear all selections', () => {
    const { result } = renderHook(() => useIssueSelection());

    act(() => {
      result.current.selectAll(sampleTree);
    });
    expect(result.current.selectedCount).toBe(3);

    act(() => {
      result.current.deselectAll();
    });
    expect(result.current.selectedCount).toBe(0);
    expect(result.current.selectedIssues.size).toBe(0);
  });

  it('isAllSelected should return true when all open issues are selected', () => {
    const { result } = renderHook(() => useIssueSelection());

    act(() => {
      result.current.selectAll(sampleTree);
    });
    expect(result.current.isAllSelected(sampleTree)).toBe(true);
  });

  it('isAllSelected should return false when only some issues are selected', () => {
    const { result } = renderHook(() => useIssueSelection());

    act(() => {
      result.current.toggleCheck(1, true);
    });
    expect(result.current.isAllSelected(sampleTree)).toBe(false);
  });

  it('isAllSelected should return false for empty tree', () => {
    const { result } = renderHook(() => useIssueSelection());
    expect(result.current.isAllSelected([])).toBe(false);
  });

  it('toggleWithChildren preserves selections outside the toggled node', () => {
    const { result } = renderHook(() => useIssueSelection());

    // First select issue #4 individually
    act(() => {
      result.current.toggleCheck(4, true);
    });
    expect(result.current.selectedIssues.has(4)).toBe(true);

    // Now toggle parent node #1 with children
    act(() => {
      result.current.toggleWithChildren(sampleTree[0], true);
    });
    // #4 should still be selected
    expect(result.current.selectedIssues.has(4)).toBe(true);
    // #1 and #2 should now also be selected
    expect(result.current.selectedIssues.has(1)).toBe(true);
    expect(result.current.selectedIssues.has(2)).toBe(true);
    expect(result.current.selectedCount).toBe(3);
  });
});
