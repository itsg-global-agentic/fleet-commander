// =============================================================================
// Fleet Commander — Diagnostics Service
// =============================================================================
// Provides fleet health diagnostics: blocked teams, health summaries,
// and factory reset capability. Used by system routes and future MCP tools.
// =============================================================================

import { getDatabase } from '../db.js';
import { getTeamManager } from './team-manager.js';
import { sseBroker } from './sse-broker.js';
import { getIssueFetcher } from './issue-fetcher.js';
import { uninstallHooks } from '../utils/hook-installer.js';
import { DEFAULT_MESSAGE_TEMPLATES } from '../../shared/message-templates.js';
import config from '../config.js';
import { ServiceError, validationError } from './service-error.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A team that is blocked by CI failures exceeding the threshold */
export interface BlockedTeam {
  teamId: number;
  worktreeName: string;
  issueNumber: number;
  issueTitle: string | null;
  status: string;
  phase: string;
  prNumber: number;
  ciStatus: string;
  ciFailCount: number;
  maxAllowed: number;
}

/** Fleet health summary with counts by status and phase */
export interface HealthSummary {
  totalTeams: number;
  activeTeams: number;
  stuckOrIdle: number;
  byStatus: Record<string, number>;
  byPhase: Record<string, number>;
}

/** Result of a factory reset operation */
export interface FactoryResetResult {
  status: string;
  message: string;
  templatesSeeded: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DiagnosticsService {
  /**
   * Get active teams that are blocked by CI failures exceeding the threshold.
   *
   * @returns Object with threshold config and list of blocked teams
   */
  getBlockedTeams(): { maxUniqueCiFailures: number; count: number; teams: BlockedTeam[] } {
    const db = getDatabase();
    const teams = db.getActiveTeams();
    const blockedTeams: BlockedTeam[] = [];

    for (const team of teams) {
      if (!team.prNumber) continue;

      const pr = db.getPullRequest(team.prNumber);
      if (!pr) continue;

      if (pr.ciStatus === 'failing' && pr.ciFailCount >= config.maxUniqueCiFailures) {
        blockedTeams.push({
          teamId: team.id,
          worktreeName: team.worktreeName,
          issueNumber: team.issueNumber,
          issueTitle: team.issueTitle,
          status: team.status,
          phase: team.phase,
          prNumber: pr.prNumber,
          ciStatus: pr.ciStatus,
          ciFailCount: pr.ciFailCount,
          maxAllowed: config.maxUniqueCiFailures,
        });
      }
    }

    return {
      maxUniqueCiFailures: config.maxUniqueCiFailures,
      count: blockedTeams.length,
      teams: blockedTeams,
    };
  }

  /**
   * Get a fleet health summary with counts by status and phase.
   *
   * @returns Health summary object
   */
  getHealthSummary(): HealthSummary {
    const db = getDatabase();
    const allTeams = db.getTeams();

    const statusCounts: Record<string, number> = {};
    for (const team of allTeams) {
      statusCounts[team.status] = (statusCounts[team.status] ?? 0) + 1;
    }

    const phaseCounts: Record<string, number> = {};
    for (const team of allTeams) {
      phaseCounts[team.phase] = (phaseCounts[team.phase] ?? 0) + 1;
    }

    const activeTeams = db.getActiveTeams();
    const stuckCandidates = db.getStuckCandidates(
      config.idleThresholdMin,
      config.stuckThresholdMin,
    );

    return {
      totalTeams: allTeams.length,
      activeTeams: activeTeams.length,
      stuckOrIdle: stuckCandidates.length,
      byStatus: statusCounts,
      byPhase: phaseCounts,
    };
  }

  /**
   * Perform a full factory reset: stop all teams, uninstall hooks,
   * delete all data, re-seed default templates, and clear caches.
   *
   * @param confirm - Must be 'FACTORY_RESET' to proceed
   * @returns Result indicating success and number of templates seeded
   * @throws ServiceError with code VALIDATION if confirmation is missing
   */
  async factoryReset(confirm: string): Promise<FactoryResetResult> {
    if (confirm !== 'FACTORY_RESET') {
      throw validationError('Factory reset requires confirm = "FACTORY_RESET"');
    }

    const db = getDatabase();
    const manager = getTeamManager();

    // 1. Stop all running teams
    const activeTeams = db.getActiveTeams();
    for (const team of activeTeams) {
      try {
        await manager.stop(team.id);
      } catch {
        // Best-effort -- continue stopping remaining teams
      }
    }

    // 2. Uninstall hooks from all projects before deleting them
    const projects = db.getProjects();
    for (const project of projects) {
      // uninstallHooks requires a logger; use a minimal console-based one
      uninstallHooks(project.repoPath, _minimalLogger);
    }

    // 3. Delete all data and re-seed default templates
    const templatesSeeded = db.factoryReset(
      DEFAULT_MESSAGE_TEMPLATES.map((t) => ({ id: t.id, template: t.template })),
    );

    // 4. Clear in-memory caches
    const issueFetcher = getIssueFetcher();
    issueFetcher.stop();
    issueFetcher.clearAll();

    // 5. Broadcast empty state to all SSE clients
    sseBroker.broadcast('snapshot', { teams: [] });

    return {
      status: 'ok',
      message: 'Factory reset complete. All projects, teams, and data have been cleared.',
      templatesSeeded,
    };
  }
}

// ---------------------------------------------------------------------------
// Minimal logger for use outside Fastify request context
// ---------------------------------------------------------------------------

const _minimalLogger = {
  info: (...args: unknown[]) => console.log('[DiagnosticsService]', ...args),
  warn: (...args: unknown[]) => console.warn('[DiagnosticsService]', ...args),
  error: (...args: unknown[]) => console.error('[DiagnosticsService]', ...args),
} as any;

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: DiagnosticsService | null = null;

/**
 * Get the singleton DiagnosticsService instance.
 *
 * @returns DiagnosticsService singleton
 */
export function getDiagnosticsService(): DiagnosticsService {
  if (!_instance) {
    _instance = new DiagnosticsService();
  }
  return _instance;
}
