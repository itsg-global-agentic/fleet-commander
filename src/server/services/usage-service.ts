// =============================================================================
// Fleet Commander — Usage Service
// =============================================================================
// Wraps the UsageTracker for route consumption. Provides business-level methods
// for latest usage snapshot, history, and manual submission.
// =============================================================================

import { getDatabase } from '../db.js';
import { processUsageSnapshot, getUsageZone, isUsageOverrideActive, isHardPaused, activateUsageOverride, deactivateUsageOverride } from './usage-tracker.js';
import { validationError } from './service-error.js';
import config from '../config.js';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class UsageService {
  /**
   * Get the latest usage snapshot with zone and threshold info.
   *
   * @returns Latest usage snapshot enriched with zone and thresholds
   */
  getLatest(): unknown {
    const db = getDatabase();
    const latest = db.getLatestUsage();

    const thresholds = {
      daily: config.usageRedDailyPct,
      weekly: config.usageRedWeeklyPct,
      sonnet: config.usageRedSonnetPct,
      extra: config.usageRedExtraPct,
      hardExtra: config.usageHardExtraPct,
    };

    if (!latest) {
      return {
        dailyPercent: 0,
        weeklyPercent: 0,
        sonnetPercent: 0,
        extraPercent: 0,
        recordedAt: null,
        zone: getUsageZone(),
        redThresholds: thresholds,
        overrideActive: isUsageOverrideActive(),
        hardPaused: isHardPaused(),
        hardExtraThreshold: config.usageHardExtraPct,
      };
    }

    return {
      ...latest,
      zone: getUsageZone(),
      redThresholds: thresholds,
      overrideActive: isUsageOverrideActive(),
      hardPaused: isHardPaused(),
      hardExtraThreshold: config.usageHardExtraPct,
    };
  }

  /**
   * Get recent usage snapshot history.
   *
   * @param limit - Maximum number of snapshots to return (1-1000, default 50)
   * @returns Object with count and snapshots array
   */
  getHistory(limit?: number): { count: number; snapshots: unknown[] } {
    const db = getDatabase();
    const clampedLimit = Math.min(Math.max(limit ?? 50, 1), 1000);
    const history = db.getUsageHistory(clampedLimit);

    return {
      count: history.length,
      snapshots: history,
    };
  }

  /**
   * Manually submit a usage snapshot (for testing).
   *
   * @param data - Usage snapshot data
   * @returns The latest usage snapshot after insertion
   * @throws ServiceError with code VALIDATION if body is missing
   */
  async submitSnapshot(data: {
    teamId?: number;
    projectId?: number;
    sessionId?: string;
    dailyPercent?: number;
    weeklyPercent?: number;
    sonnetPercent?: number;
    extraPercent?: number;
    rawOutput?: string;
  } | null): Promise<unknown> {
    if (!data) {
      throw validationError('Request body is required');
    }

    await processUsageSnapshot({
      teamId: data.teamId,
      projectId: data.projectId,
      sessionId: data.sessionId,
      dailyPercent: data.dailyPercent,
      weeklyPercent: data.weeklyPercent,
      sonnetPercent: data.sonnetPercent,
      extraPercent: data.extraPercent,
      rawOutput: data.rawOutput,
    });

    const db = getDatabase();
    return db.getLatestUsage();
  }

  /**
   * Activate the usage override to allow launches despite soft red zone.
   *
   * @returns Override activation result
   */
  async activateOverride(): Promise<{ overrideActive: boolean; hardPaused: boolean }> {
    return activateUsageOverride();
  }

  /**
   * Deactivate the usage override.
   *
   * @returns Override deactivation result
   */
  deactivateOverride(): { overrideActive: boolean; hardPaused: boolean } {
    return deactivateUsageOverride();
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: UsageService | null = null;

/**
 * Get the singleton UsageService instance.
 *
 * @returns UsageService singleton
 */
export function getUsageService(): UsageService {
  if (!_instance) {
    _instance = new UsageService();
  }
  return _instance;
}
