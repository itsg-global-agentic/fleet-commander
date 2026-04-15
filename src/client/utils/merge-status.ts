// =============================================================================
// Fleet Commander — Merge Status Colors & Labels (shared by PRDetail + TeamDetail)
// =============================================================================

import type { MergeStatus } from '../../shared/types.js';

/** Color map for merge status badge rendering */
export const MERGE_STATUS_COLORS: Record<MergeStatus, string> = {
  clean: '#3FB950',
  behind: '#D29922',
  blocked: '#F85149',
  blocked_ci_pending: '#D29922',
  blocked_ci_failed: '#F85149',
  blocked_review: '#D29922',
  blocked_unknown: '#F85149',
  dirty: '#F85149',
  unstable: '#D29922',
  has_hooks: '#D29922',
  draft: '#8B949E',
  unknown: '#8B949E',
};

/** Human-readable labels for merge status badge rendering */
export const MERGE_STATUS_LABELS: Record<MergeStatus, string> = {
  clean: 'CLEAN',
  behind: 'BEHIND',
  blocked: 'BLOCKED',
  blocked_ci_pending: 'CI PENDING',
  blocked_ci_failed: 'CI FAILED',
  blocked_review: 'REVIEW REQUIRED',
  blocked_unknown: 'BLOCKED',
  dirty: 'DIRTY',
  unstable: 'UNSTABLE',
  has_hooks: 'HAS HOOKS',
  draft: 'DRAFT',
  unknown: 'UNKNOWN',
};

/** Get the color for a merge status string, with fallback */
export function getMergeStatusColor(status: string | null | undefined): string {
  return MERGE_STATUS_COLORS[status as MergeStatus] ?? '#8B949E';
}

/** Get the human-readable label for a merge status string, with fallback */
export function getMergeStatusLabel(status: string | null | undefined): string {
  return MERGE_STATUS_LABELS[status as MergeStatus] ?? (status?.toUpperCase() ?? 'UNKNOWN');
}
