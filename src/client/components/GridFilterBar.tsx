import type { TeamStatus } from '../../shared/types';
import { STATUS_COLORS } from '../utils/constants';

// ---------------------------------------------------------------------------
// GridFilterBar — project dropdown + status toggle pills for the fleet grid
// ---------------------------------------------------------------------------

/** Human-readable status labels (same as StatusBadge) */
const STATUS_LABELS: Record<TeamStatus, string> = {
  queued: 'Queued',
  launching: 'Launching',
  running: 'Running',
  idle: 'Idle',
  stuck: 'Stuck',
  done: 'Done',
  failed: 'Failed',
};

/** All status values in display order */
const ALL_STATUSES: TeamStatus[] = [
  'queued',
  'launching',
  'running',
  'idle',
  'stuck',
  'done',
  'failed',
];

interface GridFilterBarProps {
  projectNames: string[];
  selectedProject: string | null;
  onProjectChange: (name: string | null) => void;
  selectedStatuses: Set<TeamStatus>;
  onStatusesChange: (statuses: Set<TeamStatus>) => void;
}

export function GridFilterBar({
  projectNames,
  selectedProject,
  onProjectChange,
  selectedStatuses,
  onStatusesChange,
}: GridFilterBarProps) {
  const allStatusesActive = selectedStatuses.size === 0;

  const handleStatusToggleAll = () => {
    onStatusesChange(new Set());
  };

  const handleStatusToggle = (status: TeamStatus) => {
    const next = new Set(selectedStatuses);

    // If currently showing "all", switch to only this status
    if (allStatusesActive) {
      onStatusesChange(new Set([status]));
      return;
    }

    if (next.has(status)) {
      next.delete(status);
      // If removing the last filter, revert to "All"
      if (next.size === 0) {
        onStatusesChange(new Set());
        return;
      }
    } else {
      next.add(status);
      // If all statuses are now selected, revert to "All"
      if (next.size === ALL_STATUSES.length) {
        onStatusesChange(new Set());
        return;
      }
    }
    onStatusesChange(next);
  };

  return (
    <div className="flex items-center gap-3 mb-3 px-4 flex-wrap" data-testid="grid-filter-bar">
      {/* Project dropdown */}
      <select
        value={selectedProject ?? ''}
        onChange={(e) => onProjectChange(e.target.value || null)}
        className="bg-dark-surface border border-dark-border text-dark-text text-xs rounded px-2 py-1 focus:outline-none focus:border-dark-accent"
        data-testid="project-filter"
      >
        <option value="">All projects</option>
        {projectNames.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>

      {/* Status pills */}
      <div className="flex items-center gap-1 flex-wrap">
        {/* All pill */}
        <button
          onClick={handleStatusToggleAll}
          className="px-2 py-0.5 text-[10px] font-medium rounded-full border transition-all duration-150"
          style={allStatusesActive ? {
            color: '#C9D1D9',
            borderColor: '#C9D1D9' + '60',
            backgroundColor: '#C9D1D9' + '18',
          } : {
            color: '#484F58',
            borderColor: '#484F58' + '40',
            opacity: 0.7,
          }}
        >
          All
        </button>

        {ALL_STATUSES.map((status) => {
          const color = STATUS_COLORS[status];
          const isActive = !allStatusesActive && selectedStatuses.has(status);
          return (
            <button
              key={status}
              onClick={() => handleStatusToggle(status)}
              className="px-2 py-0.5 text-[10px] font-medium rounded-full border transition-all duration-150 flex items-center gap-1"
              data-testid={`status-pill-${status}`}
              style={isActive ? {
                color,
                borderColor: color + '60',
                backgroundColor: color + '18',
              } : {
                color: '#484F58',
                borderColor: '#484F58' + '40',
                opacity: 0.5,
              }}
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: isActive ? color : '#484F58' }}
              />
              {STATUS_LABELS[status]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
