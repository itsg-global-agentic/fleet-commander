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
