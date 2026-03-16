// =============================================================================
// Fleet Commander — Shared TypeScript Types (v1, aligned with PRD section 4)
// =============================================================================

// ---------------------------------------------------------------------------
// Enums / Union Types
// ---------------------------------------------------------------------------

/** Team operational status */
export type TeamStatus = 'queued' | 'launching' | 'running' | 'idle' | 'stuck' | 'done' | 'failed';

/** Team domain phase */
export type TeamPhase = 'init' | 'analyzing' | 'implementing' | 'reviewing' | 'pr' | 'done' | 'blocked';

/** Pull request state */
export type PRState = 'draft' | 'open' | 'merged' | 'closed';

/** CI pipeline status */
export type CIStatus = 'none' | 'pending' | 'passing' | 'failing';

/** Merge readiness state */
export type MergeState = 'unknown' | 'clean' | 'behind' | 'blocked' | 'dirty';

/** Issue board status */
export type BoardStatus = 'Backlog' | 'Ready' | 'InProgress' | 'Done' | 'Blocked';

/** Project status */
export type ProjectStatus = 'active' | 'paused' | 'archived';

// ---------------------------------------------------------------------------
// Core Entities (matching PRD section 4 schema)
// ---------------------------------------------------------------------------

/** A project representing a local git repository */
export interface Project {
  id: number;
  name: string;
  repoPath: string;
  githubRepo: string | null;
  status: ProjectStatus;
  hooksInstalled: boolean;
  maxActiveTeams: number;
  createdAt: string;
  updatedAt: string;
}

/** Install status for the three artifacts deployed by install.sh */
export interface InstallStatus {
  hooks: boolean;
  prompt: boolean;
  command: boolean;
}

/** Project with team count for list view */
export interface ProjectSummary extends Project {
  teamCount: number;
  activeTeamCount: number;
  queuedTeamCount: number;
  installStatus?: InstallStatus;
}

/** A team of agents working on a single issue in a worktree */
export interface Team {
  id: number;
  issueNumber: number;
  issueTitle: string | null;
  projectId: number | null;
  status: TeamStatus;
  phase: TeamPhase;
  pid: number | null;
  sessionId: string | null;
  worktreeName: string;
  worktreePath: string | null;
  branchName: string | null;
  prNumber: number | null;
  launchedAt: string;
  stoppedAt: string | null;
  lastEventAt: string | null;
  createdAt: string;
}

/** A pull request associated with a team */
export interface PullRequest {
  prNumber: number;
  teamId: number | null;
  state: string | null;
  mergeStatus: string | null;
  ciStatus: string | null;
  ciConclusion: string | null;
  ciFailCount: number;
  checksJson: string | null;
  autoMerge: boolean;
  lastPolledAt: string | null;
  updatedAt: string;
}

/** A hook event received from a Claude Code instance */
export interface Event {
  id: number;
  teamId: number;
  hookType: string;
  sessionId: string | null;
  toolName: string | null;
  agentType: string | null;
  payload: string | null;
  createdAt: string;
}

/** A command from the PM to a team */
export interface Command {
  id: number;
  teamId: number;
  message: string;
  sentAt: string;
  delivered: boolean;
}

/** A cost entry for tracking token usage and costs per session */
export interface CostEntry {
  id: number;
  teamId: number;
  sessionId: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  recordedAt: string;
}

/** A usage snapshot for tracking usage percentages */
export interface UsageSnapshot {
  id: number;
  teamId: number | null;
  projectId: number | null;
  sessionId: string | null;
  dailyPercent: number;
  weeklyPercent: number;
  sonnetPercent: number;
  extraPercent: number;
  rawOutput: string | null;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Cleanup (v2 — preview + selective confirm)
// ---------------------------------------------------------------------------

/** A single item that could be cleaned up */
export interface CleanupItem {
  type: 'worktree' | 'signal_file' | 'stale_branch';
  name: string;
  path: string;
  reason: string;
}

/** Preview of what would be cleaned (dry run) */
export interface CleanupPreview {
  projectId: number;
  projectName: string;
  items: CleanupItem[];
}

/** Result of executing a confirmed cleanup */
export interface CleanupResult {
  removed: string[];
  failed: { name: string; error: string }[];
}

/**
 * @deprecated Legacy cleanup result shape (pre-v2). Kept for migration reference.
 */
export interface LegacyCleanupResult {
  worktreesRemoved: string[];
  signalFilesRemoved: string[];
  staleDirsRemoved: string[];
  branchesPruned: string[];
  zombiesFixed: number;
  staleTeamsCleaned: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Dashboard View (v_team_dashboard)
// ---------------------------------------------------------------------------

/** Aggregated row from the v_team_dashboard view */
export interface TeamDashboardRow {
  id: number;
  issueNumber: number;
  issueTitle: string | null;
  projectId: number | null;
  projectName: string | null;
  status: TeamStatus;
  phase: TeamPhase;
  worktreeName: string;
  prNumber: number | null;
  launchedAt: string;
  lastEventAt: string | null;
  durationMin: number;
  idleMin: number | null;
  totalCost: number;
  sessionCount: number;
  prState: string | null;
  ciStatus: string | null;
  mergeStatus: string | null;
}

// ---------------------------------------------------------------------------
// Team Detail (full detail returned by GET /api/teams/:id)
// ---------------------------------------------------------------------------

/** Individual CI check result */
export interface CICheck {
  name: string;
  status: string;
  conclusion: string | null;
}

/** Full team detail returned by GET /api/teams/:id */
export interface TeamDetail {
  id: number;
  issueNumber: number;
  issueTitle: string | null;
  status: TeamStatus;
  phase: TeamPhase;
  pid: number | null;
  sessionId: string | null;
  worktreeName: string;
  worktreePath: string | null;
  branchName: string | null;
  prNumber: number | null;
  launchedAt: string;
  stoppedAt: string | null;
  lastEventAt: string | null;
  durationMin: number;
  idleMin: number | null;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  sessionCount: number;
  pr: {
    number: number;
    state: string | null;
    mergeStatus: string | null;
    ciStatus: string | null;
    ciConclusion: string | null;
    ciFailCount: number;
    checks: CICheck[];
    autoMerge: boolean;
  } | null;
  recentEvents: Event[];
  outputTail: string | null;
}
