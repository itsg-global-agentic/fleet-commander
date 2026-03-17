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
  const committedRef = useRef(false);

  // Prompt editor state
  const [editingPromptId, setEditingPromptId] = useState<number | null>(null);
  const [promptContent, setPromptContent] = useState('');
  const [promptLoading, setPromptLoading] = useState(false);
  const [promptSaving, setPromptSaving] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);

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
      committedRef.current = false; // reset AFTER save
      setEditingLimitId(null);
    },
    [api, editLimitValue, fetchProjects],
  );

  const handleCancelEditLimit = useCallback(() => {
    setEditingLimitId(null);
  }, []);

  // Load prompt content when editing
  useEffect(() => {
    if (editingPromptId === null) return;
    setPromptLoading(true);
    setPromptError(null);
    api.get<{ content: string }>(`projects/${editingPromptId}/prompt`)
      .then((data) => {
        setPromptContent(data.content);
      })
      .catch((err: unknown) => {
        setPromptError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setPromptLoading(false);
      });
  }, [editingPromptId, api]);

  const handleSavePrompt = useCallback(async () => {
    if (editingPromptId === null) return;
    setPromptSaving(true);
    setPromptError(null);
    try {
      await api.put(`projects/${editingPromptId}/prompt`, { content: promptContent });
      setEditingPromptId(null);
    } catch (err: unknown) {
      setPromptError(err instanceof Error ? err.message : String(err));
    } finally {
      setPromptSaving(false);
    }
  }, [editingPromptId, promptContent, api]);

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
                      {/* Install status indicators — 4 separate badges */}
                      {project.installStatus ? (() => {
                        const s = project.installStatus;

                        // Categories with file-list tooltips (hooks, prompt)
                        const detailedCategories: {
                          key: string;
                          label: string;
                          installed: boolean;
                          somePresent: boolean;
                          files: { name: string; exists: boolean }[];
                          summary: string;
                        }[] = [
                          {
                            key: 'hooks',
                            label: 'hooks',
                            installed: s.hooks?.installed ?? false,
                            somePresent: (s.hooks?.found ?? 0) > 0,
                            files: s.hooks?.files ?? [],
                            summary: `Hook Scripts (${s.hooks?.found ?? 0}/${s.hooks?.total ?? 0})`,
                          },
                          {
                            key: 'prompt',
                            label: 'prompt',
                            installed: s.prompt?.installed ?? false,
                            somePresent: s.prompt?.files?.some((f) => f.exists) ?? false,
                            files: s.prompt?.files ?? [],
                            summary: 'Prompt Files',
                          },
                        ];

                        // Simple boolean categories (settings, mcp)
                        const booleanCategories: {
                          key: string;
                          label: string;
                          exists: boolean;
                          tooltip: string;
                        }[] = [
                          {
                            key: 'settings',
                            label: 'settings',
                            exists: s.settings?.exists ?? false,
                            tooltip: s.settings?.exists ? 'settings.json found' : 'settings.json missing',
                          },
                          {
                            key: 'mcp',
                            label: 'mcp',
                            exists: s.mcpConfig?.exists ?? false,
                            tooltip: s.mcpConfig?.exists
                              ? '.mcp.json has fleet-commander entry'
                              : '.mcp.json missing fleet-commander entry',
                          },
                        ];

                        return (
                          <div className="flex items-center gap-2 text-xs">
                            {detailedCategories.map((cat) => {
                              const color = cat.installed
                                ? '#3FB950'
                                : cat.somePresent
                                  ? '#D29922'
                                  : '#F85149';
                              const icon = cat.installed
                                ? '\u2713'
                                : cat.somePresent
                                  ? '\u26A0'
                                  : '\u2717';

                              return (
                                <div key={cat.key} className="relative group shrink-0">
                                  <span
                                    className="cursor-default"
                                    style={{ color }}
                                  >
                                    {icon} {cat.label}
                                  </span>

                                  {/* Tooltip on hover */}
                                  <div className="hidden group-hover:block absolute z-10 bottom-full left-0 mb-1 p-2 rounded bg-[#1C2128] border border-[#30363D] shadow-lg text-xs min-w-48 max-h-64 overflow-auto">
                                    <div className="font-medium mb-1 text-[#C9D1D9]">
                                      {cat.summary}
                                    </div>
                                    {cat.files.map((f) => (
                                      <div
                                        key={f.name}
                                        className="flex items-center gap-1.5 py-0.5"
                                      >
                                        <span
                                          style={{
                                            color: f.exists ? '#3FB950' : '#F85149',
                                          }}
                                        >
                                          {f.exists ? '\u2713' : '\u2717'}
                                        </span>
                                        <span className="text-[#8B949E] font-mono">
                                          {f.name}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              );
                            })}
                            {booleanCategories.map((cat) => {
                              const color = cat.exists ? '#3FB950' : '#F85149';
                              const icon = cat.exists ? '\u2713' : '\u2717';

                              return (
                                <div key={cat.key} className="relative group shrink-0">
                                  <span
                                    className="cursor-default"
                                    style={{ color }}
                                  >
                                    {icon} {cat.label}
                                  </span>

                                  {/* Tooltip on hover */}
                                  <div className="hidden group-hover:block absolute z-10 bottom-full right-0 mb-1 p-2 rounded bg-[#1C2128] border border-[#30363D] shadow-lg text-xs whitespace-nowrap">
                                    <span className="text-[#C9D1D9]">{cat.tooltip}</span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })() : (
                        <span
                          className="text-xs cursor-default shrink-0"
                          style={{ color: '#8B949E' }}
                          title="Install status unknown"
                        >
                          ? status
                        </span>
                      )}
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
                              if (e.key === 'Enter') {
                                committedRef.current = true;
                                handleSaveLimit(project.id);
                              }
                              if (e.key === 'Escape') handleCancelEditLimit();
                            }}
                            onBlur={() => {
                              if (!committedRef.current) {
                                handleSaveLimit(project.id);
                              }
                            }}
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
                    {project.promptFile && (
                      <div className="flex items-center gap-2 text-xs text-dark-muted mt-1">
                        <span className="shrink-0">Prompt:</span>
                        <span className="truncate text-dark-text/70" title={project.promptFile}>
                          {project.promptFile}
                        </span>
                        <button
                          onClick={() => setEditingPromptId(project.id)}
                          className="shrink-0 text-dark-accent/70 hover:text-dark-accent transition-colors"
                          title="Edit launch prompt"
                        >
                          Edit
                        </button>
                      </div>
                    )}
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

      {/* Prompt editor modal */}
      {editingPromptId !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={(e) => {
            if (e.target === e.currentTarget) setEditingPromptId(null);
          }}
        >
          <div className="w-[600px] max-w-[95vw] max-h-[80vh] bg-dark-surface border border-dark-border rounded-lg shadow-2xl flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-dark-border shrink-0">
              <h2 className="text-base font-semibold text-dark-text">Edit Launch Prompt</h2>
              <button
                onClick={() => setEditingPromptId(null)}
                className="text-dark-muted hover:text-dark-text transition-colors p-1 rounded hover:bg-dark-border/30"
                title="Close"
              >
                <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </div>

            {/* Body */}
            <div className="px-5 py-4 flex-1 overflow-y-auto">
              {promptLoading ? (
                <p className="text-dark-muted text-sm">Loading prompt...</p>
              ) : (
                <>
                  <p className="text-xs text-dark-muted mb-2">
                    Use <code className="text-dark-accent/70">{'{{ISSUE_NUMBER}}'}</code> as a placeholder -- it will be replaced with the actual issue number at launch time.
                  </p>
                  <textarea
                    value={promptContent}
                    onChange={(e) => setPromptContent(e.target.value)}
                    className="w-full h-48 px-3 py-2 text-sm rounded border border-dark-border bg-dark-base text-dark-text placeholder:text-dark-muted/50 focus:outline-none focus:border-dark-accent focus:ring-1 focus:ring-dark-accent/30 font-mono resize-y"
                    disabled={promptSaving}
                  />
                  {promptError && (
                    <div className="mt-2 px-3 py-2 rounded border border-[#F85149]/30 bg-[#F85149]/10 text-[#F85149] text-sm">
                      {promptError}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-dark-border shrink-0">
              <button
                onClick={() => setEditingPromptId(null)}
                className="px-3 py-1.5 text-sm rounded border border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-muted transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSavePrompt}
                disabled={promptSaving || promptLoading}
                className="px-4 py-1.5 text-sm font-medium rounded border border-dark-accent/40 text-dark-accent bg-dark-accent/10 hover:bg-dark-accent/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {promptSaving ? 'Saving...' : 'Save Prompt'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
