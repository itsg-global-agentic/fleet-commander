// =============================================================================
// Fleet Commander — Message Template Service
// =============================================================================
// Manages PM->TL message templates used by the state machine.
// Templates are stored in the DB with fallbacks to shared defaults.
// =============================================================================

import { getDatabase } from '../db.js';
import { DEFAULT_MESSAGE_TEMPLATES } from '../../shared/message-templates.js';
import { ServiceError, notFoundError, validationError } from './service-error.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Enriched message template returned by listTemplates */
export interface EnrichedMessageTemplate {
  id: string;
  template: string;
  enabled: boolean;
  description: string;
  placeholders: string[];
  isDefault: boolean;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class MessageTemplateService {
  /**
   * List all message templates, merging DB overrides with shared defaults.
   * Every default template is always returned, even if no DB row exists.
   *
   * @returns Array of enriched message templates
   */
  listTemplates(): EnrichedMessageTemplate[] {
    const db = getDatabase();
    const dbTemplates = db.getMessageTemplates();
    const dbMap = new Map(dbTemplates.map((t) => [t.id, t]));

    return DEFAULT_MESSAGE_TEMPLATES.map((def) => {
      const dbRow = dbMap.get(def.id);
      return {
        id: def.id,
        template: dbRow?.template ?? def.template,
        enabled: dbRow?.enabled ?? true,
        description: def.description,
        placeholders: def.placeholders,
        isDefault: !dbRow,
      };
    });
  }

  /**
   * Insert or update a message template in the database.
   * If the template ID does not exist in defaults, throws NOT_FOUND.
   *
   * @param id - Template identifier (must match a default template ID)
   * @param data - Fields to update (template text and/or enabled flag)
   * @returns The updated template row from the database
   * @throws ServiceError with code VALIDATION if body is empty
   * @throws ServiceError with code NOT_FOUND if template ID is unknown
   */
  upsertTemplate(
    id: string,
    data: { template?: string; enabled?: boolean },
  ): Record<string, unknown> {
    if (data.template === undefined && data.enabled === undefined) {
      throw validationError('Body must include at least one of: template, enabled');
    }

    const db = getDatabase();
    const existing = db.getMessageTemplate(id);

    if (existing) {
      db.updateMessageTemplate(id, {
        template: data.template,
        enabled: data.enabled,
      });
    } else {
      const defaultTmpl = DEFAULT_MESSAGE_TEMPLATES.find((t) => t.id === id);
      if (!defaultTmpl) {
        throw notFoundError(`No message template found for id '${id}'`);
      }

      db.insertMessageTemplate({
        id,
        template: data.template ?? defaultTmpl.template,
        enabled: data.enabled ?? true,
      });
    }

    return db.getMessageTemplate(id)!;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: MessageTemplateService | null = null;

/**
 * Get the singleton MessageTemplateService instance.
 *
 * @returns MessageTemplateService singleton
 */
export function getMessageTemplateService(): MessageTemplateService {
  if (!_instance) {
    _instance = new MessageTemplateService();
  }
  return _instance;
}
