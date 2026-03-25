// =============================================================================
// Fleet Commander — Event Service
// =============================================================================
// Wraps event queries for route consumption. The event ingestion (POST) stays
// in the route because it involves HTTP payload parsing and queue-processing
// side effects that are orchestration concerns.
// =============================================================================

import { getDatabase } from '../db.js';
import { validationError } from './service-error.js';
import type { PaginatedResponse, Event } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class EventService {
  /**
   * Query events with optional filters and pagination.
   *
   * @param filters - Optional query filters including pagination
   * @returns Paginated response with matching events
   * @throws ServiceError with code VALIDATION for invalid filter values
   */
  queryEvents(filters: {
    teamId?: number;
    eventType?: string;
    since?: string;
    limit?: number;
    offset?: number;
  }): PaginatedResponse<Event> {
    const { teamId, eventType, since, limit, offset } = filters;

    if (teamId !== undefined && (isNaN(teamId) || teamId < 1)) {
      throw validationError('Invalid team_id');
    }

    if (limit !== undefined && (isNaN(limit) || limit < 1)) {
      throw validationError('Invalid limit');
    }

    if (offset !== undefined && (isNaN(offset) || offset < 0)) {
      throw validationError('Invalid offset');
    }

    const effectiveLimit = limit ?? 100;
    const effectiveOffset = offset ?? 0;

    const db = getDatabase();
    const filterObj = { teamId, eventType, since, limit: effectiveLimit, offset: effectiveOffset };
    const data = db.getAllEvents(filterObj);
    const total = db.getAllEventsCount(filterObj);

    return { data, total, limit: effectiveLimit, offset: effectiveOffset };
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
