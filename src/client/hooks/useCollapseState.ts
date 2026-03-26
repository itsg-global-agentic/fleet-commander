import { useState, useCallback, useEffect, useRef } from 'react';

const STORAGE_KEY = 'fleet-issue-tree-collapsed';

interface UseCollapseStateReturn {
  /** Set of node IDs that are currently collapsed */
  collapsedNodes: Set<string>;
  /** Toggle a single node's collapsed state */
  toggleCollapse: (nodeId: string) => void;
  /** Expand all nodes (clear the collapsed set) */
  expandAll: () => void;
  /** Collapse all nodes (set all IDs as collapsed) */
  collapseAll: (allNodeIds: string[]) => void;
  /** Check if a specific node is collapsed */
  isCollapsed: (nodeId: string) => boolean;
  /**
   * Seed default collapsed nodes on first load (when localStorage is empty).
   * Call this after the tree data is available. Only applies if no prior
   * collapse state was persisted.
   */
  seedDefaults: (nodeIds: string[]) => void;
}

/** Check if localStorage has a persisted collapse state */
function hasStoredState(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/** Read collapsed node IDs from localStorage */
function readFromStorage(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((v): v is string => typeof v === 'string'));
    }
  } catch {
    // Ignore corrupt data
  }
  return new Set();
}

/** Write collapsed node IDs to localStorage */
function writeToStorage(set: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // Ignore quota errors
  }
}

/**
 * Custom hook to manage collapse state for the issue tree.
 * Persists collapsed node IDs to localStorage so state survives navigation.
 */
export function useCollapseState(): UseCollapseStateReturn {
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(() => readFromStorage());

  // Use a ref to track whether the initial load from storage has happened,
  // so we don't write back to storage on mount.
  const initialized = useRef(false);

  // Track whether default seeding has already been attempted to avoid repeated calls
  const seeded = useRef(false);

  // Track whether localStorage had prior state (used by seedDefaults)
  const hadStoredState = useRef(hasStoredState());

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      return;
    }
    writeToStorage(collapsedNodes);
  }, [collapsedNodes]);

  const toggleCollapse = useCallback((nodeId: string) => {
    setCollapsedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    setCollapsedNodes(new Set());
  }, []);

  const collapseAll = useCallback((allNodeIds: string[]) => {
    setCollapsedNodes(new Set(allNodeIds));
  }, []);

  const isCollapsed = useCallback(
    (nodeId: string) => collapsedNodes.has(nodeId),
    [collapsedNodes],
  );

  const seedDefaults = useCallback((nodeIds: string[]) => {
    // Only seed on first load when localStorage was empty
    if (seeded.current || hadStoredState.current) return;
    seeded.current = true;
    if (nodeIds.length > 0) {
      setCollapsedNodes(new Set(nodeIds));
    }
  }, []);

  return {
    collapsedNodes,
    toggleCollapse,
    expandAll,
    collapseAll,
    isCollapsed,
    seedDefaults,
  };
}
