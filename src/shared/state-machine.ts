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
    from: 'ci_pending',
    to: 'ci_passed',
    trigger: 'ci_status_change',
    message:
      'Hej, CI przeszlo na PR #{{PR_NUMBER}} — wszystkie checki zielone. Auto-merge jest {{AUTO_MERGE_STATUS}}. Dobra robota, czekamy na merge.',
  },
  {
    id: 'ci_red',
    from: 'ci_pending',
    to: 'ci_failed',
    trigger: 'ci_status_change',
    message:
      'CI padlo na PR #{{PR_NUMBER}}. Failujace checki: {{FAILED_CHECKS}}. To {{FAIL_COUNT}}/{{MAX_FAILURES}} unikalnych bledow — poprawcie to. Co poszlo nie tak?',
  },
  {
    id: 'ci_pending',
    from: 'pr_open',
    to: 'ci_pending',
    trigger: 'ci_status_change',
    message:
      'CI sie odpala na PR #{{PR_NUMBER}}. Czekajcie na wyniki zanim pushniecie kolejne zmiany.',
  },
  {
    id: 'pr_merged',
    from: 'pr_open',
    to: 'done',
    trigger: 'pr_merge',
    message:
      'PR #{{PR_NUMBER}} zmergowany. Dobra robota! Zamknijcie issue, posprzatajcie po sobie i konczczcie prace.',
  },
  {
    id: 'pr_merged_final',
    from: 'pr_open',
    to: 'done',
    trigger: 'pr_merge_final',
    message:
      'PR #{{PR_NUMBER}} jest zmergowany. Konczymy sesje. Dzieki za prace, zespole.',
  },
  {
    id: 'ci_blocked',
    from: 'ci_failed',
    to: 'blocked',
    trigger: 'ci_fail_threshold',
    message:
      'STOP. Macie {{FAIL_COUNT}} unikalnych typow bledow CI na PR #{{PR_NUMBER}}. Blokuje was do mojej decyzji. Nie pushujcie wiecej fixow — czekajcie na moje instrukcje.',
  },
];
