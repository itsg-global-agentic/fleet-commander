// =============================================================================
// Fleet Commander — Execution Plan View
// =============================================================================
// Displays dependency-resolved execution waves for a project. Issues are
// grouped into waves based on their dependency DAG and maxActiveTeams limits.
// Live-updates via SSE when teams complete, launch, or dependencies resolve.
// =============================================================================

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useApi } from '../hooks/useApi';
import { useFleetSSE } from '../hooks/useFleetSSE';
import { AlertTriangleIcon, RefreshCwIcon } from '../components/Icons';
import type { ExecutionPlan, Wave, WaveIssue } from '../../shared/wave-computation';
import type { ProjectSummary } from '../../shared/types';

// ---------------------------------------------------------------------------
// Status badge colors (matches FleetGrid conventions)
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  queued: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  launching: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  running: 'bg-green-500/20 text-green-400 border-green-500/30',
  idle: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  stuck: 'bg-red-500/20 text-red-400 border-red-500/30',
  done: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  failed: 'bg-red-500/20 text-red-400 border-red-500/30',
};

// ---------------------------------------------------------------------------
// Issue Card component
// ---------------------------------------------------------------------------

function IssueCard({ issue }: { issue: WaveIssue }) {
  const statusClass = issue.teamStatus
    ? STATUS_COLORS[issue.teamStatus] ?? 'bg-dark-border/30 text-dark-muted border-dark-border'
    : 'bg-dark-border/30 text-dark-muted border-dark-border';

  return (
    <a
      href={issue.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`
        flex flex-col gap-1 px-3 py-2 rounded-md border text-xs
        transition-colors hover:brightness-110
        ${statusClass}
        ${issue.isCircularDep ? 'ring-1 ring-yellow-500/50' : ''}
      `}
      title={`#${issue.issueNumber}: ${issue.title}${issue.teamStatus ? ` (${issue.teamStatus})` : ''}${issue.isCircularDep ? ' [circular dep]' : ''}`}
    >
      <div className="flex items-center gap-1.5">
        <span className="font-mono font-medium">#{issue.issueNumber}</span>
        {issue.teamStatus && (
          <span className="text-[10px] uppercase opacity-75">{issue.teamStatus}</span>
        )}
        {issue.isCircularDep && (
          <AlertTriangleIcon size={12} className="text-yellow-400 flex-shrink-0" />
        )}
      </div>
      <span className="truncate opacity-80 max-w-[200px]">{issue.title}</span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Wave Row component
// ---------------------------------------------------------------------------

function WaveRow({ wave }: { wave: Wave }) {
  const labelClass = wave.isActive
    ? 'bg-green-500/20 text-green-400 border-green-500/30'
    : wave.label === 'Blocked'
      ? 'bg-red-500/20 text-red-400 border-red-500/30'
      : wave.label === 'Next'
        ? 'bg-blue-500/20 text-blue-400 border-blue-500/30'
        : 'bg-dark-border/40 text-dark-muted border-dark-border';

  return (
    <div className="flex gap-3 items-start">
      {/* Wave label pill */}
      <div
        className={`
          flex-shrink-0 w-20 text-center text-xs font-medium px-2 py-1
          rounded border ${labelClass}
        `}
      >
        {wave.label}
        <div className="text-[10px] opacity-60 mt-0.5">
          {wave.issues.length} issue{wave.issues.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Issue cards */}
      <div className="flex flex-wrap gap-2 flex-1 min-w-0">
        {wave.issues.map((issue) => (
          <IssueCard key={issue.issueNumber} issue={issue} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Project selector (inline, simple)
// ---------------------------------------------------------------------------

function ProjectSelect({
  projects,
  selectedId,
  onSelect,
}: {
  projects: ProjectSummary[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  return (
    <select
      value={selectedId ?? ''}
      onChange={(e) => onSelect(Number(e.target.value))}
      className="bg-dark-surface border border-dark-border rounded px-2 py-1 text-sm text-dark-text focus:outline-none focus:border-dark-accent"
    >
      <option value="" disabled>Select project...</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function ExecutionPlanView() {
  const api = useApi();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [plan, setPlan] = useState<ExecutionPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const autoSelected = useRef(false);

  // Fetch project list
  useEffect(() => {
    api.get<ProjectSummary[]>('projects').then((data) => {
      const active = data.filter((p) => p.status === 'active');
      setProjects(active);
      // Auto-select if only one project (once)
      if (active.length === 1 && !autoSelected.current) {
        autoSelected.current = true;
        setSelectedProjectId(active[0].id);
      }
    }).catch(() => {
      // Non-fatal
    });
  }, [api]);

  // Fetch execution plan when project changes
  const fetchPlan = useCallback(async () => {
    if (selectedProjectId === null) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<ExecutionPlan>(
        `projects/${selectedProjectId}/execution-plan`,
      );
      setPlan(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [api, selectedProjectId]);

  useEffect(() => {
    fetchPlan();
  }, [fetchPlan]);

  // SSE: auto-refresh on relevant events
  const handleSSE = useCallback(
    (_type: string, _data: unknown) => {
      fetchPlan();
    },
    [fetchPlan],
  );

  useFleetSSE(
    ['team_status_changed', 'team_launched', 'team_stopped', 'dependency_resolved'],
    handleSSE,
  );

  // Derived stats
  const stats = useMemo(() => {
    if (!plan) return null;
    const totalIssues = plan.waves.reduce((sum, w) => sum + w.issues.length, 0);
    const activeWave = plan.waves.find((w) => w.isActive);
    const activeCount = activeWave?.issues.length ?? 0;
    return { totalIssues, activeCount };
  }, [plan]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="p-4 max-w-5xl">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-lg font-semibold text-dark-text">Execution Plan</h1>
        <ProjectSelect
          projects={projects}
          selectedId={selectedProjectId}
          onSelect={setSelectedProjectId}
        />
        <button
          onClick={fetchPlan}
          disabled={loading || selectedProjectId === null}
          className="p-1.5 rounded text-dark-muted hover:text-dark-text hover:bg-dark-border/50 transition-colors disabled:opacity-40"
          title="Refresh plan"
        >
          <RefreshCwIcon size={14} className={loading ? 'animate-spin' : ''} />
        </button>

        {stats && (
          <div className="ml-auto text-xs text-dark-muted flex gap-4">
            <span>{stats.totalIssues} issue{stats.totalIssues !== 1 ? 's' : ''}</span>
            <span>{stats.activeCount} active</span>
            <span>max {plan?.maxActiveTeams} concurrent</span>
          </div>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-4 px-3 py-2 rounded bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Circular dependency warning */}
      {plan && plan.circularDeps.length > 0 && (
        <div className="mb-4 px-3 py-2 rounded bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 text-sm flex items-start gap-2">
          <AlertTriangleIcon size={14} className="flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-medium">Circular dependencies detected</div>
            <div className="text-xs opacity-80 mt-1">
              {plan.circularDeps.map((cycle, i) => (
                <span key={i}>
                  {cycle.map((n) => `#${n}`).join(' \u2192 ')}
                  {i < plan.circularDeps.length - 1 ? ' | ' : ''}
                </span>
              ))}
              <span className="block mt-1">
                These issues are treated as unblocked to avoid deadlocking the queue.
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Loading state */}
      {loading && !plan && (
        <div className="flex items-center justify-center h-48 text-dark-muted text-sm">
          Loading execution plan...
        </div>
      )}

      {/* No project selected */}
      {!loading && selectedProjectId === null && (
        <div className="flex flex-col items-center justify-center h-48 gap-2 text-dark-muted">
          <p className="text-sm">Select a project to view its execution plan.</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && plan && plan.waves.length === 0 && (
        <div className="flex flex-col items-center justify-center h-48 gap-2 text-dark-muted">
          <p className="text-sm">No queued or active issues for this project.</p>
          <p className="text-xs opacity-60">
            Queue some issues from the Issue Tree to see the execution plan.
          </p>
        </div>
      )}

      {/* Wave rows */}
      {plan && plan.waves.length > 0 && (
        <div className="flex flex-col gap-4">
          {plan.waves.map((wave) => (
            <WaveRow key={wave.waveIndex} wave={wave} />
          ))}
        </div>
      )}

      {/* Legend */}
      {plan && plan.waves.length > 0 && (
        <div className="mt-6 pt-4 border-t border-dark-border text-xs text-dark-muted flex flex-wrap gap-x-6 gap-y-1">
          <span><span className="inline-block w-2 h-2 rounded-full bg-green-400 mr-1" />Active</span>
          <span><span className="inline-block w-2 h-2 rounded-full bg-blue-400 mr-1" />Queued</span>
          <span><span className="inline-block w-2 h-2 rounded-full bg-yellow-400 mr-1" />Idle / Launching</span>
          <span><span className="inline-block w-2 h-2 rounded-full bg-red-400 mr-1" />Stuck / Failed / Blocked</span>
          <span><span className="inline-block w-2 h-2 rounded-full bg-purple-400 mr-1" />Done</span>
        </div>
      )}
    </div>
  );
}
