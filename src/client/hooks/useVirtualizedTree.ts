import { useMemo } from 'react';
import type { IssueNode } from '../components/TreeNode';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FlatTreeRow {
  /** The issue node for this row */
  node: IssueNode;
  /** Tree depth (0 = root level) */
  depth: number;
  /** Unique key for React rendering — the issue number as a string */
  key: string;
}

// ---------------------------------------------------------------------------
// Pure flattening function (testable without hooks)
// ---------------------------------------------------------------------------

/**
 * Flatten a tree of IssueNode into a flat list suitable for virtualization.
 * Only includes children that are currently expanded (not in collapsedNodes).
 * When forceExpand is true, all nodes are expanded regardless of collapsedNodes.
 */
export function flattenTree(
  nodes: IssueNode[],
  collapsedNodes: Set<string>,
  forceExpand: boolean,
  depth: number = 0,
): FlatTreeRow[] {
  const rows: FlatTreeRow[] = [];
  for (const node of nodes) {
    const key = node.number.toString();
    rows.push({ node, depth, key });

    if (node.children.length > 0) {
      const isExpanded = forceExpand || !collapsedNodes.has(key);
      if (isExpanded) {
        const childRows = flattenTree(node.children, collapsedNodes, forceExpand, depth + 1);
        for (const row of childRows) {
          rows.push(row);
        }
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// React hook wrapper
// ---------------------------------------------------------------------------

/**
 * Memoized hook wrapping flattenTree. Re-computes only when inputs change.
 */
export function useFlattenedTree(
  nodes: IssueNode[],
  collapsedNodes: Set<string>,
  forceExpand: boolean,
): FlatTreeRow[] {
  return useMemo(
    () => flattenTree(nodes, collapsedNodes, forceExpand),
    [nodes, collapsedNodes, forceExpand],
  );
}
