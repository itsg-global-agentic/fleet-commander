// =============================================================================
// Fleet Commander — State Machine Transitions (authoritative definition)
// =============================================================================
// Single source of truth for ALL team lifecycle transitions. Both the API
// routes and the github-poller reference this array. This file is PURELY
// about state transitions — message templates live in message-templates.ts.
// =============================================================================

import type { TeamStatus, TeamPhase } from './types.js';

export type TriggerType = 'hook' | 'timer' | 'poller' | 'pm_action' | 'system';

export interface StateMachineTransition {
  id: string;
  from: TeamStatus | '*';
  to: TeamStatus;
  trigger: TriggerType;
  triggerLabel: string;
  description: string;
  condition: string;
  hookEvent?: string | null;
}

export interface StateMachineState {
  id: string;
  label: string;
  color: string;
}

/**
 * All possible team states.
 */
export const STATES: StateMachineState[] = [
  { id: 'queued', label: 'Queued', color: '#8B949E' },
  { id: 'launching', label: 'Launching', color: '#58A6FF' },
  { id: 'running', label: 'Running', color: '#3FB950' },
  { id: 'idle', label: 'Idle', color: '#D29922' },
  { id: 'stuck', label: 'Stuck', color: '#F85149' },
  { id: 'done', label: 'Done', color: '#A371F7' },
  { id: 'failed', label: 'Failed', color: '#F85149' },
];

/**
 * All state machine transitions. This array is the single source of truth
 * for team lifecycle state changes. Message templates are defined separately
 * in message-templates.ts.
 */
export const STATE_MACHINE_TRANSITIONS: StateMachineTransition[] = [
  // ---- Lifecycle transitions ----
  {
    id: 'queued-blocked',
    from: 'queued',
    to: 'queued',
    trigger: 'system',
    triggerLabel: 'Queue processor skips blocked team',
    description:
      'Queue processor checks dependencies and skips teams with open blockers. ' +
      'The team remains queued until all dependencies resolve. Auto-launches when ' +
      'the GitHub poller detects all blockers are closed.',
    condition: 'Issue has unresolved dependencies (open blockers)',
    hookEvent: null,
  },
  {
    id: 'queued-launching',
    from: 'queued',
    to: 'launching',
    trigger: 'system',
    triggerLabel: 'Queue processor',
    description: 'Team slot becomes available and all dependencies are resolved; next queued team is launched',
    condition: 'Active teams < maxActiveTeams for project AND no open dependencies',
    hookEvent: null,
  },
  {
    id: 'queued-launching-force',
    from: 'queued',
    to: 'launching',
    trigger: 'pm_action',
    triggerLabel: 'PM force launch',
    description: 'PM force-launches a queued team, bypassing usage gate and slot limits',
    condition: 'Manual PM action via API, bypasses usage gate',
    hookEvent: null,
  },
  {
    id: 'launching-running',
    from: 'launching',
    to: 'running',
    trigger: 'hook',
    triggerLabel: 'First hook event received',
    description: 'Claude Code process starts and sends its first lifecycle hook',
    condition: 'Process PID is alive and first event arrives',
    hookEvent: 'session_start | subagent_start',
  },
  {
    id: 'running-idle',
    from: 'running',
    to: 'idle',
    trigger: 'timer',
    triggerLabel: 'Idle threshold exceeded',
    description:
      'No hook events received within the idle threshold period. Sends idle_nudge message to TL prompting a subagent status check.',
    condition: 'lastEventAt + idleThresholdMin < now',
    hookEvent: null,
  },
  {
    id: 'idle-running',
    from: 'idle',
    to: 'running',
    trigger: 'hook',
    triggerLabel: 'Activity resumes',
    description:
      'A non-dormancy hook event is received from the idle team. Dormancy events (stop, session_end) do NOT trigger this transition because they indicate the agent finished its turn, not that it resumed work.',
    condition: 'New hook event arrives AND event is not a dormancy event (stop, session_end)',
    hookEvent: 'tool_use | session_start | subagent_start | subagent_stop | notification | teammate_idle',
  },
  {
    id: 'running-done',
    from: 'running',
    to: 'done',
    trigger: 'hook',
    triggerLabel: 'Session ends successfully',
    description:
      'Claude Code session completes normally with exit code 0. FC forces a final github-poller reconciliation before committing the done transition so stale ci/merge state is refreshed (see issue #701 / #686).',
    condition:
      'Process exits with code 0 AND (team has no PR OR forced reconcile shows PR state = merged OR shutdown reason contains no merge claim)',
    hookEvent: 'session_end',
  },
  {
    id: 'running-done-rejected',
    from: 'running',
    to: 'running',
    trigger: 'system',
    triggerLabel: 'Done rejected — bogus merge claim',
    description:
      'Process exited with code 0 and the TL\'s shutdown reason or last assistant message claimed the PR was merged, but the final forced github-poller reconcile shows the PR is still OPEN on GitHub. FC refuses the done transition, sends a verification_required message to the TL via stdin, and logs a warning. Typical cause: force-push after enabling auto-merge silently dropped the pending auto-merge and the TL declared merge success from memory without re-verifying (see issue #701).',
    condition:
      'Process exit code 0 AND shutdown reason claims merge AND forced reconcile shows PR state = open',
    hookEvent: 'session_end',
  },
  {
    id: 'idle-stuck',
    from: 'idle',
    to: 'stuck',
    trigger: 'timer',
    triggerLabel: 'Stuck threshold exceeded',
    description: 'Team has been idle beyond the stuck detection threshold',
    condition: 'lastEventAt + stuckThresholdMin < now',
    hookEvent: null,
  },
  {
    id: 'stuck-failed',
    from: 'stuck',
    to: 'failed',
    trigger: 'pm_action',
    triggerLabel: 'PM marks team as failed',
    description: 'PM decides stuck team cannot recover and stops it',
    condition: 'Manual PM action via API',
    hookEvent: null,
  },
  {
    id: 'stuck-running',
    from: 'stuck',
    to: 'running',
    trigger: 'hook',
    triggerLabel: 'Activity resumes',
    description:
      'A non-dormancy hook event is received from the stuck team, indicating it recovered. Dormancy events (stop, session_end) do NOT trigger this transition.',
    condition: 'New hook event arrives AND event is not a dormancy event (stop, session_end)',
    hookEvent: 'tool_use | session_start | subagent_start | subagent_stop | notification | teammate_idle',
  },
  {
    id: 'running-failed',
    from: 'running',
    to: 'failed',
    trigger: 'system',
    triggerLabel: 'Process crash or CI failure limit',
    description:
      'Claude Code process exits with non-zero code or CI failures exceed threshold',
    condition: 'Process exits abnormally or ciFailCount >= maxUniqueCiFailures',
    hookEvent: null,
  },
  {
    id: 'launching-failed',
    from: 'launching',
    to: 'failed',
    trigger: 'system',
    triggerLabel: 'Launch failure',
    description: 'Claude Code process fails to start or crashes immediately',
    condition: 'Process exits before first event or spawn error',
    hookEvent: null,
  },
  {
    id: 'idle-done',
    from: 'idle',
    to: 'done',
    trigger: 'poller',
    triggerLabel: 'PR merged detected by poller',
    description:
      'GitHub poller detects PR has been merged while team was idle',
    condition: 'PR state = merged',
    hookEvent: null,
  },

  // ---- Additional lifecycle transitions ----
  {
    id: 'queued-failed',
    from: 'queued',
    to: 'failed',
    trigger: 'system',
    triggerLabel: 'Worktree setup failure or PM stop',
    description: 'Worktree creation fails, PM stops queued team, or project is deleted',
    condition: 'Worktree error, PM action, or project removal',
    hookEvent: null,
  },
  {
    id: 'idle-failed',
    from: 'idle',
    to: 'failed',
    trigger: 'system',
    triggerLabel: 'Process crash',
    description: 'Claude Code process crashes while team was idle',
    condition: 'Process exits abnormally while in idle state',
    hookEvent: null,
  },
  {
    id: 'stuck-idle',
    from: 'stuck',
    to: 'idle',
    trigger: 'pm_action',
    triggerLabel: 'PM acknowledges stuck team',
    description: 'PM acknowledges the stuck state and resets to idle for continued monitoring',
    condition: 'Manual PM action via API',
    hookEvent: null,
  },
  {
    id: 'failed-done',
    from: 'failed',
    to: 'done',
    trigger: 'pm_action',
    triggerLabel: 'PM acknowledges failure',
    description: 'PM acknowledges the failure and marks the team as done',
    condition: 'Manual PM action via API',
    hookEvent: null,
  },
  {
    id: 'failed-queued',
    from: 'failed',
    to: 'queued',
    trigger: 'pm_action',
    triggerLabel: 'PM relaunches team',
    description: 'PM relaunches a failed team by re-queuing it',
    condition: 'Manual PM action via API',
    hookEvent: null,
  },
  {
    id: 'failed-queued-auto',
    from: 'failed',
    to: 'queued',
    trigger: 'timer',
    triggerLabel: 'Auto-retry timer',
    description: 'Failed team auto-retries after configurable delay when daily usage is below threshold and retry count has not been exhausted',
    condition: 'stoppedAt + retryDelayMin < now AND dailyUsage < retryMaxDailyPct AND retryCount < retryMaxCount',
    hookEvent: null,
  },
  {
    id: 'failed-launching',
    from: 'failed',
    to: 'launching',
    trigger: 'pm_action',
    triggerLabel: 'PM resumes team',
    description: 'PM directly resumes a failed team, skipping the queue',
    condition: 'Manual PM action via API',
    hookEvent: null,
  },

  // ---- Poller / CI event transitions ----
  {
    id: 'ci_green',
    from: 'running',
    to: 'running',
    trigger: 'poller',
    triggerLabel: 'CI green',
    description: 'All CI checks pass on the PR',
    condition: 'CI status changes to success',
    hookEvent: null,
  },
  {
    id: 'ci_green_auto_shutdown',
    from: 'running',
    to: 'done',
    trigger: 'poller',
    triggerLabel: 'CI green + auto-merge → early shutdown',
    description:
      'CI passes, auto-merge is enabled, and no merge conflicts. Team shuts down ' +
      'immediately without waiting for the actual merge event — GitHub handles the merge.',
    condition: 'CI status = passing AND autoMerge = true AND mergeStatus != dirty',
    hookEvent: null,
  },
  {
    id: 'ci_green_but_dirty',
    from: 'running',
    to: 'running',
    trigger: 'poller',
    triggerLabel: 'CI green but merge conflicts',
    description:
      'All CI checks pass but PR has merge conflicts — TL needs to rebase before merge is possible',
    condition: 'CI status changes to success AND merge status is dirty',
    hookEvent: null,
  },
  {
    id: 'ci_red',
    from: 'running',
    to: 'running',
    trigger: 'poller',
    triggerLabel: 'CI red',
    description: 'One or more CI checks fail on the PR',
    condition: 'CI status changes to failure',
    hookEvent: null,
  },
  {
    id: 'pr_merged',
    from: '*',
    to: 'done',
    trigger: 'poller',
    triggerLabel: 'PR merged',
    description:
      'PR has been merged on GitHub. Sends pr_merged_shutdown message to TL, waits grace period (default 2min), then closes stdin and force-kills if still alive.',
    condition: 'PR merge event detected',
    hookEvent: null,
  },
  {
    id: 'ci_blocked',
    from: '*',
    to: 'stuck',
    trigger: 'poller',
    triggerLabel: 'CI blocked',
    description:
      'Too many unique CI failure types — team cannot self-recover',
    condition: 'Unique CI failure count >= threshold',
    hookEvent: null,
  },
  {
    id: 'merge_conflict',
    from: 'running',
    to: 'running',
    trigger: 'poller',
    triggerLabel: 'Merge conflict detected',
    description: 'PR merge state changed to dirty — conflicts need resolution',
    condition: 'Merge status changes to dirty',
    hookEvent: null,
  },
  {
    id: 'merge_conflict_resolved',
    from: 'running',
    to: 'running',
    trigger: 'poller',
    triggerLabel: 'Merge conflict resolved',
    description: 'PR merge conflicts have been resolved',
    condition: 'Merge status changes from dirty to another state',
    hookEvent: null,
  },
  {
    id: 'branch_behind',
    from: 'running',
    to: 'running',
    trigger: 'poller',
    triggerLabel: 'Branch behind base',
    description: 'PR branch is behind the base branch — rebase needed',
    condition: 'Merge status changes to behind',
    hookEvent: null,
  },
  {
    id: 'branch_behind_resolved',
    from: 'running',
    to: 'running',
    trigger: 'poller',
    triggerLabel: 'Branch up-to-date',
    description: 'PR branch is no longer behind the base branch',
    condition: 'Merge status changes from behind to another state (not dirty)',
    hookEvent: null,
  },

  // ---- Issue update poller transitions ----
  {
    id: 'issue_comment_new',
    from: 'running',
    to: 'running',
    trigger: 'poller',
    triggerLabel: 'New issue comment',
    description: 'A new non-bot comment was posted on the issue. Forwarded to TL for awareness.',
    condition: 'New comment detected on issue (bot comments filtered)',
    hookEvent: null,
  },
  {
    id: 'issue_labels_changed',
    from: 'running',
    to: 'running',
    trigger: 'poller',
    triggerLabel: 'Issue labels changed',
    description: 'Priority or blocking labels changed on the issue.',
    condition: 'Priority/blocking label added or removed',
    hookEvent: null,
  },
  {
    id: 'issue_closed_externally',
    from: '*',
    to: 'done',
    trigger: 'poller',
    triggerLabel: 'Issue closed externally',
    description: 'The issue was closed outside of the team workflow. Team receives shutdown message and is stopped gracefully.',
    condition: 'Issue state changed from open to closed',
    hookEvent: null,
  },
  {
    id: 'issue_body_updated',
    from: 'running',
    to: 'running',
    trigger: 'poller',
    triggerLabel: 'Issue body updated',
    description: 'The issue description was edited. TL is notified to review updated requirements.',
    condition: 'Issue body hash changed',
    hookEvent: null,
  },
];

// =============================================================================
// Phase Transitions (informational — documents automatic phase tracking)
// =============================================================================
// Phase transitions are driven by SubagentStart/SubagentStop hook events
// and GitHub poller PR detection. The logic lives in event-collector.ts;
// these entries document the transitions for the /lifecycle UI view.
// =============================================================================

export interface PhaseTransition {
  id: string;
  fromPhase: TeamPhase;
  toPhase: TeamPhase;
  trigger: TriggerType;
  triggerLabel: string;
  description: string;
  hookEvent?: string | null;
}

export const PHASE_TRANSITIONS: PhaseTransition[] = [
  {
    id: 'phase-init-analyzing',
    fromPhase: 'init',
    toPhase: 'analyzing',
    trigger: 'hook',
    triggerLabel: 'Planner subagent starts',
    description: 'SubagentStart event received for an agent classified as planner role',
    hookEvent: 'subagent_start',
  },
  {
    id: 'phase-analyzing-implementing',
    fromPhase: 'analyzing',
    toPhase: 'implementing',
    trigger: 'hook',
    triggerLabel: 'Planner subagent stops',
    description: 'SubagentStop event received for planner role, indicating analysis complete and development expected',
    hookEvent: 'subagent_stop',
  },
  {
    id: 'phase-implementing-reviewing',
    fromPhase: 'implementing',
    toPhase: 'reviewing',
    trigger: 'hook',
    triggerLabel: 'Dev subagent stops',
    description: 'SubagentStop event received for dev role, indicating implementation complete and review expected',
    hookEvent: 'subagent_stop',
  },
  {
    id: 'phase-reviewing-pr',
    fromPhase: 'reviewing',
    toPhase: 'pr',
    trigger: 'hook',
    triggerLabel: 'Reviewer subagent stops',
    description: 'SubagentStop event received for reviewer role, indicating review complete and PR expected',
    hookEvent: 'subagent_stop',
  },
  {
    id: 'phase-pr-detected',
    fromPhase: 'pr',
    toPhase: 'pr',
    trigger: 'poller',
    triggerLabel: 'PR detected by poller',
    description: 'GitHub poller detects a PR for the team branch. Phase advances to pr from any earlier phase.',
    hookEvent: null,
  },
];
