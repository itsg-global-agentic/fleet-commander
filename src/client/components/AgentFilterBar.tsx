import { useMemo } from 'react';
import type { TeamMember } from '../../shared/types';
import { agentColor } from '../utils/constants';

// ---------------------------------------------------------------------------
// AgentFilterBar — dynamic per-agent filter pills for the session log
// ---------------------------------------------------------------------------
// Renders a row of toggle pills, one per known agent plus "All".
// Hidden when there is only one agent (TL-only teams).
// ---------------------------------------------------------------------------

interface AgentFilterBarProps {
  /** Roster of team members (fetched from /api/teams/:id/roster) */
  roster: TeamMember[];
  /** Currently active agent name filters */
  activeFilters: Set<string>;
  /** Callback to update the active filters */
  onFiltersChange: (filters: Set<string>) => void;
}

/** Canonical display name for an agent (capitalise first letter) */
function displayName(name: string): string {
  if (name === 'team-lead' || name === 'tl') return 'TL';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function AgentFilterBar({ roster, activeFilters, onFiltersChange }: AgentFilterBarProps) {
  // Build ordered list of agent names: team-lead first, then alphabetical
  const agentNames = useMemo(() => {
    const names = new Set<string>();
    names.add('team-lead');
    for (const member of roster) {
      names.add(member.name.toLowerCase());
    }
    const sorted = Array.from(names).sort((a, b) => {
      if (a === 'team-lead') return -1;
      if (b === 'team-lead') return 1;
      return a.localeCompare(b);
    });
    return sorted;
  }, [roster]);

  // Hide when only TL exists (no subagents)
  if (agentNames.length <= 1) return null;

  const allActive = activeFilters.size === 0 || activeFilters.size === agentNames.length;

  const handleToggleAll = () => {
    // "All" means clear all filters (show everything)
    onFiltersChange(new Set());
  };

  const handleToggle = (name: string) => {
    const next = new Set(activeFilters);

    // If currently showing "all", switch to only this one agent
    if (allActive) {
      onFiltersChange(new Set([name]));
      return;
    }

    if (next.has(name)) {
      next.delete(name);
      // If removing the last filter, revert to "All"
      if (next.size === 0) {
        onFiltersChange(new Set());
        return;
      }
    } else {
      next.add(name);
      // If all agents are now selected, revert to "All"
      if (next.size === agentNames.length) {
        onFiltersChange(new Set());
        return;
      }
    }
    onFiltersChange(next);
  };

  return (
    <div className="flex items-center gap-1 mb-2 flex-wrap">
      {/* All pill */}
      <button
        onClick={handleToggleAll}
        className="px-2 py-0.5 text-[10px] font-medium rounded-full border transition-all duration-150"
        style={allActive ? {
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

      {agentNames.map((name) => {
        const color = agentColor(name, name);
        const isActive = allActive || activeFilters.has(name);
        return (
          <button
            key={name}
            onClick={() => handleToggle(name)}
            className="px-2 py-0.5 text-[10px] font-medium rounded-full border transition-all duration-150 flex items-center gap-1"
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
            {displayName(name)}
          </button>
        );
      })}
    </div>
  );
}
