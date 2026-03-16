import { useState, useEffect, useCallback, useRef } from 'react';
import { useApi } from '../hooks/useApi';
import { AddProjectDialog } from '../components/AddProjectDialog';
import { CleanupModal } from '../components/CleanupModal';
import type { ProjectSummary, ProjectStatus } from '../../shared/types';

// ---------------------------------------------------------------------------
// Status badge colors
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<ProjectStatus, { bg: string; text: string; border: string }> = {
  active: { bg: '#3FB95020', text: '#3FB950', border: '#3FB95040' },
  paused: { bg: '#D2992220', text: '#D29922', border: '#D2992240' },
  archived: { bg: '#8B949E20', text: '#8B949E', border: '#8B949E40' },
};

// ---------------------------------------------------------------------------
// ProjectsPage
// ---------------------------------------------------------------------------

export function ProjectsPage() {
  const api = useApi();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);

  // Cleanup modal state
  const [cleanupProjectId, setCleanupProjectId] = useState<number | null>(null);

  // Inline edit state for maxActiveTeams
  const [editingLimitId, setEditingLimitId] = useState<number | null>(null);
  const [editLimitValue, setEditLimitValue] = useState<number>(5);
  const limitInputRef = useRef<HTMLInputElement>(null);

  const fetchProjects = useCallback(async () => {
    try {
      const data = await api.get<ProjectSummary[]>('projects');
      setProjects(data);
    } catch {
      // Silently fail — user will see empty state
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  // --- Actions ---

  const handleToggleStatus = useCallback(
    async (project: ProjectSummary) => {
      const newStatus: ProjectStatus = project.status === 'active' ? 'paused' : 'active';
      try {
        await api.put(`projects/${project.id}`, { status: newStatus });
        await fetchProjects();
      } catch {
        // ignore
      }
    },
    [api, fetchProjects],
  );

  const handleDelete = useCallback(
    async (project: ProjectSummary) => {
      const confirmed = window.confirm(
        `Delete project "${project.name}"? This will stop all active teams and remove the project.`,
      );
      if (!confirmed) return;

      try {
        await api.del(`projects/${project.id}`);
        await fetchProjects();
      } catch {
        // ignore
      }
    },
    [api, fetchProjects],
  );

  const handleAdded = useCallback(() => {
    setAddOpen(false);
    fetchProjects();
  }, [fetchProjects]);

  const handleCleanup = useCallback((project: ProjectSummary) => {
    setCleanupProjectId(project.id);
  }, []);

  const handleCleanupClose = useCallback(() => {
    setCleanupProjectId(null);
  }, []);

  const handleCleanupDone = useCallback(() => {
    fetchProjects();
  }, [fetchProjects]);

  const handleEditLimit = useCallback((project: ProjectSummary) => {
    setEditingLimitId(project.id);
    setEditLimitValue(project.maxActiveTeams);
    setTimeout(() => limitInputRef.current?.focus(), 50);
  }, []);

  const handleSaveLimit = useCallback(
    async (projectId: number) => {
      const clamped = Math.max(1, Math.min(50, editLimitValue));
      try {
        await api.put(`projects/${projectId}`, { maxActiveTeams: clamped });
        await fetchProjects();
      } catch {
        // ignore
      }
      setEditingLimitId(null);
    },
    [api, editLimitValue, fetchProjects],
  );

  const handleCancelEditLimit = useCallback(() => {
    setEditingLimitId(null);
  }, []);

  // --- Render ---

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-dark-muted text-sm">Loading projects...</p>
      </div>
    );
  }

  return (
    <>
      <div className="p-6 max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold text-dark-text">Projects</h1>
          <button
            onClick={() => setAddOpen(true)}
            className="px-4 py-1.5 text-sm font-medium rounded border border-dark-accent/40 text-dark-accent bg-dark-accent/10 hover:bg-dark-accent/20 transition-colors"
          >
            Add Project
          </button>
        </div>

        {/* Empty state */}
        {projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <svg
              className="w-12 h-12 text-dark-muted/40"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z"
              />
            </svg>
            <p className="text-dark-muted text-lg">No projects yet</p>
            <p className="text-dark-muted/60 text-sm">
              Add your first project to get started.
            </p>
          </div>
        ) : (
          /* Project cards */
          <div className="space-y-3">
            {projects.map((project) => {
              const statusStyle = STATUS_STYLES[project.status] || STATUS_STYLES.active;
              return (
                <div
                  key={project.id}
                  className="bg-dark-surface border border-dark-border rounded-lg p-4 flex items-center justify-between gap-4"
                >
                  {/* Left: info */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-3 mb-1">
                      <span className="text-base font-semibold text-dark-text truncate">
                        {project.name}
                      </span>
                      {/* Status badge */}
                      <span
                        className="px-2 py-0.5 rounded-full text-xs font-medium shrink-0"
                        style={{
                          backgroundColor: statusStyle.bg,
                          color: statusStyle.text,
                          border: `1px solid ${statusStyle.border}`,
                        }}
                      >
                        {project.status}
                      </span>
                      {/* Install status indicators */}
                      {(() => {
                        const s = project.installStatus;
                        const items = s
                          ? [
                              { ok: s.hooks, label: 'hooks' },
                              { ok: s.prompt, label: 'prompt' },
                              { ok: s.command, label: 'command' },
                            ]
                          : [{ ok: project.hooksInstalled, label: 'hooks' }];
                        return items.map((item) => (
                          <span
                            key={item.label}
                            className="text-xs shrink-0"
                            style={{ color: item.ok ? '#3FB950' : '#F85149' }}
                            title={item.ok ? `${item.label} installed` : `${item.label} not installed`}
                          >
                            {item.ok ? '\u2713' : '\u2717'} {item.label}
                          </span>
                        ));
                      })()}
                    </div>
                    <div className="flex items-center gap-4 text-xs text-dark-muted">
                      <span className="truncate" title={project.repoPath}>
                        {project.repoPath}
                      </span>
                      {project.githubRepo && (
                        <span className="shrink-0">{project.githubRepo}</span>
                      )}
                      {editingLimitId === project.id ? (
                        <span className="shrink-0 inline-flex items-center gap-1">
                          <span>{project.activeTeamCount}/</span>
                          <input
                            ref={limitInputRef}
                            type="number"
                            value={editLimitValue}
                            onChange={(e) => setEditLimitValue(parseInt(e.target.value, 10) || 1)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveLimit(project.id);
                              if (e.key === 'Escape') handleCancelEditLimit();
                            }}
                            onBlur={() => handleSaveLimit(project.id)}
                            min={1}
                            max={50}
                            className="w-12 px-1 py-0 text-xs rounded border border-dark-accent bg-dark-base text-dark-text focus:outline-none"
                          />
                          <span>active teams</span>
                        </span>
                      ) : (
                        <span
                          className="shrink-0 cursor-pointer hover:text-dark-text transition-colors"
                          onClick={() => handleEditLimit(project)}
                          title="Click to edit max active teams limit"
                        >
                          {project.activeTeamCount}/{project.maxActiveTeams} active teams
                        </span>
                      )}
                      {(project.queuedTeamCount ?? 0) > 0 && (
                        <span
                          className="shrink-0 px-1.5 py-0 rounded-full text-xs font-medium"
                          style={{
                            backgroundColor: '#D2992220',
                            color: '#D29922',
                            border: '1px solid #D2992240',
                          }}
                        >
                          {project.queuedTeamCount} queued
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Right: actions */}
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => handleCleanup(project)}
                      className="px-3 py-1 text-xs rounded border border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-muted transition-colors"
                      title="Clean up orphan worktrees, signal files, and stale branches"
                    >
                      Clean Up
                    </button>
                    <button
                      onClick={() => handleToggleStatus(project)}
                      className="px-3 py-1 text-xs rounded border border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-muted transition-colors"
                    >
                      {project.status === 'active' ? 'Pause' : 'Resume'}
                    </button>
                    <button
                      onClick={() => handleDelete(project)}
                      className="px-3 py-1 text-xs rounded border border-[#F85149]/30 text-[#F85149] hover:bg-[#F85149]/10 transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <AddProjectDialog open={addOpen} onClose={() => setAddOpen(false)} onAdded={handleAdded} />

      {/* Cleanup modal (preview + confirm) */}
      {cleanupProjectId !== null && (
        <CleanupModal
          projectId={cleanupProjectId}
          open={true}
          onClose={handleCleanupClose}
          onDone={handleCleanupDone}
        />
      )}
    </>
  );
}
