import type { TeamStatus } from '../../shared/types';

export const STATUS_COLORS: Record<TeamStatus, string> = {
  queued: '#8B949E',
  launching: '#D29922',
  running: '#3FB950',
  idle: '#D29922',
  stuck: '#F85149',
  done: '#A371F7',
  failed: '#F85149',
};

/** Get usage bar color based on a configurable red threshold.
 *  Yellow starts 10pp below the red threshold. */
export function getUsageColor(percent: number, redThreshold: number): string {
  const yellowStart = Math.max(0, redThreshold - 10);
  if (percent >= redThreshold) return '#F85149';
  if (percent >= yellowStart) return '#D29922';
  return '#3FB950';
}

// ---------------------------------------------------------------------------
// Agent colors — role-based with hash fallback for consistent coloring
// ---------------------------------------------------------------------------

/** Role-specific colors for agent nodes */
export const AGENT_ROLE_COLORS: Record<string, string> = {
  'team-lead': '#58A6FF',
  'coordinator': '#58A6FF',
  'tl': '#58A6FF',
  'analyst': '#D29922',
  'dev': '#3FB950',
  'developer': '#3FB950',
  'reviewer': '#A371F7',
};

/** Fallback palette for agents with unknown roles */
const AGENT_FALLBACK_PALETTE = [
  '#58A6FF', '#3FB950', '#D29922', '#A371F7', '#F778BA',
  '#79C0FF', '#7EE787', '#E3B341', '#D2A8FF', '#FF7B72',
];

/** Get a deterministic color for an agent. Prefers role-based color, falls back to name hash. */
export function agentColor(name: string, role?: string): string {
  if (role) {
    const roleColor = AGENT_ROLE_COLORS[role.toLowerCase()];
    if (roleColor) return roleColor;
  }
  // Also check name as role (agent names like "dev", "planner" are also role keys)
  const nameColor = AGENT_ROLE_COLORS[name.toLowerCase()];
  if (nameColor) return nameColor;
  // Hash-based fallback
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return AGENT_FALLBACK_PALETTE[Math.abs(hash) % AGENT_FALLBACK_PALETTE.length];
}
