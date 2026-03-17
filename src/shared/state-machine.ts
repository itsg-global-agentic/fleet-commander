// =============================================================================
// Fleet Commander — State Machine Transitions (placeholder)
// =============================================================================
// This file defines the state machine transitions that drive the team lifecycle.
// A research agent (sm-research) may overwrite this with a full definition.
// For now, it provides enough structure for the message template system to work.
// =============================================================================

export interface StateMachineTransition {
  id: string;
  from: string;
  to: string;
  trigger: string;
  message?: string;
}

/**
 * Default state machine transitions with message templates.
 * Templates use {{PLACEHOLDER}} syntax for variable substitution.
 */
export const STATE_MACHINE_TRANSITIONS: StateMachineTransition[] = [
  {
    id: 'ci_green',
    from: 'running',
    to: 'running',
    trigger: 'ci_status_change',
    message:
      'CI passed on PR #{{PR_NUMBER}}, all checks green. Auto-merge is {{AUTO_MERGE_STATUS}}.',
  },
  {
    id: 'ci_red',
    from: 'running',
    to: 'running',
    trigger: 'ci_status_change',
    message:
      'CI failed on PR #{{PR_NUMBER}}. Failing checks: {{FAILED_CHECKS}}. Fix count: {{FAIL_COUNT}}/{{MAX_FAILURES}}. What went wrong?',
  },
  {
    id: 'pr_merged',
    from: '*',
    to: 'done',
    trigger: 'pr_merge',
    message:
      'PR #{{PR_NUMBER}} merged. Close the issue, clean up, and finish.',
  },
  {
    id: 'ci_blocked',
    from: '*',
    to: 'stuck',
    trigger: 'ci_fail_threshold',
    message:
      'STOP. {{FAIL_COUNT}} unique CI failure types on PR #{{PR_NUMBER}}. Wait for my instructions.',
  },
];
