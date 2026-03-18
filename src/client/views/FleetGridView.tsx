import { useMemo, useState } from 'react';
import { useFleet } from '../context/FleetContext';
import { FleetGrid } from '../components/FleetGrid';
import { TeamTimeline } from '../components/TeamTimeline';
import type { TeamDashboardRow, TeamStatus } from '../../shared/types';

type ViewMode = 'grid' | 'timeline';

// ---------------------------------------------------------------------------
// Status priority: lower number = higher priority (sorted first)
// stuck > running > idle > launching > failed > done
// ---------------------------------------------------------------------------

const STATUS_PRIORITY: Record<TeamStatus, number> = {
  stuck: 0,
  running: 1,
  idle: 2,
  launching: 3,
  queued: 4,
  failed: 5,
  done: 6,
};

/** Sort teams by status priority, then by launch date descending (newest first) within same status */
function sortTeams(teams: TeamDashboardRow[]): TeamDashboardRow[] {
  return [...teams].sort((a, b) => {
    const aPri = STATUS_PRIORITY[a.status] ?? 99;
    const bPri = STATUS_PRIORITY[b.status] ?? 99;
    if (aPri !== bPri) return aPri - bPri;
    // Within same status: sort by launch date descending (newest first)
    const aTime = a.launchedAt ? new Date(a.launchedAt).getTime() : 0;
    const bTime = b.launchedAt ? new Date(b.launchedAt).getTime() : 0;
    return bTime - aTime;
  });
}

export function FleetGridView() {
  const { teams, allTeams, selectedTeamId, setSelectedTeamId } = useFleet();
  const [viewMode, setViewMode] = useState<ViewMode>('grid');

  const sortedTeams = useMemo(() => sortTeams(teams), [teams]);

  // Empty state
  if (sortedTeams.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <svg className="w-12 h-12 text-dark-muted/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z" />
        </svg>
        <p className="text-dark-muted text-lg">No teams</p>
        <p className="text-dark-muted/60 text-sm">Launch a team to get started</p>
      </div>
    );
  }

  return (
    <div className="p-4">
      {/* Header with view toggle */}
      <div className="flex items-center justify-between mb-3 px-4">
        <div className="text-xs text-dark-muted">
          {allTeams.length} total teams ({sortedTeams.length} shown)
        </div>
        <div className="inline-flex rounded border border-dark-border text-xs overflow-hidden">
          <button
            onClick={() => setViewMode('grid')}
            className={`px-3 py-1 transition-colors ${
              viewMode === 'grid'
                ? 'bg-dark-accent/20 text-dark-accent'
                : 'text-dark-muted hover:text-dark-text'
            }`}
          >
            Grid
          </button>
          <button
            onClick={() => setViewMode('timeline')}
            className={`px-3 py-1 border-l border-dark-border transition-colors ${
              viewMode === 'timeline'
                ? 'bg-dark-accent/20 text-dark-accent'
                : 'text-dark-muted hover:text-dark-text'
            }`}
          >
            Timeline
          </button>
        </div>
      </div>

      {/* View content */}
      {viewMode === 'grid' ? (
        <FleetGrid
          teams={sortedTeams}
          selectedTeamId={selectedTeamId}
          onSelectTeam={setSelectedTeamId}
        />
      ) : (
        <TeamTimeline teams={sortedTeams} />
      )}
    </div>
  );
}
