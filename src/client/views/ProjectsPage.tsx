import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useApi } from '../hooks/useApi';
import { AddProjectDialog } from '../components/AddProjectDialog';
import { CleanupModal } from '../components/CleanupModal';
import type { ProjectSummary, ProjectStatus, ProjectGroup } from '../../shared/types';

// ---------------------------------------------------------------------------
// Status badge colors
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<ProjectStatus, { bg: string; text: string; border: string }> = {
  active: { bg: '#3FB95020', text: '#3FB950', border: '#3FB95040' },
  archived: { bg: '#8B949E20', text: '#8B949E', border: '#8B949E40' },
};

// ---------------------------------------------------------------------------
// Group with project count from API
// ---------------------------------------------------------------------------

interface ProjectGroupWithCount extends ProjectGroup {
  projectCount: number;
}

// ---------------------------------------------------------------------------
// ProjectCard — renders a single project row
// ---------------------------------------------------------------------------

function ProjectCard({
  project,
  groups,
  editingLimitId,
  editLimitValue,
  limitInputRef,
  committedRef,
  setEditingLimitId,
  setEditLimitValue,
  handleSaveLimit,
  handleCancelEditLimit,
  editingModelId,
  editModelValue,
  modelInputRef,
  modelCommittedRef,
  setEditingModelId,
  setEditModelValue,
  handleSaveModel,
  handleCancelEditModel,
  handleEditLimit,
  handleEditModel,
  reinstalling,
  reinstallResult,
  handleReinstall,
  handleCleanup,
  handleDelete,
  setEditingPromptId,
  onGroupChange,
}: {
  project: ProjectSummary;
  groups: ProjectGroupWithCount[];
  editingLimitId: number | null;
  editLimitValue: number;
  limitInputRef: React.RefObject<HTMLInputElement | null>;
  committedRef: React.RefObject<boolean>;
  setEditingLimitId: (id: number | null) => void;
  setEditLimitValue: (v: number) => void;
  handleSaveLimit: (id: number) => void;
  handleCancelEditLimit: () => void;
  editingModelId: number | null;
  editModelValue: string;
  modelInputRef: React.RefObject<HTMLInputElement | null>;
  modelCommittedRef: React.RefObject<boolean>;
  setEditingModelId: (id: number | null) => void;
  setEditModelValue: (v: string) => void;
  handleSaveModel: (id: number) => void;
  handleCancelEditModel: () => void;
  handleEditLimit: (p: ProjectSummary) => void;
  handleEditModel: (p: ProjectSummary) => void;
  reinstalling: number | null;
  reinstallResult: { id: number; ok: boolean; error?: string } | null;
  handleReinstall: (p: ProjectSummary) => void;
  handleCleanup: (p: ProjectSummary) => void;
  handleDelete: (p: ProjectSummary) => void;
  setEditingPromptId: (id: number | null) => void;
  onGroupChange: (projectId: number, groupId: number | null) => void;
}) {
  const statusStyle = STATUS_STYLES[project.status] || STATUS_STYLES.active;
  return (
    <div
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

            const detailedCategories: {
              key: string;
              label: string;
              installed: boolean;
              hasCrlf: boolean;
              somePresent: boolean;
              files: { name: string; exists: boolean; hasCrlf?: boolean }[];
              summary: string;
            }[] = [
              {
                key: 'hooks',
                label: 'hooks',
                installed: s.hooks?.installed ?? false,
                hasCrlf: s.hooks?.files?.some((f: { hasCrlf?: boolean }) => f.hasCrlf) ?? false,
                somePresent: (s.hooks?.found ?? 0) > 0,
                files: s.hooks?.files ?? [],
                summary: `Hook Scripts (${s.hooks?.found ?? 0}/${s.hooks?.total ?? 0})`,
              },
              {
                key: 'prompt',
                label: 'prompt',
                installed: s.prompt?.installed ?? false,
                hasCrlf: false,
                somePresent: s.prompt?.files?.some((f) => f.exists) ?? false,
                files: s.prompt?.files ?? [],
                summary: 'Prompt Files',
              },
              {
                key: 'agents',
                label: 'agents',
                installed: s.agents?.installed ?? false,
                hasCrlf: false,
                somePresent: s.agents?.files?.some((f) => f.exists) ?? false,
                files: s.agents?.files ?? [],
                summary: 'Agent Templates',
              },
            ];

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
            ];

            return (
              <div className="flex items-center gap-2 text-xs">
                {detailedCategories.map((cat) => {
                  const color = cat.installed && !cat.hasCrlf
                    ? '#3FB950'
                    : cat.hasCrlf
                      ? '#D29922'
                      : cat.somePresent
                        ? '#D29922'
                        : '#F85149';
                  const icon = cat.installed && !cat.hasCrlf
                    ? '\u2713'
                    : cat.hasCrlf
                      ? '\u26A0'
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
                        {cat.files.map((f) => {
                          const fileColor = f.exists
                            ? f.hasCrlf ? '#D29922' : '#3FB950'
                            : '#F85149';
                          const fileIcon = f.exists
                            ? f.hasCrlf ? '\u26A0' : '\u2713'
                            : '\u2717';
                          return (
                            <div
                              key={f.name}
                              className="flex items-center gap-1.5 py-0.5"
                            >
                              <span style={{ color: fileColor }}>
                                {fileIcon}
                              </span>
                              <span className="text-[#8B949E] font-mono">
                                {f.name}{f.hasCrlf ? ' (CRLF)' : ''}
                              </span>
                            </div>
                          );
                        })}
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
          {editingModelId === project.id ? (
            <span className="shrink-0 inline-flex items-center gap-1">
              <span>Model:</span>
              <input
                ref={modelInputRef}
                type="text"
                value={editModelValue}
                onChange={(e) => setEditModelValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    modelCommittedRef.current = true;
                    handleSaveModel(project.id);
                  }
                  if (e.key === 'Escape') handleCancelEditModel();
                }}
                onBlur={() => {
                  if (!modelCommittedRef.current) {
                    handleSaveModel(project.id);
                  }
                }}
                placeholder="default"
                className="w-32 px-1 py-0 text-xs rounded border border-dark-accent bg-dark-base text-dark-text focus:outline-none"
              />
            </span>
          ) : (
            <span
              className="shrink-0 cursor-pointer hover:text-dark-text transition-colors"
              onClick={() => handleEditModel(project)}
              title="Click to edit model"
            >
              Model: {project.model || 'default'}
            </span>
          )}
          {/* Group selector */}
          <select
            value={project.groupId ?? ''}
            onChange={(e) => {
              const val = e.target.value;
              onGroupChange(project.id, val === '' ? null : parseInt(val, 10));
            }}
            className="shrink-0 px-1 py-0 text-xs rounded border border-dark-border bg-dark-base text-dark-muted hover:text-dark-text focus:outline-none cursor-pointer"
            title="Assign to group"
          >
            <option value="">No group</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
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

      {/* Reinstall result banner */}
      {reinstallResult?.id === project.id && (
        <div
          className={`mt-1 px-3 py-1.5 rounded text-xs ${
            reinstallResult.ok
              ? 'border border-[#3FB950]/30 bg-[#3FB950]/10 text-[#3FB950]'
              : 'border border-[#F85149]/30 bg-[#F85149]/10 text-[#F85149]'
          }`}
        >
          {reinstallResult.ok
            ? 'Installation completed successfully'
            : `Installation failed: ${reinstallResult.error}`}
        </div>
      )}

      {/* Right: actions */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Reinstall button — always visible */}
        <button
          onClick={() => handleReinstall(project)}
          disabled={reinstalling === project.id}
          className="px-3 py-1 text-xs rounded border border-dark-accent/40 text-dark-accent bg-dark-accent/10 hover:bg-dark-accent/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title="(Re)install hooks, settings, and workflow prompt"
        >
          {reinstalling === project.id ? 'Installing...' : 'Reinstall'}
        </button>
        <button
          onClick={() => handleCleanup(project)}
          className="px-3 py-1 text-xs rounded border border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-muted transition-colors"
          title="Clean up orphan worktrees, signal files, and stale branches"
        >
          Clean Up
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
}

// ---------------------------------------------------------------------------
// GroupSection — collapsible section with a group header
// ---------------------------------------------------------------------------

function GroupSection({
  title,
  description,
  projectCount,
  defaultExpanded,
  onEdit,
  onDelete,
  children,
}: {
  title: string;
  description?: string | null;
  projectCount: number;
  defaultExpanded?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? true);

  return (
    <div className="mb-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full text-left py-2 group"
      >
        <svg
          className={`w-3.5 h-3.5 text-dark-muted transition-transform ${expanded ? 'rotate-90' : ''}`}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
            clipRule="evenodd"
          />
        </svg>
        <span className="text-sm font-semibold text-dark-text">{title}</span>
        <span className="text-xs text-dark-muted">({projectCount})</span>
        {description && (
          <span className="text-xs text-dark-muted/60 truncate ml-2">{description}</span>
        )}
        {/* Edit/Delete buttons for named groups */}
        {onEdit && (
          <span
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className="ml-auto text-xs text-dark-muted hover:text-dark-text transition-colors opacity-0 group-hover:opacity-100 px-1"
            title="Edit group"
          >
            Edit
          </span>
        )}
        {onDelete && (
          <span
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="text-xs text-[#F85149]/70 hover:text-[#F85149] transition-colors opacity-0 group-hover:opacity-100 px-1"
            title="Delete group"
          >
            Delete
          </span>
        )}
      </button>
      {expanded && (
        <div className="space-y-3 ml-5">
          {children}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GroupDialog — create/edit group modal
// ---------------------------------------------------------------------------

function GroupDialog({
  open,
  group,
  onClose,
  onSave,
}: {
  open: boolean;
  group?: ProjectGroupWithCount | null;
  onClose: () => void;
  onSave: (name: string, description: string | null) => void;
}) {
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName(group?.name ?? '');
      setDescription(group?.description ?? '');
      setError(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, group]);

  if (!open) return null;

  const handleSubmit = () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    onSave(name.trim(), description.trim() || null);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[400px] max-w-[95vw] bg-dark-surface border border-dark-border rounded-lg shadow-2xl" role="dialog" aria-modal="true">
        <div className="flex items-center justify-between px-5 py-4 border-b border-dark-border">
          <h2 className="text-base font-semibold text-dark-text">
            {group ? 'Edit Group' : 'New Group'}
          </h2>
          <button
            onClick={onClose}
            className="text-dark-muted hover:text-dark-text transition-colors p-1 rounded hover:bg-dark-border/30"
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
        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="block text-xs text-dark-muted mb-1">Name</label>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') onClose(); }}
              className="w-full px-3 py-1.5 text-sm rounded border border-dark-border bg-dark-base text-dark-text focus:outline-none focus:border-dark-accent"
              placeholder="e.g. Backend Services"
            />
          </div>
          <div>
            <label className="block text-xs text-dark-muted mb-1">Description (optional)</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') onClose(); }}
              className="w-full px-3 py-1.5 text-sm rounded border border-dark-border bg-dark-base text-dark-text focus:outline-none focus:border-dark-accent"
              placeholder="Short description of this group"
            />
          </div>
          {error && (
            <div className="text-xs text-[#F85149]">{error}</div>
          )}
        </div>
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-dark-border">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded border border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-muted transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            className="px-4 py-1.5 text-sm font-medium rounded border border-dark-accent/40 text-dark-accent bg-dark-accent/10 hover:bg-dark-accent/20 transition-colors"
          >
            {group ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProjectsPage
// ---------------------------------------------------------------------------

export function ProjectsPage() {
  const api = useApi();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [groups, setGroups] = useState<ProjectGroupWithCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);

  // Group dialog state
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<ProjectGroupWithCount | null>(null);

  // Cleanup modal state
  const [cleanupProjectId, setCleanupProjectId] = useState<number | null>(null);

  // Inline edit state for maxActiveTeams
  const [editingLimitId, setEditingLimitId] = useState<number | null>(null);
  const [editLimitValue, setEditLimitValue] = useState<number>(5);
  const limitInputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  // Inline edit state for model
  const [editingModelId, setEditingModelId] = useState<number | null>(null);
  const [editModelValue, setEditModelValue] = useState('');
  const modelInputRef = useRef<HTMLInputElement>(null);
  const modelCommittedRef = useRef(false);

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

  const fetchGroups = useCallback(async () => {
    try {
      const data = await api.get<ProjectGroupWithCount[]>('project-groups');
      setGroups(data);
    } catch {
      // Silently fail
    }
  }, [api]);

  useEffect(() => {
    fetchProjects();
    fetchGroups();
  }, [fetchProjects, fetchGroups]);

  // --- Group Actions ---

  const handleCreateGroup = useCallback(() => {
    setEditingGroup(null);
    setGroupDialogOpen(true);
  }, []);

  const handleEditGroup = useCallback((group: ProjectGroupWithCount) => {
    setEditingGroup(group);
    setGroupDialogOpen(true);
  }, []);

  const handleDeleteGroup = useCallback(
    async (group: ProjectGroupWithCount) => {
      const confirmed = window.confirm(
        `Delete group "${group.name}"? Projects in this group will become ungrouped.`,
      );
      if (!confirmed) return;
      try {
        await api.del(`project-groups/${group.id}`);
        await fetchGroups();
        await fetchProjects();
      } catch (err) {
        window.alert(`Failed to delete group: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [api, fetchGroups, fetchProjects],
  );

  const handleSaveGroup = useCallback(
    async (name: string, description: string | null) => {
      try {
        if (editingGroup) {
          await api.put(`project-groups/${editingGroup.id}`, { name, description });
        } else {
          await api.post('project-groups', { name, description });
        }
        setGroupDialogOpen(false);
        await fetchGroups();
      } catch (err) {
        window.alert(`Failed to save group: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [api, editingGroup, fetchGroups],
  );

  const handleGroupChange = useCallback(
    async (projectId: number, groupId: number | null) => {
      try {
        await api.put(`projects/${projectId}`, { groupId });
        await fetchProjects();
        await fetchGroups();
      } catch {
        // ignore
      }
    },
    [api, fetchProjects, fetchGroups],
  );

  // --- Project Actions ---

  const handleDelete = useCallback(
    async (project: ProjectSummary) => {
      const confirmed = window.confirm(
        `Delete project "${project.name}"? This will stop all active teams and remove the project.`,
      );
      if (!confirmed) return;

      try {
        await api.del(`projects/${project.id}`);
        await fetchProjects();
        await fetchGroups();
      } catch (err) {
        window.alert(`Failed to delete project: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [api, fetchProjects, fetchGroups],
  );

  const handleAdded = useCallback(() => {
    setAddOpen(false);
    fetchProjects();
  }, [fetchProjects]);

  const [reinstalling, setReinstalling] = useState<number | null>(null);
  const [reinstallResult, setReinstallResult] = useState<{ id: number; ok: boolean; error?: string } | null>(null);

  const handleReinstall = useCallback(
    async (project: ProjectSummary) => {
      setReinstalling(project.id);
      setReinstallResult(null);
      try {
        const data = await api.post<{ ok: boolean; output?: string; error?: string }>(
          `projects/${project.id}/install`,
          {},
        );
        setReinstallResult({ id: project.id, ok: data.ok, error: data.error });
        await fetchProjects();
      } catch (err: unknown) {
        setReinstallResult({
          id: project.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setReinstalling(null);
      }
    },
    [api, fetchProjects],
  );

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

  const handleEditModel = useCallback((project: ProjectSummary) => {
    setEditingModelId(project.id);
    setEditModelValue(project.model ?? '');
    setTimeout(() => modelInputRef.current?.focus(), 50);
  }, []);

  const handleSaveModel = useCallback(
    async (projectId: number) => {
      try {
        await api.put(`projects/${projectId}`, { model: editModelValue.trim() || null });
        await fetchProjects();
      } catch {
        // ignore
      }
      modelCommittedRef.current = false;
      setEditingModelId(null);
    },
    [api, editModelValue, fetchProjects],
  );

  const handleCancelEditModel = useCallback(() => {
    setEditingModelId(null);
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

  // Close prompt editor on Escape key (document-level listener)
  useEffect(() => {
    if (editingPromptId === null) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setEditingPromptId(null);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [editingPromptId]);

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

  // --- Computed: group projects by groupId ---
  const { groupedSections, ungroupedProjects } = useMemo(() => {
    const ungrouped = projects.filter((p) => p.groupId == null);
    const sections = groups.map((g) => ({
      group: g,
      projects: projects.filter((p) => p.groupId === g.id),
    }));
    return { groupedSections: sections, ungroupedProjects: ungrouped };
  }, [projects, groups]);

  // Shared card props
  const cardProps = {
    groups,
    editingLimitId,
    editLimitValue,
    limitInputRef,
    committedRef,
    setEditingLimitId,
    setEditLimitValue,
    handleSaveLimit,
    handleCancelEditLimit,
    editingModelId,
    editModelValue,
    modelInputRef,
    modelCommittedRef,
    setEditingModelId,
    setEditModelValue,
    handleSaveModel,
    handleCancelEditModel,
    handleEditLimit,
    handleEditModel,
    reinstalling,
    reinstallResult,
    handleReinstall,
    handleCleanup,
    handleDelete,
    setEditingPromptId,
    onGroupChange: handleGroupChange,
  };

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
          <div className="flex items-center gap-2">
            <button
              onClick={handleCreateGroup}
              className="px-4 py-1.5 text-sm font-medium rounded border border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-muted transition-colors"
            >
              New Group
            </button>
            <button
              onClick={() => setAddOpen(true)}
              className="px-4 py-1.5 text-sm font-medium rounded border border-dark-accent/40 text-dark-accent bg-dark-accent/10 hover:bg-dark-accent/20 transition-colors"
            >
              Add Project
            </button>
          </div>
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
          <div>
            {/* Grouped sections */}
            {groupedSections.map(({ group, projects: groupProjects }) => (
              <GroupSection
                key={group.id}
                title={group.name}
                description={group.description}
                projectCount={groupProjects.length}
                onEdit={() => handleEditGroup(group)}
                onDelete={() => handleDeleteGroup(group)}
              >
                {groupProjects.length === 0 ? (
                  <p className="text-xs text-dark-muted/60 py-2">No projects in this group</p>
                ) : (
                  groupProjects.map((project) => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      {...cardProps}
                    />
                  ))
                )}
              </GroupSection>
            ))}

            {/* Ungrouped section */}
            {ungroupedProjects.length > 0 && (
              <GroupSection
                title="Ungrouped"
                projectCount={ungroupedProjects.length}
                defaultExpanded={true}
              >
                {ungroupedProjects.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    {...cardProps}
                  />
                ))}
              </GroupSection>
            )}
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

      {/* Group dialog (create/edit) */}
      <GroupDialog
        open={groupDialogOpen}
        group={editingGroup}
        onClose={() => setGroupDialogOpen(false)}
        onSave={handleSaveGroup}
      />

      {/* Prompt editor modal */}
      {editingPromptId !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={(e) => {
            if (e.target === e.currentTarget) setEditingPromptId(null);
          }}
        >
          <div className="w-[600px] max-w-[95vw] max-h-[80vh] bg-dark-surface border border-dark-border rounded-lg shadow-2xl flex flex-col" role="dialog" aria-modal="true">
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
