// =============================================================================
// Fleet Commander — Default Message Templates
// =============================================================================
// Message templates used to seed the database on first run. These are
// decoupled from the state machine transitions so that transition logic
// and messaging concerns remain separate.
// =============================================================================

interface DefaultMessageTemplate {
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
    id: 'ci_green_but_dirty',
    template:
      'CI passed on PR #{{PR_NUMBER}}, all checks green. However, the PR has merge conflicts. Rebase or merge the base branch to resolve conflicts before merging. Auto-merge is {{AUTO_MERGE_STATUS}}.',
    description:
      'Sent to TL when CI passes but PR has merge conflicts (dirty merge state)',
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
    id: 'pr_merged_shutdown',
    template:
      'PR #{{PR_NUMBER}} has been merged successfully. Shut down all subagents immediately and exit. Do not start new work.',
    description: 'Sent to TL when PR is merged to trigger graceful shutdown',
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
    id: 'idle_nudge',
    template:
      'FC status check: You\'ve been idle for {{IDLE_MINUTES}} minutes. If waiting for subagents, run TaskList to verify they are still active. If a phase just completed, proceed to the next step.',
    description:
      'Sent to TL when team transitions to idle to prompt a status check',
    placeholders: ['IDLE_MINUTES'],
  },
  {
    id: 'stuck_nudge',
    template:
      'Hey, you have been idle for a while on issue #{{ISSUE_NUMBER}}. What is the status? Do you need help?',
    description:
      'Sent to TL when team transitions to stuck to nudge them back to work',
    placeholders: ['ISSUE_NUMBER'],
  },
  {
    id: 'nudge_progress',
    template: "What's your current progress on issue #{{ISSUE_NUMBER}}? Give me a brief status update.",
    description: 'Ask TL for a status update on the issue',
    placeholders: ['ISSUE_NUMBER'],
  },
  {
    id: 'ask_for_pr',
    template: 'Please open a PR with your current changes for issue #{{ISSUE_NUMBER}}. Push what you have.',
    description: 'Ask TL to create a pull request',
    placeholders: ['ISSUE_NUMBER'],
  },
  {
    id: 'check_ci',
    template: 'CI is failing on PR #{{PR_NUMBER}}. Check the failing tests and fix them.',
    description: 'Tell TL to investigate CI failures',
    placeholders: ['PR_NUMBER'],
  },
  {
    id: 'wrap_up',
    template: 'Wrap up your work on issue #{{ISSUE_NUMBER}}. Commit all changes, push, and open a PR if not already done.',
    description: 'Tell TL to finish up and create PR',
    placeholders: ['ISSUE_NUMBER'],
  },
  {
    id: 'merge_conflict',
    template:
      'PR #{{PR_NUMBER}} has merge conflicts. Rebase or merge the base branch to resolve conflicts before CI can run.',
    description: 'Sent to TL when PR has merge conflicts (dirty merge state)',
    placeholders: ['PR_NUMBER'],
  },
  {
    id: 'merge_conflict_resolved',
    template:
      'Merge conflicts on PR #{{PR_NUMBER}} are resolved. The PR is mergeable again.',
    description: 'Sent to TL when merge conflicts are resolved',
    placeholders: ['PR_NUMBER'],
  },
  {
    id: 'branch_behind',
    template:
      'Your PR #{{PR_NUMBER}} is behind main. Please rebase onto origin/main and force-push: `git fetch origin main && git rebase origin/main && git push --force-with-lease`.',
    description: 'Sent to TL when PR branch is behind main',
    placeholders: ['PR_NUMBER'],
  },
  {
    id: 'branch_behind_resolved',
    template:
      'Your PR #{{PR_NUMBER}} branch is now up-to-date with main. No rebase needed.',
    description: 'Sent to TL when PR branch is no longer behind main',
    placeholders: ['PR_NUMBER'],
  },
];
