import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useApi } from '../hooks/useApi';
import { useInlineEdit } from '../hooks/useInlineEdit';
import { AddProjectDialog } from '../components/AddProjectDialog';
import { CleanupModal } from '../components/CleanupModal';
import { JiraSourceDialog } from '../components/JiraSourceDialog';
import { OverflowMenu } from '../components/OverflowMenu';
import { ChevronRightIcon, PencilIcon } from '../components/Icons';
import type { ProjectSummary, ProjectStatus, ProjectGroup, ProjectIssueSourceResponse, RepoSettings } from '../../shared/types';

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
// Install health helpers
// ---------------------------------------------------------------------------

type HealthColor = '#3FB950' | '#D29922' | '#F85149' | '#8B949E';

/** Returns a single aggregate health color for the install status */
function getInstallHealthColor(project: ProjectSummary): HealthColor {
  if (!project.installStatus) return '#8B949E';
  const s = project.installStatus;

  // Git commit status takes priority when red
  const gitHealth = s.gitCommitStatus?.health;
  if (gitHealth === 'red') return '#F85149';

  const hooksOk = s.hooks?.installed ?? false;
  const hooksCrlf = s.hooks?.files?.some((f: { hasCrlf?: boolean }) => f.hasCrlf) ?? false;
  const promptOk = s.prompt?.installed ?? false;
  const agentsOk = s.agents?.installed ?? false;
  const settingsOk = s.settings?.exists ?? false;

  const allOk = hooksOk && !hooksCrlf && promptOk && agentsOk && settingsOk;
  if (allOk) {
    // All files present — but check if any are outdated or git commit is amber
    const outdated = s.outdatedCount ?? 0;
    if (outdated > 0 || gitHealth === 'amber') return '#D29922';
    return '#3FB950';
  }

  const anyInstalled = hooksOk || promptOk || agentsOk || settingsOk;
  if (anyInstalled || hooksCrlf) return '#D29922';

  return '#F85149';
}

function getInstallHealthLabel(color: HealthColor, project?: ProjectSummary): string {
  // Show git commit status message when it drives the color
  if (project?.installStatus?.gitCommitStatus) {
    const gcs = project.installStatus.gitCommitStatus;
    if (gcs.health === 'red' && color === '#F85149') {
      return gcs.message;
    }
    if (gcs.health === 'amber' && color === '#D29922') {
      return gcs.message;
    }
  }
  if (color === '#D29922' && project?.installStatus) {
    const s = project.installStatus;
    const hooksOk = s.hooks?.installed ?? false;
    const promptOk = s.prompt?.installed ?? false;
    const agentsOk = s.agents?.installed ?? false;
    const settingsOk = s.settings?.exists ?? false;
    const allPresent = hooksOk && promptOk && agentsOk && settingsOk;
    if (allPresent && (s.outdatedCount ?? 0) > 0) {
      return `${s.outdatedCount} file${s.outdatedCount === 1 ? '' : 's'} outdated`;
    }
  }
  switch (color) {
    case '#3FB950': return 'All installed';
    case '#D29922': return 'Partially installed';
    case '#F85149': return 'Not installed';
    default: return 'Unknown';
  }
}

// ---------------------------------------------------------------------------
// Install detail categories (reused from original)
// ---------------------------------------------------------------------------

function InstallHealthDetail({ project, repoSettings }: { project: ProjectSummary; repoSettings?: RepoSettings | null }) {
  if (!project.installStatus) {
    return (
      <span className="text-xs text-dark-muted" title="Install status unknown">
        Status unknown
      </span>
    );
  }

  const s = project.installStatus;
  const currentVersion = s.currentVersion;

  const detailedCategories: {
    key: string;
    label: string;
    installed: boolean;
    hasCrlf: boolean;
    somePresent: boolean;
    files: { name: string; exists: boolean; hasCrlf?: boolean; installedVersion?: string; currentVersion?: string }[];
    summary: string;
    outdatedInCategory: number;
  }[] = [
    {
      key: 'hooks',
      label: 'hooks',
      installed: s.hooks?.installed ?? false,
      hasCrlf: s.hooks?.files?.some((f: { hasCrlf?: boolean }) => f.hasCrlf) ?? false,
      somePresent: (s.hooks?.found ?? 0) > 0,
      files: s.hooks?.files ?? [],
      summary: `Hook Scripts (${s.hooks?.found ?? 0}/${s.hooks?.total ?? 0})`,
      outdatedInCategory: (s.hooks?.files ?? []).filter((f) => f.exists && f.installedVersion !== currentVersion).length,
    },
    {
      key: 'prompt',
      label: 'prompt',
      installed: s.prompt?.installed ?? false,
      hasCrlf: false,
      somePresent: s.prompt?.files?.some((f) => f.exists) ?? false,
      files: s.prompt?.files ?? [],
      summary: 'Prompt Files',
      outdatedInCategory: (s.prompt?.files ?? []).filter((f) => f.exists && f.installedVersion !== currentVersion).length,
    },
    {
      key: 'agents',
      label: 'agents',
      installed: s.agents?.installed ?? false,
      hasCrlf: false,
      somePresent: s.agents?.files?.some((f) => f.exists) ?? false,
      files: s.agents?.files ?? [],
      summary: 'Agent Templates',
      outdatedInCategory: (s.agents?.files ?? []).filter((f) => f.exists && f.installedVersion !== currentVersion).length,
    },
    {
      key: 'guides',
      label: 'guides',
      installed: s.guides?.installed ?? false,
      hasCrlf: false,
      somePresent: (s.guides?.files?.length ?? 0) > 0,
      files: s.guides?.files ?? [],
      summary: `Guidebooks (${s.guides?.files?.length ?? 0})`,
      outdatedInCategory: (s.guides?.files ?? []).filter(
        (f) => f.exists && f.installedVersion !== currentVersion
      ).length,
    },
  ];

  const settingsOutdated = s.settings?.exists && s.settings.installedVersion !== currentVersion;
  const booleanCategories: {
    key: string;
    label: string;
    exists: boolean;
    tooltip: string;
    outdated: boolean;
  }[] = [
    {
      key: 'settings',
      label: 'settings',
      exists: s.settings?.exists ?? false,
      tooltip: s.settings?.exists
        ? settingsOutdated
          ? `settings.json: v${s.settings.installedVersion || '?'} \u2192 v${currentVersion}`
          : 'settings.json found'
        : 'settings.json missing',
      outdated: !!settingsOutdated,
    },
  ];

  return (
    <div className="flex items-center gap-3 text-xs flex-wrap">
      {detailedCategories.map((cat) => {
        // Determine category color: green if all ok + no outdated, amber for issues, red if missing
        const hasOutdated = cat.outdatedInCategory > 0;
        const color = cat.installed && !cat.hasCrlf && !hasOutdated
          ? '#3FB950'
          : cat.hasCrlf || hasOutdated
            ? '#D29922'
            : cat.somePresent
              ? '#D29922'
              : '#F85149';
        const icon = cat.installed && !cat.hasCrlf && !hasOutdated
          ? '\u2713'
          : cat.hasCrlf || hasOutdated
            ? '\u26A0'
            : cat.somePresent
              ? '\u26A0'
              : '\u2717';

        return (
          <div key={cat.key} className="relative group shrink-0">
            <span className="cursor-default" style={{ color }}>
              {icon} {cat.label}
            </span>
            {/* Tooltip on hover */}
            <div className="hidden group-hover:block absolute z-10 bottom-full left-0 mb-1 p-2 rounded bg-[#1C2128] border border-[#30363D] shadow-lg text-xs min-w-48 max-h-64 overflow-auto">
              <div className="font-medium mb-1 text-[#C9D1D9]">
                {cat.summary}
              </div>
              {cat.files.map((f) => {
                const isOutdated = f.exists && f.installedVersion !== currentVersion;
                const fileColor = f.exists
                  ? f.hasCrlf ? '#D29922' : isOutdated ? '#D29922' : '#3FB950'
                  : '#F85149';
                const fileIcon = f.exists
                  ? f.hasCrlf ? '\u26A0' : isOutdated ? '\u26A0' : '\u2713'
                  : '\u2717';
                const versionSuffix = f.exists && isOutdated
                  ? ` (v${f.installedVersion || '?'} \u2192 v${currentVersion})`
                  : f.hasCrlf
                    ? ' (CRLF)'
                    : '';
                return (
                  <div key={f.name} className="flex items-center gap-1.5 py-0.5">
                    <span style={{ color: fileColor }}>{fileIcon}</span>
                    <span className="text-[#8B949E] font-mono">
                      {f.name}{versionSuffix}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {booleanCategories.map((cat) => {
        const color = cat.exists
          ? cat.outdated ? '#D29922' : '#3FB950'
          : '#F85149';
        const icon = cat.exists
          ? cat.outdated ? '\u26A0' : '\u2713'
          : '\u2717';

        return (
          <div key={cat.key} className="relative group shrink-0">
            <span className="cursor-default" style={{ color }}>
              {icon} {cat.label}
            </span>
            {/* Tooltip on hover */}
            <div className="hidden group-hover:block absolute z-10 bottom-full right-0 mb-1 p-2 rounded bg-[#1C2128] border border-[#30363D] shadow-lg text-xs whitespace-nowrap">
              <span className="text-[#C9D1D9]">{cat.tooltip}</span>
            </div>
          </div>
        );
      })}
      {/* Git commit status badge */}
      {s.gitCommitStatus && (
        <div className="relative group shrink-0">
          <span
            className="cursor-default"
            style={{
              color: s.gitCommitStatus.health === 'green' ? '#3FB950'
                : s.gitCommitStatus.health === 'amber' ? '#D29922'
                : s.gitCommitStatus.health === 'red' ? '#F85149'
                : '#8B949E',
            }}
          >
            {s.gitCommitStatus.health === 'green' ? '\u2713'
              : s.gitCommitStatus.health === 'amber' ? '\u26A0'
              : s.gitCommitStatus.health === 'red' ? '\u2717'
              : '?'} committed
          </span>
          {/* Tooltip on hover */}
          <div className="hidden group-hover:block absolute z-10 bottom-full right-0 mb-1 p-2 rounded bg-[#1C2128] border border-[#30363D] shadow-lg text-xs min-w-56 max-h-64 overflow-auto">
            <div className="font-medium mb-1 text-[#C9D1D9]">
              Git Commit Status ({s.gitCommitStatus.defaultBranch})
            </div>
            <div className="text-[#8B949E] mb-1">{s.gitCommitStatus.message}</div>
            {s.gitCommitStatus.gitignored && (
              <div className="flex items-center gap-1.5 py-0.5">
                <span style={{ color: '#F85149' }}>{'\u2717'}</span>
                <span className="text-[#8B949E]">.claude/ is in .gitignore</span>
              </div>
            )}
            {s.gitCommitStatus.files.map((f) => {
              const fileColor = f.committed
                ? (f.committedVersion && f.committedVersion !== f.currentVersion ? '#D29922' : '#3FB950')
                : '#F85149';
              const fileIcon = f.committed
                ? (f.committedVersion && f.committedVersion !== f.currentVersion ? '\u26A0' : '\u2713')
                : '\u2717';
              const versionSuffix = f.committed && f.committedVersion && f.committedVersion !== f.currentVersion
                ? ` (v${f.committedVersion} \u2192 v${f.currentVersion})`
                : '';
              return (
                <div key={f.path} className="flex items-center gap-1.5 py-0.5">
                  <span style={{ color: fileColor }}>{fileIcon}</span>
                  <span className="text-[#8B949E] font-mono text-[11px]">
                    {f.path}{versionSuffix}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {/* GitHub repo settings badge */}
      {repoSettings && (
        <div className="relative group shrink-0">
          <span
            className="cursor-default"
            style={{ color: repoSettings.autoMergeEnabled ? '#3FB950' : '#D29922' }}
          >
            {repoSettings.autoMergeEnabled ? '\u2713' : '\u26A0'} github
          </span>
          {/* Tooltip on hover */}
          <div className="hidden group-hover:block absolute z-10 bottom-full right-0 mb-1 p-2 rounded bg-[#1C2128] border border-[#30363D] shadow-lg text-xs min-w-52">
            <div className="font-medium mb-1 text-[#C9D1D9]">
              GitHub Repo Settings
            </div>
            <div className="flex items-center gap-1.5 py-0.5">
              <span style={{ color: repoSettings.autoMergeEnabled ? '#3FB950' : '#D29922' }}>
                {repoSettings.autoMergeEnabled ? '\u2713' : '\u26A0'}
              </span>
              <span className="text-[#8B949E]">
                {repoSettings.autoMergeEnabled
                  ? 'Auto-merge enabled'
                  : 'Auto-merge disabled \u2014 required for gh pr merge --auto'}
              </span>
            </div>
            <div className="flex items-center gap-1.5 py-0.5">
              <span style={{ color: '#8B949E' }}>{'\u2022'}</span>
              <span className="text-[#8B949E]">
                Default branch: {repoSettings.defaultBranch}
              </span>
            </div>
            {repoSettings.branchProtection && (
              <div className="flex items-center gap-1.5 py-0.5">
                <span style={{ color: repoSettings.branchProtection.enabled ? '#3FB950' : '#8B949E' }}>
                  {repoSettings.branchProtection.enabled ? '\u2713' : '\u2022'}
                </span>
                <span className="text-[#8B949E]">
                  {repoSettings.branchProtection.enabled
                    ? `Branch protection (${repoSettings.branchProtection.requiredChecks.length} required check${repoSettings.branchProtection.requiredChecks.length !== 1 ? 's' : ''})`
                    : 'No branch protection'}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// IssueSourcesSection — lists configured issue sources with status badges
// ---------------------------------------------------------------------------

/** Status badge color: green=enabled+credentials, red=enabled+no credentials, gray=disabled */
function sourceStatusColor(source: ProjectIssueSourceResponse): string {
  if (!source.enabled) return '#8B949E';
  return source.hasCredentials ? '#3FB950' : '#F85149';
}

function sourceStatusLabel(source: ProjectIssueSourceResponse): string {
  if (!source.enabled) return 'Disabled';
  return source.hasCredentials ? 'Connected' : 'No credentials';
}

function IssueSourcesSection({
  projectId,
}: {
  projectId: number;
}) {
  const api = useApi();
  const [sources, setSources] = useState<ProjectIssueSourceResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSource, setEditingSource] = useState<ProjectIssueSourceResponse | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);

  const fetchSources = useCallback(async () => {
    try {
      const data = await api.get<{ sources: ProjectIssueSourceResponse[] }>(`projects/${projectId}/issue-sources`);
      setSources(Array.isArray(data.sources) ? data.sources : []);
    } catch {
      // Silently handle — sources section is supplementary
    } finally {
      setLoading(false);
    }
  }, [api, projectId]);

  useEffect(() => {
    fetchSources();
  }, [fetchSources]);

  const handleSave = useCallback(async (data: {
    provider: string;
    label: string | null;
    configJson: string;
    credentialsJson: string;
    enabled: boolean;
  }) => {
    if (editingSource) {
      await api.patch(`projects/${projectId}/issue-sources/${editingSource.id}`, data);
    } else {
      await api.post(`projects/${projectId}/issue-sources`, data);
    }
    setDialogOpen(false);
    setEditingSource(null);
    await fetchSources();
  }, [api, projectId, editingSource, fetchSources]);

  const handleToggle = useCallback(async (source: ProjectIssueSourceResponse) => {
    const prev = sources;
    // Optimistic update
    setSources(sources.map((s) => s.id === source.id ? { ...s, enabled: !s.enabled } : s));
    try {
      await api.patch(`projects/${projectId}/issue-sources/${source.id}`, {
        enabled: !source.enabled,
      });
    } catch {
      // Revert on failure
      setSources(prev);
    }
  }, [api, projectId, sources]);

  const handleDelete = useCallback(async (sourceId: number) => {
    try {
      await api.del(`projects/${projectId}/issue-sources/${sourceId}`);
      setSources(sources.filter((s) => s.id !== sourceId));
      setDeleteConfirm(null);
    } catch {
      // Silently handle
    }
  }, [api, projectId, sources]);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="text-[10px] uppercase tracking-wider text-dark-muted/60 font-medium">
          Issue Sources
        </div>
        <button
          onClick={() => { setEditingSource(null); setDialogOpen(true); }}
          className="text-[10px] text-dark-accent/70 hover:text-dark-accent transition-colors"
        >
          + Add Jira Source
        </button>
      </div>

      {loading && (
        <div className="text-xs text-dark-muted">Loading...</div>
      )}

      {!loading && sources.length === 0 && (
        <div className="text-xs text-dark-muted/60">No issue sources configured</div>
      )}

      {!loading && sources.length > 0 && (
        <div className="space-y-1.5">
          {sources.map((source) => {
            const statusColor = sourceStatusColor(source);
            const statusText = sourceStatusLabel(source);
            let sourceLabel = source.label || source.provider;
            try {
              const config = JSON.parse(source.configJson) as Record<string, unknown>;
              if (config.projectKey) {
                sourceLabel = source.label || `${source.provider} — ${config.projectKey}`;
              }
            } catch {
              // Use default label
            }

            return (
              <div
                key={source.id}
                className="flex items-center gap-2 text-xs bg-dark-base/50 rounded px-2.5 py-1.5 border border-dark-border/50"
              >
                {/* Status dot */}
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: statusColor }}
                  title={statusText}
                />

                {/* Label */}
                <span className="text-dark-text/80 truncate flex-1" title={sourceLabel}>
                  {sourceLabel}
                </span>

                {/* Status text */}
                <span className="text-[10px] shrink-0" style={{ color: statusColor }}>
                  {statusText}
                </span>

                {/* Toggle button */}
                <button
                  onClick={() => handleToggle(source)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors shrink-0 ${
                    source.enabled ? 'bg-[#3FB950]' : 'bg-dark-border'
                  }`}
                  title={source.enabled ? 'Disable' : 'Enable'}
                >
                  <span
                    className={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${
                      source.enabled ? 'translate-x-3.5' : 'translate-x-0.5'
                    }`}
                  />
                </button>

                {/* Edit button */}
                <button
                  onClick={() => { setEditingSource(source); setDialogOpen(true); }}
                  className="text-dark-muted/50 hover:text-dark-text transition-colors shrink-0"
                  title="Edit"
                >
                  <PencilIcon size={11} />
                </button>

                {/* Delete button */}
                {deleteConfirm === source.id ? (
                  <span className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleDelete(source.id)}
                      className="text-[10px] text-[#F85149] hover:text-[#FF6E76] transition-colors"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setDeleteConfirm(null)}
                      className="text-[10px] text-dark-muted hover:text-dark-text transition-colors"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => setDeleteConfirm(source.id)}
                    className="text-dark-muted/50 hover:text-[#F85149] transition-colors shrink-0"
                    title="Delete"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                      <path
                        fillRule="evenodd"
                        d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <JiraSourceDialog
        open={dialogOpen}
        projectId={projectId}
        source={editingSource}
        onClose={() => { setDialogOpen(false); setEditingSource(null); }}
        onSave={handleSave}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProjectCard — two-tier expandable layout
// ---------------------------------------------------------------------------

function ProjectCard({
  project,
  groups,
  reinstalling,
  reinstallResult,
  onSaveLimit,
  onSaveModel,
  onReinstall,
  onCleanup,
  onDelete,
  onEditPrompt,
  onGroupChange,
  fetchRepoSettings,
  onCommitClaudeFiles,
}: {
  project: ProjectSummary;
  groups: ProjectGroupWithCount[];
  reinstalling: number | null;
  reinstallResult: { id: number; ok: boolean; error?: string } | null;
  onSaveLimit: (projectId: number, value: number) => void;
  onSaveModel: (projectId: number, value: string) => void;
  onReinstall: (p: ProjectSummary) => void;
  onCleanup: (p: ProjectSummary) => void;
  onDelete: (p: ProjectSummary) => void;
  onEditPrompt: (id: number) => void;
  onGroupChange: (projectId: number, groupId: number | null) => void;
  fetchRepoSettings: (projectId: number) => Promise<RepoSettings | null>;
  onCommitClaudeFiles: (projectId: number, options?: { reinstall?: boolean }) => Promise<{ ok: boolean; error?: string; message?: string }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [repoSettings, setRepoSettings] = useState<RepoSettings | null | undefined>(undefined);
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<{ ok: boolean; error?: string; message?: string } | null>(null);
  const [repoSettingsLoaded, setRepoSettingsLoaded] = useState(false);
  const limitEdit = useInlineEdit<number>(project.maxActiveTeams);
  const modelEdit = useInlineEdit<string>(project.model ?? '');

  // Lazy-load repo settings when first expanded
  useEffect(() => {
    if (!expanded || repoSettingsLoaded) return;
    setRepoSettingsLoaded(true);
    fetchRepoSettings(project.id)
      .then((settings) => setRepoSettings(settings))
      .catch(() => setRepoSettings(null));
  }, [expanded, repoSettingsLoaded, fetchRepoSettings, project.id]);

  const statusStyle = STATUS_STYLES[project.status] || STATUS_STYLES.active;
  const healthColor = getInstallHealthColor(project);
  const healthLabel = getInstallHealthLabel(healthColor, project);

  // Team stats string
  const queuedCount = project.queuedTeamCount ?? 0;
  const teamStats = `${project.activeTeamCount}/${project.maxActiveTeams} active${queuedCount > 0 ? ` \u00b7 ${queuedCount} queued` : ''}`;

  const handleSaveLimitInline = useCallback(() => {
    const value = limitEdit.confirmEdit();
    if (value === null) return; // already saved (Enter + blur double-fire guard)
    const clamped = Math.max(1, Math.min(50, value));
    onSaveLimit(project.id, clamped);
  }, [limitEdit, onSaveLimit, project.id]);

  const handleSaveModelInline = useCallback(() => {
    const value = modelEdit.confirmEdit();
    if (value === null) return; // already saved (Enter + blur double-fire guard)
    onSaveModel(project.id, value);
  }, [modelEdit, onSaveModel, project.id]);

  return (
    <div className="bg-dark-surface border border-dark-border rounded-lg overflow-hidden">
      {/* ── Tier 1: Compact summary line ── */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-dark-border/10 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Chevron */}
        <ChevronRightIcon
          size={14}
          className={`text-dark-muted shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />

        {/* Project name */}
        <span className="text-sm font-semibold text-dark-text truncate min-w-0">
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

        {/* Team stats */}
        <span className="text-xs text-dark-muted shrink-0">
          {teamStats}
        </span>

        {/* Install health dot */}
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: healthColor }}
          title={healthLabel}
        />

        {/* Spacer */}
        <span className="flex-1" />

        {/* Outdated badge — shown when installed files are outdated */}
        {(project.installStatus?.outdatedCount ?? 0) > 0 && (
          <span className="px-2 py-0.5 text-xs rounded-full bg-[#D29922]/15 text-[#D29922] font-medium shrink-0">
            {project.installStatus!.outdatedCount} outdated
          </span>
        )}

        {/* Reinstall button */}
        <button
          onClick={(e) => { e.stopPropagation(); onReinstall(project); }}
          disabled={reinstalling === project.id}
          className="px-3 py-1 text-xs rounded border border-dark-accent/40 text-dark-accent bg-dark-accent/10 hover:bg-dark-accent/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          title={
            (project.installStatus?.outdatedCount ?? 0) > 0
              ? `Reinstall (${project.installStatus!.outdatedCount} file${project.installStatus!.outdatedCount === 1 ? '' : 's'} outdated)`
              : '(Re)install hooks, settings, and workflow prompt'
          }
        >
          {reinstalling === project.id ? 'Installing...' : 'Reinstall'}
        </button>

        {/* Overflow menu (Clean Up, Delete) */}
        <OverflowMenu
          items={[
            {
              label: 'Clean Up',
              onClick: () => onCleanup(project),
            },
            {
              label: 'Delete',
              onClick: () => onDelete(project),
              danger: true,
            },
          ]}
        />
      </div>

      {/* Reinstall result banner */}
      {reinstallResult?.id === project.id && (
        <div
          className={`mx-4 mb-2 px-3 py-1.5 rounded text-xs ${
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

      {/* Git commit status banner */}
      {project.installStatus?.gitCommitStatus &&
        (project.installStatus.gitCommitStatus.health === 'red' ||
          project.installStatus.gitCommitStatus.health === 'amber') && (
        <div
          className={`mx-4 mb-2 px-3 py-1.5 rounded text-xs flex items-center gap-2 ${
            project.installStatus.gitCommitStatus.health === 'red'
              ? 'border border-[#F85149]/30 bg-[#F85149]/10 text-[#F85149]'
              : 'border border-[#D29922]/30 bg-[#D29922]/10 text-[#D29922]'
          }`}
        >
          <span className="flex-1">
            {project.installStatus.gitCommitStatus.message}
            {project.installStatus.gitCommitStatus.health === 'red' &&
              !project.installStatus.gitCommitStatus.gitignored &&
              ' \u2014 hooks and agents won\'t work in worktrees'}
          </span>
          <button
            onClick={async (e) => {
              e.stopPropagation();
              const isAmber = project.installStatus?.gitCommitStatus?.health === 'amber';
              const msg = isAmber
                ? 'This will update and commit+push .claude/ files to the default branch. Continue?'
                : 'This will commit and push .claude/ files to the default branch. Continue?';
              if (!window.confirm(msg)) return;
              setCommitting(true);
              setCommitResult(null);
              try {
                const result = await onCommitClaudeFiles(project.id, { reinstall: isAmber });
                setCommitResult(result);
                if (result.ok && !result.error) {
                  setTimeout(() => setCommitResult(null), 5000);
                }
              } catch (err: unknown) {
                setCommitResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
              } finally {
                setCommitting(false);
              }
            }}
            disabled={committing}
            className={`shrink-0 px-2 py-0.5 rounded border text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              project.installStatus.gitCommitStatus.health === 'red'
                ? 'border-[#F85149]/40 text-[#F85149] bg-[#F85149]/10 hover:bg-[#F85149]/20'
                : 'border-[#D29922]/40 text-[#D29922] bg-[#D29922]/10 hover:bg-[#D29922]/20'
            }`}
          >
            {committing
              ? 'Committing...'
              : project.installStatus.gitCommitStatus.health === 'amber'
                ? 'Update & Commit'
                : 'Fix'}
          </button>
        </div>
      )}

      {/* Commit result banner */}
      {commitResult && (
        <div
          className={`mx-4 mb-2 px-3 py-1.5 rounded text-xs ${
            commitResult.ok && !commitResult.error
              ? 'border border-[#3FB950]/30 bg-[#3FB950]/10 text-[#3FB950]'
              : commitResult.ok && commitResult.error
                ? 'border border-[#D29922]/30 bg-[#D29922]/10 text-[#D29922]'
                : 'border border-[#F85149]/30 bg-[#F85149]/10 text-[#F85149]'
          }`}
        >
          {commitResult.ok
            ? (commitResult.error
              ? commitResult.error
              : (commitResult.message ?? '.claude/ files committed and pushed successfully'))
            : `Commit failed: ${commitResult.error}`}
        </div>
      )}

      {/* ── Tier 2: Expandable details ── */}
      {expanded && (
        <div className="border-t border-dark-border px-4 py-3 space-y-3">
          {/* Repository */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-dark-muted/60 font-medium mb-1">
              Repository
            </div>
            <div className="flex items-center gap-4 text-xs text-dark-muted">
              <span className="truncate" title={project.repoPath}>
                {project.repoPath}
              </span>
              {project.githubRepo && (
                <span className="shrink-0">{project.githubRepo}</span>
              )}
            </div>
          </div>

          {/* Configuration */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-dark-muted/60 font-medium mb-1">
              Configuration
            </div>
            <div className="flex items-center gap-4 text-xs text-dark-muted flex-wrap">
              {/* Model (editable) */}
              {modelEdit.isEditing ? (
                <span className="shrink-0 inline-flex items-center gap-1">
                  <span>Model:</span>
                  <input
                    ref={modelEdit.inputRef}
                    type="text"
                    value={modelEdit.editValue}
                    onChange={(e) => modelEdit.setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveModelInline();
                      if (e.key === 'Escape') modelEdit.cancelEdit();
                    }}
                    onBlur={handleSaveModelInline}
                    placeholder="default"
                    className="w-32 px-1 py-0 text-xs rounded border border-dark-accent bg-dark-base text-dark-text focus:outline-none"
                  />
                </span>
              ) : (
                <span
                  className="shrink-0 inline-flex items-center gap-1 cursor-pointer hover:text-dark-text transition-colors group"
                  onClick={() => modelEdit.startEdit(project.model ?? '')}
                  title="Click to edit model"
                >
                  Model: {project.model || 'default'}
                  <PencilIcon size={11} className="text-dark-muted/40 group-hover:text-dark-muted transition-colors" />
                </span>
              )}

              {/* Max teams (editable) */}
              {limitEdit.isEditing ? (
                <span className="shrink-0 inline-flex items-center gap-1">
                  <span>Max teams:</span>
                  <input
                    ref={limitEdit.inputRef}
                    type="number"
                    value={limitEdit.editValue}
                    onChange={(e) => limitEdit.setEditValue(parseInt(e.target.value, 10) || 1)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveLimitInline();
                      if (e.key === 'Escape') limitEdit.cancelEdit();
                    }}
                    onBlur={handleSaveLimitInline}
                    min={1}
                    max={50}
                    className="w-12 px-1 py-0 text-xs rounded border border-dark-accent bg-dark-base text-dark-text focus:outline-none"
                  />
                </span>
              ) : (
                <span
                  className="shrink-0 inline-flex items-center gap-1 cursor-pointer hover:text-dark-text transition-colors group"
                  onClick={() => limitEdit.startEdit(project.maxActiveTeams)}
                  title="Click to edit max active teams"
                >
                  Max teams: {project.maxActiveTeams}
                  <PencilIcon size={11} className="text-dark-muted/40 group-hover:text-dark-muted transition-colors" />
                </span>
              )}

              {/* Group selector */}
              <select
                value={project.groupId ?? ''}
                onChange={(e) => {
                  const val = e.target.value;
                  onGroupChange(project.id, val === '' ? null : parseInt(val, 10));
                }}
                onClick={(e) => e.stopPropagation()}
                className="shrink-0 px-1 py-0 text-xs rounded border border-dark-border bg-dark-base text-dark-muted hover:text-dark-text focus:outline-none cursor-pointer"
                title="Assign to group"
              >
                <option value="">No group</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Install Health */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-dark-muted/60 font-medium mb-1">
              Install Health
            </div>
            <InstallHealthDetail project={project} repoSettings={repoSettings} />
          </div>

          {/* Issue Sources */}
          <IssueSourcesSection projectId={project.id} />

          {/* Prompt (conditional) */}
          {project.promptFile && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-dark-muted/60 font-medium mb-1">
                Prompt
              </div>
              <div className="flex items-center gap-2 text-xs text-dark-muted">
                <span className="truncate text-dark-text/70" title={project.promptFile}>
                  {project.promptFile}
                </span>
                <button
                  onClick={() => onEditPrompt(project.id)}
                  className="shrink-0 text-dark-accent/70 hover:text-dark-accent transition-colors"
                  title="Edit launch prompt"
                >
                  Edit
                </button>
              </div>
            </div>
          )}
        </div>
      )}
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

  // Prompt editor state
  const [editingPromptId, setEditingPromptId] = useState<number | null>(null);
  const [promptContent, setPromptContent] = useState('');
  const [promptLoading, setPromptLoading] = useState(false);
  const [promptSaving, setPromptSaving] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);

  const [reinstalling, setReinstalling] = useState<number | null>(null);
  const [reinstallResult, setReinstallResult] = useState<{ id: number; ok: boolean; error?: string } | null>(null);

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

  const fetchRepoSettings = useCallback(async (projectId: number): Promise<RepoSettings | null> => {
    try {
      const data = await api.get<RepoSettings | null>(`projects/${projectId}/repo-settings`);
      return data;
    } catch {
      return null;
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
      // Optimistic update
      setProjects((prev) =>
        prev.map((p) => (p.id === projectId ? { ...p, groupId } : p)),
      );
      try {
        await api.put(`projects/${projectId}`, { groupId });
        // Refresh groups to update project counts
        await fetchGroups();
      } catch {
        // Revert on failure by refetching
        await fetchProjects();
        await fetchGroups();
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

      // Optimistic removal
      setProjects((prev) => prev.filter((p) => p.id !== project.id));
      try {
        await api.del(`projects/${project.id}`);
        await fetchGroups();
      } catch (err) {
        // Revert on failure
        await fetchProjects();
        await fetchGroups();
        window.alert(`Failed to delete project: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [api, fetchProjects, fetchGroups],
  );

  const handleAdded = useCallback(() => {
    setAddOpen(false);
    fetchProjects();
  }, [fetchProjects]);

  const handleReinstall = useCallback(
    async (project: ProjectSummary) => {
      setReinstalling(project.id);
      setReinstallResult(null);
      try {
        const data = await api.post<{
          ok: boolean;
          output?: string;
          error?: string;
          installStatus?: ProjectSummary['installStatus'];
        }>(
          `projects/${project.id}/install`,
          {},
        );
        setReinstallResult({ id: project.id, ok: data.ok, error: data.error });
        // Optimistic update: use the install status from the response
        if (data.installStatus) {
          setProjects((prev) =>
            prev.map((p) => (p.id === project.id ? { ...p, installStatus: data.installStatus } : p)),
          );
        }
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
    [api],
  );

  const handleCommitClaudeFiles = useCallback(
    async (projectId: number, options?: { reinstall?: boolean }): Promise<{ ok: boolean; error?: string; message?: string }> => {
      try {
        const result = await api.post<{ ok: boolean; error?: string; message?: string }>(
          `projects/${projectId}/commit-claude-files`,
          { reinstall: options?.reinstall },
        );
        // Refresh projects to update install status (and git commit status)
        await fetchProjects();
        return result;
      } catch (err: unknown) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
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

  const handleSaveLimit = useCallback(
    async (projectId: number, value: number) => {
      // Optimistic update
      setProjects((prev) =>
        prev.map((p) => (p.id === projectId ? { ...p, maxActiveTeams: value } : p)),
      );
      try {
        await api.put(`projects/${projectId}`, { maxActiveTeams: value });
      } catch {
        // Revert on failure by refetching
        await fetchProjects();
      }
    },
    [api, fetchProjects],
  );

  const handleSaveModel = useCallback(
    async (projectId: number, value: string) => {
      const trimmed = value.trim() || null;
      // Optimistic update
      setProjects((prev) =>
        prev.map((p) => (p.id === projectId ? { ...p, model: trimmed } : p)),
      );
      try {
        await api.put(`projects/${projectId}`, { model: trimmed });
      } catch {
        // Revert on failure by refetching
        await fetchProjects();
      }
    },
    [api, fetchProjects],
  );

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
    reinstalling,
    reinstallResult,
    onSaveLimit: handleSaveLimit,
    onSaveModel: handleSaveModel,
    onReinstall: handleReinstall,
    onCleanup: handleCleanup,
    onDelete: handleDelete,
    onEditPrompt: setEditingPromptId,
    onGroupChange: handleGroupChange,
    fetchRepoSettings,
    onCommitClaudeFiles: handleCommitClaudeFiles,
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
