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
