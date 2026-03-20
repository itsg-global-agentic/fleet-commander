// =============================================================================
// Fleet Commander — Project Group Service
// =============================================================================
// Manages project group operations: list with counts, get with projects.
// Project groups allow organizing projects into logical collections.
// =============================================================================

import { getDatabase } from '../db.js';
import type { ProjectGroup } from '../../shared/types.js';
import { notFoundError } from './service-error.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A project group enriched with the count of linked projects */
export interface ProjectGroupWithCount extends ProjectGroup {
  projectCount: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ProjectGroupService {
  /**
   * List all project groups with their project counts.
   *
   * @returns Array of project groups enriched with project counts
   */
  listWithCounts(): ProjectGroupWithCount[] {
    const db = getDatabase();
    const groups = db.getProjectGroups();
    const allProjects = db.getProjects();

    return groups.map((g: ProjectGroup) => {
      const linked = allProjects.filter((p) => p.groupId === g.id);
      return {
        ...g,
        projectCount: linked.length,
      };
    });
  }

  /**
   * Get a single project group with its linked projects.
   *
   * @param groupId - The project group ID
   * @returns Group details with projects array
   * @throws ServiceError with code NOT_FOUND if group doesn't exist
   */
  getWithProjects(groupId: number): ProjectGroup & { projects: unknown[] } {
    const db = getDatabase();
    const group = db.getProjectGroup(groupId);
    if (!group) {
      throw notFoundError(`Project group ${groupId} not found`);
    }

    const allProjects = db.getProjects();
    const projects = allProjects.filter((p) => p.groupId === groupId);

    return {
      ...group,
      projects,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: ProjectGroupService | null = null;

/**
 * Get the singleton ProjectGroupService instance.
 *
 * @returns ProjectGroupService singleton
 */
export function getProjectGroupService(): ProjectGroupService {
  if (!_instance) {
    _instance = new ProjectGroupService();
  }
  return _instance;
}
