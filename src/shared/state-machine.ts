// =============================================================================
// Fleet Commander — State Machine Transitions (authoritative definition)
// =============================================================================
// Single source of truth for ALL team lifecycle transitions. Both the API
// routes and the github-poller reference this array. This file is PURELY
// about state transitions — message templates live in message-templates.ts.
// =============================================================================

import type { TeamStatus } from './types.js';

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
    id: 'queued-launching',
    from: 'queued',
    to: 'launching',
    trigger: 'system',
    triggerLabel: 'Queue processor',
    description: 'Team slot becomes available; next queued team is launched',
    condition: 'Active teams < maxActiveTeams for project',
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
    description: 'Claude Code session completes normally with exit code 0',
    condition: 'Process exits with code 0 or session_end event',
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
];
