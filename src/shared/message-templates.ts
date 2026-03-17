// =============================================================================
// Fleet Commander — Default Message Templates
// =============================================================================
// Message templates used to seed the database on first run. These are
// decoupled from the state machine transitions so that transition logic
// and messaging concerns remain separate.
// =============================================================================

export interface DefaultMessageTemplate {
  id: string;
  template: string;
  description: string;
  placeholders: string[];
}

export const DEFAULT_MESSAGE_TEMPLATES: DefaultMessageTemplate[] = [
  {
    id: 'ci_green',
    template:
      'CI passed on PR #{{PR_NUMBER}}, all checks green. Auto-merge is {{AUTO_MERGE_STATUS}}.',
    description: 'Sent to TL when CI passes',
    placeholders: ['PR_NUMBER', 'AUTO_MERGE_STATUS'],
  },
  {
    id: 'ci_red',
    template:
      'CI failed on PR #{{PR_NUMBER}}. Failing checks: {{FAILED_CHECKS}}. Fix count: {{FAIL_COUNT}}/{{MAX_FAILURES}}. What went wrong?',
    description: 'Sent to TL when CI fails',
    placeholders: ['PR_NUMBER', 'FAILED_CHECKS', 'FAIL_COUNT', 'MAX_FAILURES'],
  },
  {
    id: 'pr_merged',
    template:
      'PR #{{PR_NUMBER}} merged. Close the issue, clean up, and finish.',
    description: 'Sent to TL when PR is merged',
    placeholders: ['PR_NUMBER'],
  },
  {
    id: 'ci_blocked',
    template:
      'STOP. {{FAIL_COUNT}} unique CI failure types on PR #{{PR_NUMBER}}. Wait for my instructions.',
    description: 'Sent to TL when team is blocked by CI failures',
    placeholders: ['PR_NUMBER', 'FAIL_COUNT'],
  },
  {
    id: 'stuck_nudge',
    template:
      'Hey, you have been idle for a while on issue #{{ISSUE_NUMBER}}. What is the status? Do you need help?',
    description:
      'Sent to TL when team transitions to stuck to nudge them back to work',
    placeholders: ['ISSUE_NUMBER', 'TEAM_NAME'],
  },
];
