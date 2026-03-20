import { useState, useCallback } from 'react';
import { useApi } from './useApi';
import type { PrioritizedIssue, CCQueryResult } from '../../shared/types';
import type { IssueNode } from '../components/TreeNode';

interface PrioritizationState {
  /** Map of issue number -> priority data */
  priorityMap: Map<number, PrioritizedIssue>;
  /** Whether a prioritization request is in progress */
  loading: boolean;
  /** Error message from the last request */
  error: string | null;
  /** Cost in USD from the last successful request */
  costUsd: number | null;
  /** Duration in ms from the last successful request */
  durationMs: number | null;
  /** Set of checked issue numbers for batch launch */
  checkedIssues: Set<number>;
}

interface UsePrioritizationReturn extends PrioritizationState {
  /** Run AI prioritization on the given issue tree */
  prioritize: (tree: IssueNode[]) => Promise<void>;
  /** Run AI prioritization on a subtree and merge results into existing priorityMap */
  prioritizeSubtree: (subtreeNodes: IssueNode[]) => Promise<void>;
  /** Reset all prioritization state */
  reset: () => void;
  /** Toggle an issue's checked state */
  toggleCheck: (issueNumber: number, checked: boolean) => void;
  /** Whether prioritization data is available */
  hasPriority: boolean;
  /** Get sorted issue numbers by priority (ascending = highest priority first) */
  sortedIssueNumbers: number[];
  /** Get checked issue numbers sorted by priority */
  checkedSortedIssueNumbers: number[];
}

/** Collect all open issue numbers + titles from a tree (including parents) */
function collectOpenIssues(nodes: IssueNode[]): { number: number; title: string }[] {
  const result: { number: number; title: string }[] = [];
  for (const node of nodes) {
    if (node.state === 'open') {
      result.push({ number: node.number, title: node.title });
    }
    if (node.children.length > 0) {
      result.push(...collectOpenIssues(node.children));
    }
  }
  return result;
}

/** Collect only open leaf issues (no children) from a tree */
export function collectOpenLeafIssues(nodes: IssueNode[]): { number: number; title: string }[] {
  const result: { number: number; title: string }[] = [];
  for (const node of nodes) {
    if (node.children.length > 0) {
      result.push(...collectOpenLeafIssues(node.children));
    } else if (node.state === 'open') {
      result.push({ number: node.number, title: node.title });
    }
  }
  return result;
}

/** Sort issue tree by priority map (ascending priority = highest priority first) */
export function sortTreeByPriority(
  nodes: IssueNode[],
  priorityMap: Map<number, PrioritizedIssue>,
): IssueNode[] {
  return [...nodes]
    .map((node) => ({
      ...node,
      children: sortTreeByPriority(node.children, priorityMap),
    }))
    .sort((a, b) => {
      const pa = priorityMap.get(a.number)?.priority ?? 999;
      const pb = priorityMap.get(b.number)?.priority ?? 999;
      return pa - pb;
    });
}

export function usePrioritization(): UsePrioritizationReturn {
  const api = useApi();
  const [state, setState] = useState<PrioritizationState>({
    priorityMap: new Map(),
    loading: false,
    error: null,
    costUsd: null,
    durationMs: null,
    checkedIssues: new Set(),
  });

  const prioritize = useCallback(async (tree: IssueNode[]) => {
    const issues = collectOpenIssues(tree);
    if (issues.length === 0) return;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const result = await api.post<CCQueryResult<PrioritizedIssue[]>>(
        'query/prioritizeIssues',
        { issues },
      );

      if (!result.success || !result.data) {
        const errorMsg = result.error ?? 'Prioritization returned no data';
        const detail = result.text ? `\n\nCC output: ${result.text}` : '';
        setState((prev) => ({
          ...prev,
          loading: false,
          error: errorMsg + detail,
        }));
        return;
      }

      const map = new Map<number, PrioritizedIssue>();
      for (const item of result.data) {
        map.set(item.number, item);
      }

      // Auto-check all prioritized open issues
      const checked = new Set(result.data.map((i) => i.number));

      setState({
        priorityMap: map,
        loading: false,
        error: null,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        checkedIssues: checked,
      });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [api]);

  const prioritizeSubtree = useCallback(async (subtreeNodes: IssueNode[]) => {
    const issues = collectOpenLeafIssues(subtreeNodes);
    if (issues.length === 0) return;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const result = await api.post<CCQueryResult<PrioritizedIssue[]>>(
        'query/prioritizeIssues',
        { issues },
      );

      if (!result.success || !result.data) {
        const errorMsg = result.error ?? 'Prioritization returned no data';
        const detail = result.text ? `\n\nCC output: ${result.text}` : '';
        setState((prev) => ({
          ...prev,
          loading: false,
          error: errorMsg + detail,
        }));
        return;
      }

      // Merge new results into existing priorityMap
      setState((prev) => {
        const mergedMap = new Map(prev.priorityMap);
        const mergedChecked = new Set(prev.checkedIssues);
        for (const item of result.data!) {
          mergedMap.set(item.number, item);
          mergedChecked.add(item.number);
        }
        return {
          priorityMap: mergedMap,
          loading: false,
          error: null,
          costUsd: result.costUsd,
          durationMs: result.durationMs,
          checkedIssues: mergedChecked,
        };
      });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [api]);

  const reset = useCallback(() => {
    setState({
      priorityMap: new Map(),
      loading: false,
      error: null,
      costUsd: null,
      durationMs: null,
      checkedIssues: new Set(),
    });
  }, []);

  const toggleCheck = useCallback((issueNumber: number, checked: boolean) => {
    setState((prev) => {
      const next = new Set(prev.checkedIssues);
      if (checked) {
        next.add(issueNumber);
      } else {
        next.delete(issueNumber);
      }
      return { ...prev, checkedIssues: next };
    });
  }, []);

  const hasPriority = state.priorityMap.size > 0;

  const sortedIssueNumbers = hasPriority
    ? [...state.priorityMap.entries()]
        .sort((a, b) => a[1].priority - b[1].priority)
        .map(([num]) => num)
    : [];

  const checkedSortedIssueNumbers = sortedIssueNumbers.filter((n) =>
    state.checkedIssues.has(n),
  );

  return {
    ...state,
    prioritize,
    prioritizeSubtree,
    reset,
    toggleCheck,
    hasPriority,
    sortedIssueNumbers,
    checkedSortedIssueNumbers,
  };
}
