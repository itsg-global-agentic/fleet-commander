// =============================================================================
// Fleet Commander — Project Group Service
// =============================================================================
// Manages project group operations: list with counts, get with projects.
// Project groups allow organizing projects into logical collections.
// =============================================================================

import { getDatabase } from '../db.js';
import type { ProjectGroup } from '../../shared/types.js';
import { notFoundError, validationError, conflictError } from './service-error.js';

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

  /**
   * Create a new project group.
   *
   * @param data - Group creation data
   * @returns The created group record
   * @throws ServiceError with code VALIDATION if name is missing or invalid
   * @throws ServiceError with code CONFLICT if a group with the same name exists
   */
  createGroup(data: { name: string; description?: string | null }): ProjectGroup {
    const { name, description } = data;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw validationError('name is required and must be a non-empty string');
    }

    const db = getDatabase();
    try {
      return db.insertProjectGroup({
        name: name.trim(),
        description: description?.trim() || null,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('UNIQUE constraint failed')) {
        throw conflictError('A project group with this name already exists');
      }
      throw err;
    }
  }

  /**
   * Update an existing project group.
   *
   * @param groupId - The group ID
   * @param data - Fields to update
   * @returns The updated group record
   * @throws ServiceError with code VALIDATION for invalid input
   * @throws ServiceError with code NOT_FOUND if group doesn't exist
   * @throws ServiceError with code CONFLICT if name conflicts with existing group
   */
  updateGroup(groupId: number, data: { name?: string; description?: string | null }): unknown {
    if (isNaN(groupId) || groupId < 1) {
      throw validationError('Invalid group ID');
    }

    const db = getDatabase();
    const group = db.getProjectGroup(groupId);
    if (!group) {
      throw notFoundError(`Project group ${groupId} not found`);
    }

    const { name, description } = data;

    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
      throw validationError('name must be a non-empty string');
    }

    try {
      return db.updateProjectGroup(groupId, {
        name: name?.trim(),
        description: description !== undefined ? (description?.trim() || null) : undefined,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('UNIQUE constraint failed')) {
        throw conflictError('A project group with this name already exists');
      }
      throw err;
    }
  }

  /**
   * Delete a project group (unlinks associated projects).
   *
   * @param groupId - The group ID
   * @throws ServiceError with code VALIDATION if groupId is invalid
   * @throws ServiceError with code NOT_FOUND if group doesn't exist
   */
  deleteGroup(groupId: number): void {
    if (isNaN(groupId) || groupId < 1) {
      throw validationError('Invalid group ID');
    }

    const db = getDatabase();
    const group = db.getProjectGroup(groupId);
    if (!group) {
      throw notFoundError(`Project group ${groupId} not found`);
    }

    db.deleteProjectGroup(groupId);
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
