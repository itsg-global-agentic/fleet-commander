// =============================================================================
// Fleet Commander — useVirtualizedTree / flattenTree Tests
// =============================================================================

import { describe, it, expect } from 'vitest';
import { flattenTree } from '../../src/client/hooks/useVirtualizedTree';
import type { IssueNode } from '../../src/client/components/TreeNode';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<IssueNode> = {}): IssueNode {
  return {
    number: 1,
    title: 'Test issue',
    state: 'open',
    labels: [],
    url: 'https://github.com/user/repo/issues/1',
    children: [],
    activeTeam: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('flattenTree', () => {
  it('should flatten a flat list (no children)', () => {
    const nodes = [
      makeNode({ number: 1, title: 'A' }),
      makeNode({ number: 2, title: 'B' }),
      makeNode({ number: 3, title: 'C' }),
    ];
    const rows = flattenTree(nodes, new Set(), false);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.node.number)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0, 0]);
    expect(rows.map((r) => r.key)).toEqual(['1', '2', '3']);
  });

  it('should flatten a nested list with expanded children', () => {
    const tree = [
      makeNode({
        number: 1,
        title: 'Parent',
        children: [
          makeNode({ number: 2, title: 'Child A' }),
          makeNode({ number: 3, title: 'Child B' }),
        ],
      }),
    ];
    const rows = flattenTree(tree, new Set(), false);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ key: '1', depth: 0 });
    expect(rows[1]).toMatchObject({ key: '2', depth: 1 });
    expect(rows[2]).toMatchObject({ key: '3', depth: 1 });
  });

  it('should exclude children of collapsed nodes', () => {
    const tree = [
      makeNode({
        number: 1,
        children: [
          makeNode({ number: 2, title: 'Hidden child' }),
        ],
      }),
    ];
    const collapsed = new Set(['1']);
    const rows = flattenTree(tree, collapsed, false);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe('1');
  });

  it('should force expand all nodes when forceExpand is true', () => {
    const tree = [
      makeNode({
        number: 1,
        children: [
          makeNode({
            number: 2,
            children: [
              makeNode({ number: 3, title: 'Grandchild' }),
            ],
          }),
        ],
      }),
    ];
    const collapsed = new Set(['1', '2']);
    const rows = flattenTree(tree, collapsed, true);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.key)).toEqual(['1', '2', '3']);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
  });

  it('should return empty array for empty tree', () => {
    const rows = flattenTree([], new Set(), false);
    expect(rows).toHaveLength(0);
  });

  it('should handle deeply nested tree with correct depths', () => {
    const tree = [
      makeNode({
        number: 1,
        children: [
          makeNode({
            number: 2,
            children: [
              makeNode({
                number: 3,
                children: [
                  makeNode({
                    number: 4,
                    children: [
                      makeNode({ number: 5 }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ];
    const rows = flattenTree(tree, new Set(), false);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 3, 4]);
  });

  it('should collapse only the specified node and its subtree', () => {
    const tree = [
      makeNode({
        number: 1,
        children: [
          makeNode({
            number: 2,
            children: [
              makeNode({ number: 3, title: 'Grandchild of 2' }),
            ],
          }),
          makeNode({ number: 4, title: 'Sibling of 2' }),
        ],
      }),
    ];
    // Collapse node 2 only — node 4 (sibling) should still be visible
    const collapsed = new Set(['2']);
    const rows = flattenTree(tree, collapsed, false);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.key)).toEqual(['1', '2', '4']);
  });

  it('should handle leaf nodes that are in collapsedNodes set (no-op)', () => {
    const tree = [
      makeNode({ number: 1 }),
      makeNode({ number: 2 }),
    ];
    // Marking a leaf as collapsed should not affect rendering
    const collapsed = new Set(['1']);
    const rows = flattenTree(tree, collapsed, false);
    expect(rows).toHaveLength(2);
  });

  it('should process multiple root-level parents independently', () => {
    const tree = [
      makeNode({
        number: 10,
        children: [makeNode({ number: 11 })],
      }),
      makeNode({
        number: 20,
        children: [makeNode({ number: 21 })],
      }),
    ];
    // Collapse only first parent
    const collapsed = new Set(['10']);
    const rows = flattenTree(tree, collapsed, false);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.key)).toEqual(['10', '20', '21']);
  });
});
