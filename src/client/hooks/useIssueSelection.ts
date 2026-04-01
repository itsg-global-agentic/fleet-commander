// =============================================================================
// Fleet Commander — useIssueSelection Hook
// =============================================================================
// Manages checkbox selection state for issue tree nodes, independent of
// AI prioritization. Supports single toggle, parent-with-children cascading,
// select all, and deselect all.
// =============================================================================

import { useState, useCallback } from 'react';
import type { IssueNode } from '../components/TreeNode';

// ---------------------------------------------------------------------------
// Helper: collect all open issue numbers from a tree
// ---------------------------------------------------------------------------

export function collectAllOpenIssueNumbers(nodes: IssueNode[]): number[] {
  const result: number[] = [];
  for (const node of nodes) {
    if (node.state === 'open') {
      result.push(node.number);
    }
    if (node.children.length > 0) {
      result.push(...collectAllOpenIssueNumbers(node.children));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Hook return type
// ---------------------------------------------------------------------------

export interface UseIssueSelectionReturn {
  /** Currently checked issue numbers */
  selectedIssues: Set<number>;
  /** Toggle a single issue's checked state */
  toggleCheck: (issueNumber: number, checked: boolean) => void;
  /** Toggle a node plus all its descendant open issues */
  toggleWithChildren: (node: IssueNode, checked: boolean) => void;
  /** Select all open issues in the given tree */
  selectAll: (tree: IssueNode[]) => void;
  /** Clear all selections */
  deselectAll: () => void;
  /** Number of currently selected issues */
  selectedCount: number;
  /** Returns true when all open issues in the tree are selected */
  isAllSelected: (tree: IssueNode[]) => boolean;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useIssueSelection(): UseIssueSelectionReturn {
  const [selectedIssues, setSelectedIssues] = useState<Set<number>>(new Set());

  const toggleCheck = useCallback((issueNumber: number, checked: boolean) => {
    setSelectedIssues((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(issueNumber);
      } else {
        next.delete(issueNumber);
      }
      return next;
    });
  }, []);

  const toggleWithChildren = useCallback((node: IssueNode, checked: boolean) => {
    const allNumbers = collectAllOpenIssueNumbers([node]);
    setSelectedIssues((prev) => {
      const next = new Set(prev);
      for (const num of allNumbers) {
        if (checked) {
          next.add(num);
        } else {
          next.delete(num);
        }
      }
      return next;
    });
  }, []);

  const selectAll = useCallback((tree: IssueNode[]) => {
    const allNumbers = collectAllOpenIssueNumbers(tree);
    setSelectedIssues(new Set(allNumbers));
  }, []);

  const deselectAll = useCallback(() => {
    setSelectedIssues(new Set());
  }, []);

  const isAllSelected = useCallback(
    (tree: IssueNode[]): boolean => {
      const allNumbers = collectAllOpenIssueNumbers(tree);
      if (allNumbers.length === 0) return false;
      return allNumbers.every((num) => selectedIssues.has(num));
    },
    [selectedIssues],
  );

  return {
    selectedIssues,
    toggleCheck,
    toggleWithChildren,
    selectAll,
    deselectAll,
    selectedCount: selectedIssues.size,
    isAllSelected,
  };
}
