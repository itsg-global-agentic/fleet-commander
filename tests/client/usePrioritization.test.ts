// =============================================================================
// Fleet Commander — usePrioritization Hook Tests
// =============================================================================
// Tests for the usePrioritization hook and its exported pure functions:
// collectOpenLeafIssues and sortTreeByPriority.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { IssueNode } from '../../src/client/components/TreeNode';
import type { PrioritizedIssue } from '../../shared/types';

// ---------------------------------------------------------------------------
// Mock useApi — must be declared before importing usePrioritization
// ---------------------------------------------------------------------------

const mockPost = vi.fn();

vi.mock('../../src/client/hooks/useApi', () => ({
  useApi: () => ({
    get: vi.fn(),
    post: mockPost,
    put: vi.fn(),
    del: vi.fn(),
  }),
  ApiError: class extends Error {
    status: number;
    statusText: string;
    constructor(status: number, statusText: string, message?: string) {
      super(message ?? `API error: ${status} ${statusText}`);
      this.name = 'ApiError';
      this.status = status;
      this.statusText = statusText;
    }
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

const {
  usePrioritization,
  collectOpenLeafIssues,
  sortTreeByPriority,
} = await import('../../src/client/hooks/usePrioritization');

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<IssueNode> & { number: number; title: string }): IssueNode {
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

describe('collectOpenLeafIssues', () => {
  it('should collect only open leaf issues', () => {
    const leaves = collectOpenLeafIssues(sampleTree);
    const numbers = leaves.map((l) => l.number);

    expect(numbers).toContain(2);
    expect(numbers).toContain(4);
    expect(numbers).toHaveLength(2);
  });

  it('should ignore closed leaves', () => {
    const leaves = collectOpenLeafIssues(sampleTree);
    const numbers = leaves.map((l) => l.number);

    expect(numbers).not.toContain(3);
    expect(numbers).not.toContain(5);
  });

  it('should ignore parents with children', () => {
    const leaves = collectOpenLeafIssues(sampleTree);
    const numbers = leaves.map((l) => l.number);

    // Issue 1 is an open parent with children — should NOT be collected
    expect(numbers).not.toContain(1);
  });

  it('should return empty array for empty tree', () => {
    const leaves = collectOpenLeafIssues([]);
    expect(leaves).toEqual([]);
  });

  it('should collect deeply nested open leaves', () => {
    const deepTree: IssueNode[] = [
      makeNode({
        number: 10,
        title: 'L1',
        children: [
          makeNode({
            number: 20,
            title: 'L2',
            children: [
              makeNode({ number: 30, title: 'Deep leaf' }),
            ],
          }),
        ],
      }),
    ];

    const leaves = collectOpenLeafIssues(deepTree);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]!.number).toBe(30);
  });
});

describe('sortTreeByPriority', () => {
  it('should sort by priority ascending', () => {
    const nodes: IssueNode[] = [
      makeNode({ number: 1, title: 'Low priority' }),
      makeNode({ number: 2, title: 'High priority' }),
      makeNode({ number: 3, title: 'Medium priority' }),
    ];

    const priorityMap = new Map<number, PrioritizedIssue>([
      [1, { number: 1, title: 'Low priority', priority: 8, category: 'cleanup', reason: '' }],
      [2, { number: 2, title: 'High priority', priority: 1, category: 'critical-bug', reason: '' }],
      [3, { number: 3, title: 'Medium priority', priority: 5, category: 'feature', reason: '' }],
    ]);

    const sorted = sortTreeByPriority(nodes, priorityMap);

    expect(sorted[0]!.number).toBe(2); // priority 1
    expect(sorted[1]!.number).toBe(3); // priority 5
    expect(sorted[2]!.number).toBe(1); // priority 8
  });

  it('should default missing priorities to 999', () => {
    const nodes: IssueNode[] = [
      makeNode({ number: 1, title: 'Has priority' }),
      makeNode({ number: 2, title: 'No priority' }),
    ];

    const priorityMap = new Map<number, PrioritizedIssue>([
      [1, { number: 1, title: 'Has priority', priority: 3, category: 'bug', reason: '' }],
    ]);

    const sorted = sortTreeByPriority(nodes, priorityMap);

    expect(sorted[0]!.number).toBe(1); // priority 3
    expect(sorted[1]!.number).toBe(2); // priority 999 (default)
  });

  it('should sort children recursively', () => {
    const nodes: IssueNode[] = [
      makeNode({
        number: 10,
        title: 'Parent',
        children: [
          makeNode({ number: 20, title: 'Child B' }),
          makeNode({ number: 30, title: 'Child A' }),
        ],
      }),
    ];

    const priorityMap = new Map<number, PrioritizedIssue>([
      [20, { number: 20, title: 'Child B', priority: 5, category: 'feature', reason: '' }],
      [30, { number: 30, title: 'Child A', priority: 2, category: 'bug', reason: '' }],
    ]);

    const sorted = sortTreeByPriority(nodes, priorityMap);
    expect(sorted[0]!.children[0]!.number).toBe(30); // priority 2
    expect(sorted[0]!.children[1]!.number).toBe(20); // priority 5
  });

  it('should not mutate the original array', () => {
    const nodes: IssueNode[] = [
      makeNode({ number: 1, title: 'A' }),
      makeNode({ number: 2, title: 'B' }),
    ];
    const original = [...nodes];

    sortTreeByPriority(nodes, new Map());

    expect(nodes[0]!.number).toBe(original[0]!.number);
    expect(nodes[1]!.number).toBe(original[1]!.number);
  });
});

// ---------------------------------------------------------------------------
// Hook tests
// ---------------------------------------------------------------------------

describe('usePrioritization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should have initial state with empty priorityMap, loading=false, error=null', () => {
    const { result } = renderHook(() => usePrioritization());

    expect(result.current.priorityMap.size).toBe(0);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.hasPriority).toBe(false);
    expect(result.current.sortedIssueNumbers).toEqual([]);
    expect(result.current.checkedSortedIssueNumbers).toEqual([]);
  });

  it('should populate priorityMap after successful prioritize call', async () => {
    const apiResult = {
      success: true,
      data: [
        { number: 2, title: 'Child open leaf', priority: 1, category: 'bug', reason: 'test' },
        { number: 4, title: 'Top-level open leaf', priority: 3, category: 'feature', reason: 'test' },
      ],
      costUsd: 0.01,
      durationMs: 500,
    };
    mockPost.mockResolvedValueOnce(apiResult);

    const { result } = renderHook(() => usePrioritization());

    await act(async () => {
      await result.current.prioritize(sampleTree);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.priorityMap.size).toBe(2);
    expect(result.current.priorityMap.get(2)?.priority).toBe(1);
    expect(result.current.priorityMap.get(4)?.priority).toBe(3);
    expect(result.current.hasPriority).toBe(true);
    expect(result.current.costUsd).toBe(0.01);
    expect(result.current.durationMs).toBe(500);
  });

  it('should set loading state during prioritize call', async () => {
    let resolvePromise: (value: unknown) => void;
    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    mockPost.mockReturnValueOnce(promise);

    const { result } = renderHook(() => usePrioritization());

    // Start prioritize without awaiting
    let prioritizePromise: Promise<void>;
    act(() => {
      prioritizePromise = result.current.prioritize(sampleTree);
    });

    expect(result.current.loading).toBe(true);

    // Resolve the API call
    await act(async () => {
      resolvePromise!({
        success: true,
        data: [
          { number: 2, title: 'X', priority: 1, category: 'bug', reason: '' },
        ],
        costUsd: 0,
        durationMs: 0,
      });
      await prioritizePromise!;
    });

    expect(result.current.loading).toBe(false);
  });

  it('should handle API error in prioritize', async () => {
    mockPost.mockRejectedValueOnce(new Error('Network failure'));

    const { result } = renderHook(() => usePrioritization());

    await act(async () => {
      await result.current.prioritize(sampleTree);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe('Network failure');
  });

  it('should handle success=false in prioritize response', async () => {
    mockPost.mockResolvedValueOnce({
      success: false,
      error: 'CC timeout',
      text: 'partial output',
      costUsd: 0.01,
      durationMs: 30000,
    });

    const { result } = renderHook(() => usePrioritization());

    await act(async () => {
      await result.current.prioritize(sampleTree);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toContain('CC timeout');
    expect(result.current.error).toContain('partial output');
  });

  it('should merge results when prioritizeSubtree is called', async () => {
    // First call: prioritize main tree
    mockPost.mockResolvedValueOnce({
      success: true,
      data: [
        { number: 2, title: 'A', priority: 1, category: 'bug', reason: '' },
      ],
      costUsd: 0.01,
      durationMs: 100,
    });

    const { result } = renderHook(() => usePrioritization());

    await act(async () => {
      await result.current.prioritize(sampleTree);
    });

    expect(result.current.priorityMap.size).toBe(1);

    // Second call: prioritize subtree — should merge
    mockPost.mockResolvedValueOnce({
      success: true,
      data: [
        { number: 4, title: 'B', priority: 5, category: 'feature', reason: '' },
      ],
      costUsd: 0.02,
      durationMs: 200,
    });

    const subtree: IssueNode[] = [
      makeNode({ number: 4, title: 'Top-level open leaf' }),
    ];

    await act(async () => {
      await result.current.prioritizeSubtree(subtree);
    });

    expect(result.current.priorityMap.size).toBe(2);
    expect(result.current.priorityMap.get(2)?.priority).toBe(1);
    expect(result.current.priorityMap.get(4)?.priority).toBe(5);
  });

  it('should reset all state', async () => {
    mockPost.mockResolvedValueOnce({
      success: true,
      data: [
        { number: 2, title: 'A', priority: 1, category: 'bug', reason: '' },
      ],
      costUsd: 0.01,
      durationMs: 100,
    });

    const { result } = renderHook(() => usePrioritization());

    await act(async () => {
      await result.current.prioritize(sampleTree);
    });

    expect(result.current.priorityMap.size).toBe(1);

    act(() => {
      result.current.reset();
    });

    expect(result.current.priorityMap.size).toBe(0);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.costUsd).toBeNull();
    expect(result.current.durationMs).toBeNull();
    expect(result.current.checkedIssues.size).toBe(0);
  });

  it('should toggle checked issues', () => {
    const { result } = renderHook(() => usePrioritization());

    act(() => {
      result.current.toggleCheck(42, true);
    });
    expect(result.current.checkedIssues.has(42)).toBe(true);

    act(() => {
      result.current.toggleCheck(42, false);
    });
    expect(result.current.checkedIssues.has(42)).toBe(false);
  });

  it('should return sorted issue numbers by priority', async () => {
    mockPost.mockResolvedValueOnce({
      success: true,
      data: [
        { number: 10, title: 'Low', priority: 8, category: 'cleanup', reason: '' },
        { number: 20, title: 'High', priority: 1, category: 'critical-bug', reason: '' },
        { number: 30, title: 'Mid', priority: 4, category: 'feature', reason: '' },
      ],
      costUsd: 0,
      durationMs: 0,
    });

    const tree: IssueNode[] = [
      makeNode({ number: 10, title: 'Low' }),
      makeNode({ number: 20, title: 'High' }),
      makeNode({ number: 30, title: 'Mid' }),
    ];

    const { result } = renderHook(() => usePrioritization());

    await act(async () => {
      await result.current.prioritize(tree);
    });

    expect(result.current.sortedIssueNumbers).toEqual([20, 30, 10]);
  });

  it('should return checked sorted issue numbers filtered by checked', async () => {
    mockPost.mockResolvedValueOnce({
      success: true,
      data: [
        { number: 10, title: 'A', priority: 3, category: 'bug', reason: '' },
        { number: 20, title: 'B', priority: 1, category: 'bug', reason: '' },
        { number: 30, title: 'C', priority: 2, category: 'bug', reason: '' },
      ],
      costUsd: 0,
      durationMs: 0,
    });

    const tree: IssueNode[] = [
      makeNode({ number: 10, title: 'A' }),
      makeNode({ number: 20, title: 'B' }),
      makeNode({ number: 30, title: 'C' }),
    ];

    const { result } = renderHook(() => usePrioritization());

    await act(async () => {
      await result.current.prioritize(tree);
    });

    // After prioritize, all items are auto-checked
    expect(result.current.checkedSortedIssueNumbers).toEqual([20, 30, 10]);

    // Uncheck issue 30
    act(() => {
      result.current.toggleCheck(30, false);
    });

    expect(result.current.checkedSortedIssueNumbers).toEqual([20, 10]);
  });

  it('should handle prioritizeSubtree error', async () => {
    mockPost.mockRejectedValueOnce(new Error('Subtree API failure'));

    const subtree: IssueNode[] = [
      makeNode({ number: 4, title: 'Leaf' }),
    ];

    const { result } = renderHook(() => usePrioritization());

    await act(async () => {
      await result.current.prioritizeSubtree(subtree);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe('Subtree API failure');
  });

  it('should handle prioritizeSubtree success=false', async () => {
    mockPost.mockResolvedValueOnce({
      success: false,
      error: 'Model overloaded',
      costUsd: 0,
      durationMs: 0,
    });

    const subtree: IssueNode[] = [
      makeNode({ number: 4, title: 'Leaf' }),
    ];

    const { result } = renderHook(() => usePrioritization());

    await act(async () => {
      await result.current.prioritizeSubtree(subtree);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toContain('Model overloaded');
  });

  it('should skip prioritize when tree has no open issues', async () => {
    const closedTree: IssueNode[] = [
      makeNode({ number: 1, title: 'Closed', state: 'closed' }),
    ];

    const { result } = renderHook(() => usePrioritization());

    await act(async () => {
      await result.current.prioritize(closedTree);
    });

    // Should not have called the API
    expect(mockPost).not.toHaveBeenCalled();
    expect(result.current.priorityMap.size).toBe(0);
  });
});
