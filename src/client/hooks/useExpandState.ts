import { useState, useCallback, useEffect, useRef } from 'react';

const STORAGE_KEY = 'fleet-projects-expanded';

interface UseExpandStateReturn {
  /** Set of item IDs that are currently expanded */
  expandedIds: Set<string>;
  /** Toggle a single item's expanded state */
  toggle: (id: string) => void;
  /** Check if a specific item is expanded */
  isExpanded: (id: string) => boolean;
  /** Whether localStorage had prior state on mount */
  hasStoredData: boolean;
  /**
   * Seed default expanded items on first load (when localStorage is empty).
   * Call this after the data is available. Only applies once and only if no
   * prior expand state was persisted.
   */
  seedExpanded: (ids: string[]) => void;
}

/** Check if localStorage has a persisted expand state */
function hasStoredState(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/** Read expanded item IDs from localStorage */
function readFromStorage(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((v): v is string => typeof v === 'string'));
    }
  } catch {
    // Ignore corrupt data
  }
  return new Set();
}

/** Write expanded item IDs to localStorage */
function writeToStorage(set: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // Ignore quota errors
  }
}

/**
 * Custom hook to manage expand/collapse state for the Projects page.
 * Persists expanded item IDs to localStorage so state survives navigation
 * and page refreshes.
 *
 * Items are keyed by prefixed IDs:
 * - `project:{id}` for project cards
 * - `group:{id}` for group sections
 * - `group:ungrouped` for the ungrouped section
 *
 * On first visit (no localStorage data), all items start collapsed. Call
 * `seedExpanded()` with default-expanded IDs after data is available to
 * expand groups by default.
 */
export function useExpandState(): UseExpandStateReturn {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => readFromStorage());

  // Track whether localStorage had prior state (used by seedExpanded)
  const hadStoredState = useRef(hasStoredState());

  // Expose the stored-data flag as a stable value
  const hasStoredData = hadStoredState.current;

  // Use a ref to track whether the initial load from storage has happened,
  // so we don't write back to storage on mount.
  const initialized = useRef(false);

  // Track whether default seeding has already been attempted
  const seeded = useRef(false);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      return;
    }
    writeToStorage(expandedIds);
  }, [expandedIds]);

  const toggle = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const isExpanded = useCallback(
    (id: string) => expandedIds.has(id),
    [expandedIds],
  );

  const seedExpanded = useCallback((ids: string[]) => {
    // Only seed on first load when localStorage was empty
    if (seeded.current || hadStoredState.current) return;
    seeded.current = true;
    if (ids.length > 0) {
      setExpandedIds(new Set(ids));
    }
  }, []);

  return {
    expandedIds,
    toggle,
    isExpanded,
    hasStoredData,
    seedExpanded,
  };
}
