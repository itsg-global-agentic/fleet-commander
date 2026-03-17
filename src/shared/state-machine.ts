// =============================================================================
// Fleet Commander — State Machine Transitions (authoritative definition)
// =============================================================================
// Single source of truth for ALL team lifecycle transitions. Both the API
// routes and the github-poller reference this array. This file is PURELY
// about state transitions — message templates live in message-templates.ts.
// =============================================================================

export type TriggerType = 'hook' | 'timer' | 'poller' | 'pm_action' | 'system';

export interface StateMachineTransition {
  id: string;
  from: string;
  to: string;
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
  { id: 'done', label: 'Done', color: '#56D4DD' },
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
    id: 'launching-running',
    from: 'launching',
    to: 'running',
    trigger: 'hook',
    triggerLabel: 'First hook event received',
    description: 'Claude Code process starts and sends its first lifecycle hook',
    condition: 'Process PID is alive and first event arrives',
    hookEvent: 'session_start',
  },
  {
    id: 'running-idle',
    from: 'running',
    to: 'idle',
    trigger: 'timer',
    triggerLabel: 'Idle threshold exceeded',
    description: 'No hook events received within the idle threshold period',
    condition: 'lastEventAt + idleThresholdMin < now',
    hookEvent: null,
  },
  {
    id: 'idle-running',
    from: 'idle',
    to: 'running',
    trigger: 'hook',
    triggerLabel: 'Activity resumes',
    description: 'A new hook event is received from the idle team',
    condition: 'New hook event arrives',
    hookEvent: 'tool_use',
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
    trigger: 'pm_action',
    triggerLabel: 'PM restarts team',
    description:
      'PM sends a nudge or restarts the team to recover from stuck state',
    condition: 'Manual PM action via API or new hook event',
    hookEvent: null,
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
    description: 'PR has been merged on GitHub',
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
];
