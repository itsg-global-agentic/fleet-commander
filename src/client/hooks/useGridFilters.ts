import { useState, useCallback, useEffect, useRef } from 'react';
import type { TeamDashboardRow, TeamStatus } from '../../shared/types';

// ---------------------------------------------------------------------------
// localStorage key and helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'fleet-grid-filters';

interface StoredFilters {
  project: string | null;
  statuses: string[];
}

/** Read filter state from localStorage */
function readFromStorage(): { project: string | null; statuses: Set<TeamStatus> } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { project: null, statuses: new Set() };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Partial<StoredFilters>;
      const project = typeof obj.project === 'string' ? obj.project : null;
      const statuses = Array.isArray(obj.statuses)
        ? new Set(obj.statuses.filter((v): v is TeamStatus => typeof v === 'string'))
        : new Set<TeamStatus>();
      return { project, statuses };
    }
  } catch {
    // Ignore corrupt data
  }
  return { project: null, statuses: new Set() };
}

/** Write filter state to localStorage */
function writeToStorage(project: string | null, statuses: Set<TeamStatus>): void {
  try {
    const data: StoredFilters = {
      project,
      statuses: [...statuses],
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Ignore quota errors
  }
}

// ---------------------------------------------------------------------------
// Pure filter function (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Filter teams by project name and status set.
 * - If selectedProject is null, all projects match.
 * - If selectedStatuses is empty, all statuses match.
 */
export function applyGridFilters(
  teams: TeamDashboardRow[],
  selectedProject: string | null,
  selectedStatuses: Set<TeamStatus>,
): TeamDashboardRow[] {
  return teams.filter((team) => {
    if (selectedProject !== null && team.projectName !== selectedProject) {
      return false;
    }
    if (selectedStatuses.size > 0 && !selectedStatuses.has(team.status)) {
      return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Hook return type
// ---------------------------------------------------------------------------

export interface GridFilters {
  selectedProject: string | null;
  selectedStatuses: Set<TeamStatus>;
  setProject: (name: string | null) => void;
  setStatuses: (statuses: Set<TeamStatus>) => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Custom hook to manage grid filter state with localStorage persistence.
 * - selectedProject: string | null (null = "All projects")
 * - selectedStatuses: Set<TeamStatus> (empty = all statuses)
 */
export function useGridFilters(): GridFilters {
  const [selectedProject, setSelectedProject] = useState<string | null>(() => readFromStorage().project);
  const [selectedStatuses, setSelectedStatuses] = useState<Set<TeamStatus>>(() => readFromStorage().statuses);

  // Track initialization to avoid writing back on mount
  const initialized = useRef(false);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      return;
    }
    writeToStorage(selectedProject, selectedStatuses);
  }, [selectedProject, selectedStatuses]);

  const setProject = useCallback((name: string | null) => {
    setSelectedProject(name);
  }, []);

  const setStatuses = useCallback((statuses: Set<TeamStatus>) => {
    setSelectedStatuses(statuses);
  }, []);

  return {
    selectedProject,
    selectedStatuses,
    setProject,
    setStatuses,
  };
}
