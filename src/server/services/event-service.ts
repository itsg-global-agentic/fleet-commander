// =============================================================================
// Fleet Commander — Event Service
// =============================================================================
// Wraps event queries for route consumption. The event ingestion (POST) stays
// in the route because it involves HTTP payload parsing and queue-processing
// side effects that are orchestration concerns.
// =============================================================================

import { getDatabase } from '../db.js';
import { validationError } from './service-error.js';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class EventService {
  /**
   * Query events with optional filters.
   *
   * @param filters - Optional query filters
   * @returns Array of matching events
   * @throws ServiceError with code VALIDATION for invalid filter values
   */
  queryEvents(filters: {
    teamId?: number;
    eventType?: string;
    since?: string;
    limit?: number;
  }): unknown[] {
    const { teamId, eventType, since, limit } = filters;

    if (teamId !== undefined && (isNaN(teamId) || teamId < 1)) {
      throw validationError('Invalid team_id');
    }

    if (limit !== undefined && (isNaN(limit) || limit < 1)) {
      throw validationError('Invalid limit');
    }

    const db = getDatabase();
    return db.getAllEvents({
      teamId,
      eventType,
      since,
      limit: limit ?? 100,
    });
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: EventService | null = null;

/**
 * Get the singleton EventService instance.
 *
 * @returns EventService singleton
 */
export function getEventService(): EventService {
  if (!_instance) {
    _instance = new EventService();
  }
  return _instance;
}
